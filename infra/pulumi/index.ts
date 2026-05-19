// Pulumi stack for Cloudflare resources used by the starter kit.
// One stack per environment (production / staging). The stack config
// (Pulumi.<stack>.yaml) decides what gets provisioned and how the
// Access app is locked down.
//
// Provisions:
//   - D1 database (one per env, namespaced by suffix)
//   - R2 bucket  (one per env)
//   - Cloudflare Access self-hosted application + policies
//   - (optional) service token for headless CLI / CI access
//
// Vectorize: the Pulumi cloudflare provider (v6.x) does not ship a
// VectorizeIndex resource yet. The stack outputs the equivalent
// `wrangler vectorize create` command so creation stays a single
// copy-paste step.
//
// After `pulumi up`, paste:
//   - D1 ID into wrangler.jsonc (top-level or env.staging.d1_databases[0].database_id)
//   - Access AUD + team domain into .env.cloudflare
//   - Service token client id / secret into .env.cloudflare
// See ../../docs/cd-overview.md.

import * as pulumi from "@pulumi/pulumi";
import * as cloudflare from "@pulumi/cloudflare";

const config = new pulumi.Config();

const accountId = config.require("cloudflareAccountId");
const environment = config.get("environment") ?? "production";
const isStaging = environment === "staging";
const resourceSuffix = isStaging ? "-staging" : "";

const provisionResources = config.getBoolean("provisionResources") ?? isStaging;
const vectorizeDimensions = config.getNumber("vectorizeDimensions") ?? 768;
const vectorizeMetric = config.get("vectorizeMetric") ?? "cosine";

// Access: staging is typically locked down across all paths (so the
// URL doesn't accidentally leak the test env); production usually
// gates only the API surface (`/v1/*`) so anonymous browser routes
// stay public.
const accessDomain = config.require("accessDomain"); // e.g. cf-mbt-app.YOUR-SUBDOMAIN.workers.dev/v1/*
const appName = config.get("appName") ??
  (isStaging ? "cf-mbt-app staging (allowlist)" : "cf-mbt-app /v1 API");
const sessionDuration = config.get("sessionDuration") ?? "24h";
const allowedEmails = config.requireObject<string[]>("allowedEmails");
const createServiceToken = config.getBoolean("createServiceToken") ?? true;
const serviceTokenName = config.get("serviceTokenName") ??
  (isStaging ? "cf-mbt-app-staging CLI" : "cf-mbt-app CLI");
const serviceTokenDuration = config.get("serviceTokenDuration") ?? "8760h";
const serviceTokenIds = config.getObject<string[]>("serviceTokenIds") ?? [];

if (
  allowedEmails.length === 0 &&
  serviceTokenIds.length === 0 &&
  !createServiceToken
) {
  throw new Error(
    "Set at least one allowedEmails entry or serviceTokenIds entry, or enable createServiceToken",
  );
}

const serviceToken = createServiceToken
  ? new cloudflare.ZeroTrustAccessServiceToken("app-cli-service-token", {
      accountId,
      name: serviceTokenName,
      duration: serviceTokenDuration,
    })
  : undefined;

const emailIncludes = allowedEmails.map((email) => ({ email: { email } }));
const serviceTokenIncludes = [
  ...serviceTokenIds.map((tokenId) => ({ serviceToken: { tokenId } })),
  ...(serviceToken === undefined
    ? []
    : [{ serviceToken: { tokenId: serviceToken.id } }]),
];

const policies = [
  ...(emailIncludes.length === 0
    ? []
    : [
        {
          name: `${appName} allow listed emails`,
          decision: "allow",
          precedence: 1,
          includes: emailIncludes,
        },
      ]),
  ...(serviceTokenIncludes.length === 0
    ? []
    : [
        {
          name: `${appName} service auth`,
          decision: "non_identity",
          precedence: 2,
          includes: serviceTokenIncludes,
        },
      ]),
];

const organization = cloudflare.getZeroTrustOrganizationOutput({ accountId });

const application = new cloudflare.ZeroTrustAccessApplication("app-access", {
  accountId,
  name: appName,
  type: "self_hosted",
  domain: accessDomain,
  destinations: [{ type: "public", uri: accessDomain }],
  appLauncherVisible: false,
  sessionDuration,
  pathCookieAttribute: true,
  httpOnlyCookieAttribute: true,
  optionsPreflightBypass: true,
  policies,
});

export const accessTeamDomain = pulumi.interpolate`https://${organization.authDomain}`;
export const accessAud = application.aud;
export const accessApplicationId = application.id;
export const accessDomainOut = application.domain;
export const accessClientId = serviceToken?.clientId;
export const accessClientSecret = pulumi.secret(serviceToken?.clientSecret);

// --- D1 / R2 ---
//
// Provisioned only when provisionResources is true. Production usually
// flips this off until you have explicitly imported existing resources
// to avoid Pulumi creating duplicates next to ones you made manually.

const appDb = provisionResources
  ? new cloudflare.D1Database("app-db", {
      accountId,
      name: `cf-mbt-app${resourceSuffix}`,
    })
  : undefined;

const assetsBucket = provisionResources
  ? new cloudflare.R2Bucket("app-assets-bucket", {
      accountId,
      name: `cf-mbt-app-assets${resourceSuffix}`,
    })
  : undefined;

const vectorizeName = `cf-mbt-app-vectors${resourceSuffix}`;
const vectorizeCreateCommand =
  `pnpm exec wrangler vectorize create ${vectorizeName} ` +
  `--dimensions=${vectorizeDimensions} --metric=${vectorizeMetric}`;

// Stack outputs — paste the IDs into wrangler.jsonc and the Access
// values into .env.cloudflare.
export const environmentOut = environment;
export const appDbId = appDb?.id;
export const appDbName = appDb?.name;
export const assetsBucketName = assetsBucket?.name;
export const vectorizeIndexName = provisionResources ? vectorizeName : undefined;
export const vectorizeCreateCommandOut = provisionResources
  ? vectorizeCreateCommand
  : undefined;
