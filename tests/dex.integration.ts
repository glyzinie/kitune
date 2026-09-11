import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, jwtVerify } from "jose";
import { createRuntime } from "../src/auth";
import { createApp } from "../src/app";
import { Agent, clientSecret, enroll, fixtureSettings } from "./helpers";

const directory = await mkdtemp(join(tmpdir(), "kitune-dex-test-"));
let app: ReturnType<typeof createApp> | undefined;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (r) => app ? app.fetch(r) : new Response("Starting", { status: 503 }) });
const authOrigin = `http://localhost:${server.port}`;
const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const dexPort = reservation.port;
await reservation.stop(true);
const dexOrigin = `http://127.0.0.1:${dexPort}`;
const issuer = `${dexOrigin}/dex`;
const personalReservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const personalPort = personalReservation.port;
await personalReservation.stop(true);
const personalIssuer = `http://127.0.0.1:${personalPort}/personal`;
const dexClientSecret = randomBytes(32).toString("hex");
const downstreamSecret = randomBytes(32).toString("hex");
const settings = fixtureSettings({ origin: authOrigin, clients: [{ id: "test-client", name: "Personal Dex", redirect_uris: [`${personalIssuer}/callback`], secret_env: "TEST_CLIENT_SECRET", skip_consent: true }] }, join(directory, "idp.sqlite"));
// Preserve an unverified email attribute rather than asserting verification at the broker.
settings.config.users[0]!.email_verified = false;
let runtime = await createRuntime(settings, { testing: true });
app = createApp(runtime);
const agent = new Agent((request) => fetch(request, { redirect: "manual" }), authOrigin);
await enroll(runtime, agent);
const personalConfig = {
  issuer: personalIssuer,
  storage: { type: "sqlite3", config: { file: join(directory, "personal-dex.sqlite") } },
  web: { http: `127.0.0.1:${personalPort}` },
  oauth2: { skipApprovalScreen: true, responseTypes: ["code"] },
  staticClients: [{ id: "family-dex", name: "Family Dex", secretEnv: "FAMILY_DEX_CLIENT_SECRET", redirectURIs: [`${issuer}/callback`] }],
  connectors: [{ type: "oidc", id: "kitune", name: "Kitune", config: {
    issuer: `${authOrigin}/api/auth`, clientID: "test-client", clientSecret,
    redirectURI: `${personalIssuer}/callback`, scopes: ["profile", "email", "groups", "offline_access"],
    getUserInfo: true, insecureEnableGroups: true, pkceChallenge: "S256",
    claimModifications: { modifyGroupNames: { prefix: "kitune:" } },
  } }],
};
const dexConfig = {
  issuer,
  storage: { type: "sqlite3", config: { file: join(directory, "dex.sqlite") } },
  web: { http: `127.0.0.1:${dexPort}` },
  oauth2: { skipApprovalScreen: true, responseTypes: ["code"] },
  staticClients: [{ id: "family-service", name: "Family service", secret: dexClientSecret, redirectURIs: ["http://localhost:9000/callback"] }],
  connectors: [{ type: "oidc", id: "owner", name: "Personal Dex", config: {
    issuer: personalIssuer, clientID: "family-dex", clientSecret: downstreamSecret,
    redirectURI: `${issuer}/callback`, scopes: ["profile", "email", "groups", "offline_access"],
    getUserInfo: true, insecureEnableGroups: true, pkceChallenge: "S256",
    claimModifications: { modifyGroupNames: { prefix: "owner:" } },
  } }],
};
const configFile = join(directory, "dex.json");
await writeFile(configFile, JSON.stringify(dexConfig), { mode: 0o600 });
const personalConfigFile = join(directory, "personal-dex.json");
await writeFile(personalConfigFile, JSON.stringify(personalConfig), { mode: 0o600 });
const personalDex = Bun.spawn([process.env.DEX_BIN ?? "dex", "serve", personalConfigFile], { env: { ...process.env, FAMILY_DEX_CLIENT_SECRET: downstreamSecret }, stdout: "pipe", stderr: "pipe" });
const personalLogs = Promise.all([new Response(personalDex.stdout).text(), new Response(personalDex.stderr).text()]);
let dex: ReturnType<typeof Bun.spawn> | undefined;
let logs: Promise<string[]> | undefined;
async function ready(url: string, process: ReturnType<typeof Bun.spawn>) {
  const deadline = Date.now() + 30_000;
  while (true) {
    try { if ((await fetch(`${url}/.well-known/openid-configuration`)).ok) break; } catch {}
    if (Date.now() > deadline || process.exitCode !== null) throw new Error("Dex did not become ready");
    await Bun.sleep(100);
  }
}
let success = false;
try {
  await ready(personalIssuer, personalDex);
  dex = Bun.spawn([process.env.DEX_BIN ?? "dex", "serve", configFile], { stdout: "pipe", stderr: "pipe" });
  logs = Promise.all([new Response(dex.stdout as ReadableStream).text(), new Response(dex.stderr as ReadableStream).text()]);
  await ready(issuer, dex);
  const verifier = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({ client_id: "family-service", redirect_uri: "http://localhost:9000/callback", response_type: "code", scope: "openid profile email groups offline_access federated:id", state: "family-state", nonce: "family-nonce", code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") });
  let target = `${issuer}/auth?${params}`;
  for (let hops = 0; hops < 16 && !target.startsWith("http://localhost:9000/callback"); hops++) {
    const response = await agent.get(target);
    if (response.status === 200 && new URL(target).pathname === "/consent") {
      const consent = await agent.post(`${authOrigin}/api/auth/oauth2/consent`, { accept: true, oauth_query: new URL(target).search.slice(1) });
      assert.equal(consent.status, 200, "Upstream consent failed");
      const result = await consent.json();
      target = new URL(result.redirect_uri ?? result.url, target).href;
      continue;
    }
    assert(response.status >= 300 && response.status < 400, `Expected redirect, received ${response.status} at ${new URL(target).pathname}`);
    assert(response.headers.get("location"), "Missing redirect");
    target = new URL(response.headers.get("location")!, target).href;
  }
  const callback = new URL(target);
  assert.equal(callback.origin, "http://localhost:9000");
  assert.equal(callback.searchParams.get("state"), "family-state");
  assert(callback.searchParams.get("code"), "Dex authorization failed");
  const dexToken = async (body: Record<string, string>) => fetch(`${issuer}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`family-service:${dexClientSecret}`).toString("base64")}` }, body: new URLSearchParams(body),
  });
  const response = await dexToken({ grant_type: "authorization_code", code: callback.searchParams.get("code")!, code_verifier: verifier, redirect_uri: "http://localhost:9000/callback" });
  assert.equal(response.status, 200, "Dex code exchange failed");
  const tokens = await response.json();
  const keys = createLocalJWKSet(await (await fetch(`${issuer}/keys`)).json());
  const { payload } = await jwtVerify(tokens.id_token, keys, { issuer, audience: "family-service" });
  assert.equal(payload.nonce, "family-nonce");
  const federated = payload.federated_claims as { connector_id: string; user_id: string };
  assert.equal(federated.connector_id, "owner");
  assert(federated.user_id && federated.user_id !== "owner", "Personal Dex must issue its own stable subject");
  assert.deepEqual(payload.groups, ["owner:kitune:personal", "owner:kitune:reader"]);
  assert.equal(payload.email_verified, false);
  const before = await (await fetch(`${authOrigin}/api/auth/jwks`)).json();
  runtime.close();
  runtime = await createRuntime(settings, { testing: true });
  app = createApp(runtime);
  assert.deepEqual(await (await fetch(`${authOrigin}/api/auth/jwks`)).json(), before);
  const refreshed = await dexToken({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  assert.equal(refreshed.status, 200, "Dex refresh after IdP restart failed");
  const rotated = await refreshed.json();
  const refreshedClaims = await jwtVerify(rotated.id_token, keys, { issuer, audience: "family-service" });
  assert.equal(refreshedClaims.payload.sub, payload.sub);
  assert.deepEqual(refreshedClaims.payload.groups, payload.groups);
  settings.config.users[0]!.enabled = false;
  runtime.store.reconcile(settings);
  assert((await dexToken({ grant_type: "refresh_token", refresh_token: rotated.refresh_token })).status >= 400, "Disabled upstream identity could still refresh through Dex");
  success = true;
  console.log("Dex integration passed through Kitune -> personal Dex -> family Dex: login, PKCE, signatures, namespaced groups, restart, refresh and revocation");
} finally {
  if (dex) { dex.kill("SIGTERM"); await dex.exited; }
  personalDex.kill("SIGTERM");
  await personalDex.exited;
  if (!success) console.error([...(await personalLogs), ...(logs ? await logs : [])].join("\n"));
  await server.stop(true);
  runtime.close();
  await rm(directory, { recursive: true, force: true });
}
