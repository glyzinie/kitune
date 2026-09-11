import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

// Exercise the Docker runtime file set with production dependencies on the host.
// This checks application packaging, not the container image or Linux itself.
const directory = await mkdtemp(join(tmpdir(), "kitune-production-"));
const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = reservation.port!;
await reservation.stop(true);
const origin = `http://localhost:${port}`;
const databasePath = join(directory, "data/kitune.sqlite");
const env = { ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port), CONFIG_PATH: join(directory, "config.toml"), DATABASE_PATH: databasePath, BETTER_AUTH_SECRET: randomBytes(32).toString("hex") };
const request = (path: string) => fetch(`${origin}${path}`, { headers: { "fly-client-ip": "127.0.0.1" } });
let server: ReturnType<typeof Bun.spawn> | undefined;
let serverOutput: Promise<string[]> | undefined;
async function start() {
  server = Bun.spawn([process.execPath, "src/server.ts"], { cwd: directory, env, stdout: "pipe", stderr: "pipe" });
  serverOutput = Promise.all([new Response(server.stdout as ReadableStream).text(), new Response(server.stderr as ReadableStream).text()]);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && server.exitCode === null) {
    try { if ((await request("/healthz")).ok) return; } catch {}
    await Bun.sleep(100);
  }
  throw new Error("Production server did not become ready");
}
async function stop() {
  assert(server);
  server.kill("SIGTERM");
  const timeout = setTimeout(() => server?.kill("SIGKILL"), 5_000);
  try { assert.equal(await server.exited, 0, "Server did not exit cleanly on SIGTERM"); }
  finally { clearTimeout(timeout); }
  const [, stderr] = await serverOutput!;
  assert.equal(stderr, "", "Production server wrote unexpected errors");
  server = undefined;
}
try {
  for (const path of ["package.json", "bun.lock", "tsconfig.json", "src", "dist"]) {
    await cp(new URL(`../${path}`, import.meta.url), join(directory, path), { recursive: true });
  }
  const install = Bun.spawn([process.execPath, "install", "--production", "--frozen-lockfile"], { cwd: directory, env: { ...env, TMPDIR: tmpdir() }, stdout: "pipe", stderr: "pipe" });
  const [installCode, , installErrors] = await Promise.all([install.exited, new Response(install.stdout).text(), new Response(install.stderr).text()]);
  assert.equal(installCode, 0, installErrors);
  assert.equal(await Bun.file(join(directory, "node_modules/@playwright/test/package.json")).exists(), false);
  await writeFile(env.CONFIG_PATH, `origin = "${origin}"\n[[users]]\nid = "owner"\nname = "Owner"\nemail = "owner@example.com"\n`, { mode: 0o600 });
  await start();
  const page = await request("/login");
  assert.equal(page.status, 200);
  assert((await page.text()).includes("Passkeyでログイン"));
  assert.equal((await request("/assets/client.js")).status, 200);
  const before = await (await request("/api/auth/jwks")).json();
  assert(before.keys.length > 0);
  const enroll = Bun.spawn([process.execPath, "src/cli.ts", "enroll", "owner"], { cwd: directory, env, stdout: "pipe", stderr: "pipe" });
  const [enrollCode, enrollment, enrollErrors] = await Promise.all([enroll.exited, new Response(enroll.stdout).text(), new Response(enroll.stderr).text()]);
  assert.equal(enrollCode, 0, enrollErrors);
  assert(enrollment.startsWith(`${origin}/enroll#`));
  await stop();
  const db = new Database(databasePath, { readonly: true });
  try { assert.deepEqual(db.query("PRAGMA integrity_check").get(), { integrity_check: "ok" }); } finally { db.close(); }
  await start();
  assert.deepEqual(await (await request("/api/auth/jwks")).json(), before);
  await stop();
  console.log("Production runtime passed: production dependencies, SSR/assets, CLI, SIGTERM, SQLite integrity and signing keys after process restart");
} finally {
  if (server) { server.kill("SIGKILL"); await server.exited; }
  await rm(directory, { recursive: true, force: true });
}
