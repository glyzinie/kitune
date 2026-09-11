import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createLocalJWKSet, jwtVerify } from "jose";
import { Agent, Authenticator } from "./helpers";

// This is an explicit live test, never part of `bun test`.
// Provision a disposable deploy-test-* user and client before running it.
const settingsPath = process.env.FLY_TEST_SETTINGS;
assert(settingsPath, "Set FLY_TEST_SETTINGS to a private JSON file with test settings");
const settings = await Bun.file(settingsPath).json() as {
  kituneOrigin: string; dexOrigin: string; kituneApp: string; dexApp: string;
  smokeUser: string; smoke: string;
};
assert(/^deploy-test-[a-z0-9]+$/.test(settings.smokeUser), "Only a disposable deployment test user may be enrolled/revoked");
for (const app of [settings.kituneApp, settings.dexApp]) assert(/^[a-z0-9-]+$/.test(app));
for (const origin of [settings.kituneOrigin, settings.dexOrigin]) assert.equal(new URL(origin).protocol, "https:");
const callback = "http://127.0.0.1:9876/callback";
const client = "deployment-smoke";
const lifecycle = process.env.FLY_TEST_LIFECYCLE ?? "stop";
assert(["stop", "suspend"].includes(lifecycle), "FLY_TEST_LIFECYCLE must be stop or suspend");
const report: Record<string, unknown> = { testedAt: new Date().toISOString(), lifecycle };
const jars = new Map<string, Agent>();
for (const origin of [settings.kituneOrigin, settings.dexOrigin]) jars.set(origin, new Agent(
  request => fetch(request, { redirect: "manual", signal: AbortSignal.timeout(55_000) }), origin,
));
const kitune = jars.get(settings.kituneOrigin)!;
const dex = jars.get(settings.dexOrigin)!;
const json = async (url: string) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(55_000) });
  assert.equal(response.status, 200, `${new URL(url).pathname} status`);
  return response.json();
};
async function fly(...args: string[]) {
  const child = Bun.spawn(["fly", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  // SSH output can contain an enrollment URL: never include it in error logs.
  assert.equal(code, 0, `fly ${args[0]} ${args[1]} failed`);
  return stdout.trim();
}
async function machine(app: string) {
  const machines = JSON.parse(await fly("machine", "list", "-a", app, "--json"));
  assert.equal(machines.length, 1, `${app} must have one Machine`);
  return machines[0].id as string;
}
const kituneMachine = await machine(settings.kituneApp);
const dexMachine = await machine(settings.dexApp);
const cli = (...args: string[]) => fly("ssh", "console", "-a", settings.kituneApp, "--machine", kituneMachine,
  "-C", `gosu bun bun /app/src/cli.ts ${args.join(" ")}`);
async function pause(app: string, id: string) {
  if (lifecycle === "suspend") await fly("machine", "suspend", id, "-a", app, "--wait-timeout", "45s");
  else await fly("machine", "stop", id, "-a", app, "--signal", "SIGTERM", "--timeout", "20", "--wait-timeout", "45s");
  const state = JSON.parse(await fly("machine", "list", "-a", app, "--json"));
  assert.equal(state.find((m: { id: string }) => m.id === id)?.state, lifecycle === "suspend" ? "suspended" : "stopped");
}
async function cold(app: string, id: string, url: string) {
  await pause(app, id);
  const start = performance.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(55_000) });
  assert.equal(response.status, 200, "Cold request failed");
  await response.arrayBuffer();
  return Math.round(performance.now() - start);
}
const dexToken = (body: Record<string, string>) => dex.request("/token", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${client}:${settings.smoke}`).toString("base64")}` },
  body: new URLSearchParams(body),
});

