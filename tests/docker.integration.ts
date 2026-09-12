import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, jwtVerify } from "jose";
import { Agent, Authenticator, clientSecret, fixtureConfig, grant, token } from "./helpers";

const directory = await mkdtemp(join(tmpdir(), "kitune-docker-"));
const prefix = `kitune-test-${randomBytes(6).toString("hex")}`;
const image = process.env.DOCKER_TEST_IMAGE ?? `${prefix}:test`;
const daemonArch = await docker(["info", "--format", "{{.Architecture}}"]);
const platform = process.env.DOCKER_TEST_PLATFORM ?? `linux/${daemonArch === "aarch64" ? "arm64" : daemonArch === "x86_64" ? "amd64" : daemonArch}`;
const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = reservation.port!;
await reservation.stop(true);
const origin = `http://localhost:${port}`;
const containers: string[] = [], volumes: string[] = [];

async function command(program: string, args: string[]) {
  const child = Bun.spawn([program, ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  assert.equal(code, 0, `${program} ${args[0]} failed: ${stderr || stdout}`);
  return stdout.trim();
}
function docker(args: string[]) { return command("docker", args); }
const cli = (container: string, ...args: string[]) => docker(["exec", container, "gosu", "bun", "bun", "src/cli.ts", ...args]);
const agent = new Agent((request) => {
  request.headers.set("fly-client-ip", "127.0.0.1");
  return fetch(request, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
}, origin);
async function createContainer(suffix: string, restore = false) {
  const volume = `${prefix}-${suffix}-data`, container = `${prefix}-${suffix}`;
  await docker(["volume", "create", "--label", "kitune.test=true", volume]); volumes.push(volume);
  await docker(["create", "--name", container, "--label", "kitune.test=true", "--platform", platform,
    "--memory", "256m", "--memory-swap", "256m", "--cpus", "1", "--env-file", join(directory, "env"),
    "--mount", `type=volume,source=${volume},target=/data`, "--publish", `127.0.0.1:${port}:3000`, image,
    ...(restore ? ["sh", "-c", "bun src/cli.ts revoke-all && exec bun src/server.ts"] : []),
  ]); containers.push(container);
  await docker(["cp", join(directory, "config.toml"), `${container}:/app/config.toml`]);
  return container;
}
async function start(container: string) {
  await docker(["start", container]);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await agent.get("/healthz")).ok) return; } catch {}
    const running = await docker(["inspect", "--format", "{{.State.Running}}", container]);
    if (running !== "true") break;
    await Bun.sleep(250);
  }
  throw new Error(`Container did not become ready: ${await docker(["logs", container])}`);
}
async function stop(container: string) {
  await docker(["stop", "--time", "20", container]);
  const state = JSON.parse(await docker(["inspect", "--format", "{{json .State}}", container]));
  assert.equal(state.ExitCode, 0, "Container must handle SIGTERM without being killed");
  assert.equal(state.OOMKilled, false);
}
async function login(key: Authenticator) {
  const options = await (await agent.get("/api/auth/passkey/generate-authenticate-options")).json();
  assert.equal((await agent.post("/api/auth/passkey/verify-authentication", { response: key.assertion(options, origin) })).status, 200);
}

