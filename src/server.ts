import { loadSettings } from "./config";
import { createRuntime } from "./auth";
import { createApp } from "./app";

process.umask(0o077);
const settings = await loadSettings();
const runtime = await createRuntime(settings);
const app = createApp(runtime);
const server = Bun.serve({ hostname: process.env.HOST ?? "0.0.0.0", port: Number(process.env.PORT ?? 3000), fetch: app.fetch });
console.log(`Kitune listening on port ${server.port}`);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => { void server.stop(true); }, 15_000);
  timeout.unref();
  await server.stop(false);
  clearTimeout(timeout);
  runtime.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