let enrolled = false;
try {
  const kituneDiscovery = await json(`${settings.kituneOrigin}/api/auth/.well-known/openid-configuration`);
  const dexDiscovery = await json(`${settings.dexOrigin}/.well-known/openid-configuration`);
  assert.equal(kituneDiscovery.issuer, `${settings.kituneOrigin}/api/auth`);
  assert.equal(dexDiscovery.issuer, settings.dexOrigin);
  assert.equal((await kitune.get("/login")).status, 200);
  assert.equal((await kitune.get("/assets/client.js")).status, 200);
  const kituneKeys = await json(kituneDiscovery.jwks_uri);
  const dexKeys = await json(dexDiscovery.jwks_uri);
  console.log("Live TLS, Discovery, JWKS and UI assets passed");

  const output = await cli("enroll", settings.smokeUser);
  const enrollment = new URL(output.split(/\s+/).find(value => value.startsWith(`${settings.kituneOrigin}/enroll#`))!);
  assert.equal((await kitune.post("/enrollment", { token: enrollment.hash.slice(1) })).status, 200);
  assert.equal(await (await kitune.get("/api/auth/get-session")).json(), null);
  const options = await (await kitune.get("/api/auth/passkey/generate-register-options")).json();
  const key = new Authenticator("bada5566-a7aa-401f-bd96-45619a55120d");
  const withoutUV = await kitune.post("/api/auth/passkey/verify-registration", { response: key.registration(options, settings.kituneOrigin, false), createSession: true });
  assert(withoutUV.status >= 400, "Registration without UV must fail");
  const retryOptions = await (await kitune.get("/api/auth/passkey/generate-register-options")).json();
  const registration = await kitune.post("/api/auth/passkey/verify-registration", { response: key.registration(retryOptions, settings.kituneOrigin), createSession: true });
  assert.equal(registration.status, 200, "Live Passkey registration");
  enrolled = true;
  assert.equal((await registration.json()).name, "1Password");
  await kitune.post("/api/auth/sign-out", {});
  const loginOptions = await (await kitune.get("/api/auth/passkey/generate-authenticate-options")).json();
  assert.equal((await kitune.post("/api/auth/passkey/verify-authentication", { response: key.assertion(loginOptions, settings.kituneOrigin) })).status, 200);
  console.log("Live Passkey enrollment, UV rejection, automatic name and login passed");

  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(20).toString("hex"), nonce = randomBytes(20).toString("hex");
  const params = new URLSearchParams({ client_id: client, redirect_uri: callback, response_type: "code", scope: "openid profile email groups offline_access federated:id",
    state, nonce, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") });
  let target = `${settings.dexOrigin}/auth?${params}`;
  let kituneConsent = false, dexConsent = false;
  for (let hop = 0; hop < 20 && !target.startsWith(callback); hop++) {
    const url = new URL(target);
    const jar = jars.get(url.origin);
    assert(jar, "Unexpected redirect origin");
    let response = await jar.get(target);
    if (response.status === 200 && url.origin === settings.kituneOrigin && url.pathname === "/consent") {
      kituneConsent = true;
      const consent = await kitune.post("/api/auth/oauth2/consent", { accept: true, oauth_query: url.search.slice(1) });
      assert.equal(consent.status, 200);
      const result = await consent.json();
      target = new URL(result.redirect_uri ?? result.url, target).href;
      continue;
    }
    if (response.status === 200 && url.origin === settings.dexOrigin && url.pathname === "/approval") {
      dexConsent = true;
      const html = await response.text();
      const req = html.match(/name="req" value="([^"]+)"/)?.[1];
      assert(req, "Dex approval form missing");
      response = await dex.request(target, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ req, approval: "approve" }) });
    }
    assert(response.status >= 300 && response.status < 400, `Flow status ${response.status} at ${url.origin}${url.pathname}`);
    assert(response.headers.get("location"));
    target = new URL(response.headers.get("location")!, target).href;
  }
  const result = new URL(target);
  assert.equal(`${result.origin}${result.pathname}`, callback);
  assert.equal(result.searchParams.get("state"), state);
  assert(kituneConsent && dexConsent, "Both consent screens must be exercised");
  const code = result.searchParams.get("code");
  assert(code, "Authorization code missing");
  const exchange = await dexToken({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: callback });
  assert.equal(exchange.status, 200, "Dex authorization code exchange");
  let tokens = await exchange.json();
  const verify = (jwt: string) => jwtVerify(jwt, createLocalJWKSet(dexKeys), { issuer: settings.dexOrigin, audience: client });
  const { payload } = await verify(tokens.id_token);
  assert.equal(payload.nonce, nonce);
  assert.equal(payload.exp! - payload.iat!, 900);
  assert.deepEqual(payload.groups, ["kitune:deployment-test"]);
  assert.deepEqual(payload.federated_claims, { connector_id: "kitune", user_id: settings.smokeUser });
  const info = await dex.request("/userinfo", { headers: { authorization: `Bearer ${tokens.access_token}` } });
  assert.equal(info.status, 200);
  assert.equal((await info.json()).sub, payload.sub);
  assert((await dexToken({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: callback })).status >= 400);
  console.log("Kitune -> personal Dex login, consent, S256, JWT signatures, groups, UserInfo and code replay rejection passed");

  const kituneCold: number[] = [], dexCold: number[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    kituneCold.push(await cold(settings.kituneApp, kituneMachine, `${settings.kituneOrigin}/healthz`));
    dexCold.push(await cold(settings.dexApp, dexMachine, `${settings.dexOrigin}/.well-known/openid-configuration`));
    console.log(`${lifecycle} recovery ${attempt + 1}: Kitune ${kituneCold.at(-1)}ms; Dex ${dexCold.at(-1)}ms`);
  }
  report.kituneColdMs = kituneCold;
  report.dexColdMs = dexCold;
  assert.deepEqual(await json(kituneDiscovery.jwks_uri), kituneKeys);
  assert.deepEqual(await json(dexDiscovery.jwks_uri), dexKeys);
  assert.equal((await (await kitune.get("/api/auth/get-session")).json()).user.id, settings.smokeUser);
  await pause(settings.dexApp, dexMachine);
  await pause(settings.kituneApp, kituneMachine);
  const refreshStarted = performance.now();
  const refresh = await dexToken({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  assert.equal(refresh.status, 200, "Refresh must wake up both Dex and Kitune");
  tokens = await refresh.json();
  report.chainRefreshColdMs = Math.round(performance.now() - refreshStarted);
  assert.equal((await verify(tokens.id_token)).payload.sub, payload.sub);
  console.log(`Refresh woke up both services in ${report.chainRefreshColdMs}ms; subject and signing keys survived restart`);

  await cli("revoke", settings.smokeUser);
  assert.equal(await (await kitune.get("/api/auth/get-session")).json(), null);
  assert((await dexToken({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status >= 400, "Revoked upstream identity must not refresh through Dex");
  report.passed = true;
  console.log("Live revocation propagated to Dex refresh");
} finally {
  if (enrolled) await cli("recover", settings.smokeUser); // Remove the test key and grants; discard the replacement URL.
  await mkdir("test-results", { recursive: true });
  await writeFile(`test-results/fly-${lifecycle}.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
}