try {
  if (!process.env.DOCKER_TEST_IMAGE) {
    console.log(`Building Docker image for ${platform}`);
    const buildArgs = ["build", "--platform", platform, "--tag", image];
    if (process.env.DOCKER_TEST_BUILDX) await command(process.env.DOCKER_TEST_BUILDX, [...buildArgs, "--load", "."]);
    else await docker([...buildArgs, "."]);
  }
  const config = fixtureConfig({ origin, users: [{ id: "owner", name: "Owner", email: "owner@example.com", groups: ["personal"] }] });
  await writeFile(join(directory, "config.toml"), Bun.TOML.stringify(config)!, { mode: 0o600 });
  await writeFile(join(directory, "env"), `BETTER_AUTH_SECRET=${randomBytes(32).toString("hex")}\nTEST_CLIENT_SECRET=${clientSecret}\n`, { mode: 0o600 });
  const container = await createContainer("source");
  await start(container);
  assert.equal((await agent.get("/login")).status, 200);
  assert.equal((await agent.get("/assets/client.js")).status, 200);
  const permissions = JSON.parse(await docker(["exec", container, "bun", "-e", `
    import { statSync } from "node:fs";
    const uid = Number((await Bun.file("/proc/1/status").text()).match(/^Uid:\\s+(\\d+)/m)[1]);
    console.log(JSON.stringify({ uid, databaseUid: statSync("/data/kitune.sqlite").uid, databaseMode: statSync("/data/kitune.sqlite").mode & 511, configMode: statSync("/app/config.toml").mode & 511 }));
  `]));
  assert.notEqual(permissions.uid, 0, "Server must run as a non-root user");
  assert.equal(permissions.databaseUid, permissions.uid);
  assert.equal(permissions.databaseMode, 0o600);
  assert.equal(permissions.configMode, 0o640);

  // The Bun test runner needs no dev dependencies for these API tests.
  await mkdir(join(directory, "tests"));
  for (const file of ["auth.test.ts", "helpers.ts"]) await cp(new URL(file, import.meta.url), join(directory, "tests", file));
  await docker(["cp", join(directory, "tests"), `${container}:/app/tests`]);
  await docker(["exec", container, "gosu", "bun", "bun", "test", "tests/auth.test.ts"]);
  console.log("Container API test suite passed");

  const enrollment = new URL(await cli(container, "enroll", "owner"));
  assert.equal((await agent.post("/enrollment", { token: enrollment.hash.slice(1) })).status, 200);
  const options = await (await agent.get("/api/auth/passkey/generate-register-options")).json();
  const key = new Authenticator("bada5566-a7aa-401f-bd96-45619a55120d");
  const registered = await agent.post("/api/auth/passkey/verify-registration", { response: key.registration(options, origin), createSession: true });
  assert.equal(registered.status, 200);
  const tokens = await grant(agent);
  // Several services may request tokens together after an idle period.
  await Promise.all(Array.from({ length: 4 }, () => grant(agent)));
  const jwks = await (await agent.get("/api/auth/jwks")).json();
  const verify = (idToken: string) => jwtVerify(idToken, createLocalJWKSet(jwks), { issuer: `${origin}/api/auth`, audience: "test-client" });
  assert.equal((await verify(tokens.id_token)).payload.sub, "owner");
  assert.deepEqual((await verify(tokens.id_token)).payload.groups, ["personal"]);
  await stop(container);
  await start(container);
  assert.deepEqual(await (await agent.get("/api/auth/jwks")).json(), jwks);
  assert.equal((await (await agent.get("/api/auth/get-session")).json()).user.id, "owner");
  const refresh = await token(agent, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  assert.equal(refresh.status, 200);
  const rotated = await refresh.json();
  assert.equal((await verify(rotated.id_token)).payload.sub, "owner");
  await cli(container, "backup", "/data/backups/backup.sqlite");
  await docker(["cp", `${container}:/data/backups/backup.sqlite`, join(directory, "backup.sqlite")]);
  await stop(container);

  const restored = await createContainer("restored", true);
  await docker(["cp", join(directory, "backup.sqlite"), `${restored}:/data/kitune.sqlite`]);
  await start(restored);
  assert.equal(await (await agent.get("/api/auth/get-session")).json(), null);
  assert.equal((await token(agent, { grant_type: "refresh_token", refresh_token: rotated.refresh_token })).status, 400);
  assert.equal((await agent.request("/api/auth/oauth2/userinfo", { headers: { authorization: `Bearer ${rotated.access_token}` } })).status, 401);
  assert.deepEqual(await (await agent.get("/api/auth/jwks")).json(), jwks);
  await login(key);
  assert.equal((await verify((await grant(agent)).id_token)).payload.sub, "owner");
  const integrity = await docker(["exec", restored, "gosu", "bun", "bun", "-e", 'import { Database } from "bun:sqlite"; const db = new Database("/data/kitune.sqlite", { readonly: true }); console.log(db.query("PRAGMA integrity_check").get().integrity_check); db.close();']);
  assert.equal(integrity, "ok");
  await stop(restored);
  console.log(`Docker integration passed (${platform}, 1 CPU / 256MB, no swap): API suite, non-root, concurrent OIDC, Passkey/OIDC, SIGTERM, Volume restart, backup restore, revocation and stable subject/JWKS`);
} finally {
  for (const container of containers.reverse()) await docker(["rm", "--force", container]);
  for (const volume of volumes.reverse()) await docker(["volume", "rm", volume]);
  if (!process.env.DOCKER_TEST_IMAGE) await docker(["image", "rm", image]).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
