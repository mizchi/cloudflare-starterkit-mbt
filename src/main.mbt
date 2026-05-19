// Minimal Cloudflare Worker fetch handler in MoonBit.
//
// The generated JS calls `globalThis.__appServerFetch(request, env, ctx)`
// from `dist/worker.mjs` (see scripts/prepare-worker.ts). This file
// registers that global at module-init time. Add more routes via
// `@mars.Server::<method>(...)` in `build_app()`.

///|
async fn handle_health(ctx : @mars.Context) -> Unit raise Error {
  ctx.json(
    Json::object({
      "ok": Json::boolean(true),
      "service": Json::string("cf-mbt-app"),
    }),
  )
}

///|
async fn handle_root(ctx : @mars.Context) -> Unit raise Error {
  ctx.text("cf-mbt-app is alive\n")
}

///|
fn build_app() -> @mars.Server {
  let app = @mars.Server::new()
  app.get("/", @mars.handler(handle_root))
  app.get("/health", @mars.handler(handle_health))
  app
}

///|
extern "js" fn register_cloudflare_fetch(handler : @mars.AppHandler) -> Unit =
  #| (handler) => {
  #|   globalThis.__appServerFetch = async (request, env, ctx) => {
  #|     globalThis.__appServerEnv = env ?? {};
  #|     globalThis.__appServerCtx = ctx;
  #|     return handler(request);
  #|   };
  #| }

///|
fn main {
  register_cloudflare_fetch(build_app().to_handler())
}
