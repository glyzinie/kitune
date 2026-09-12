import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createLocalJWKSet, jwtVerify } from "jose";
import { type CredentialMutations, withCredentialCleanup } from "./credential-cleanup";
import { Agent, Authenticator } from "./helpers";

// This is an explicit live test, never part of `bun test`.
// Provision a disposable deploy-test-* user and client before running it.
const settingsPath = process.env.FLY_TEST_SETTINGS;
assert(settingsPath, "Set FLY_TEST_SETTINGS to a private JSON file with test settings");
const settings = await Bun.file(settingsPath).json() as {
  kituneOrigin: string; kituneApp: string; smokeUser: string; smoke: string;
};
assert(/^deploy-test-[a-z0-9]+$/.test(settings.smokeUser), "Only a disposable deployment test user may be enrolled/revoked");
assert(/^[a-z0-9-]+$/.test(settings.kituneApp));
assert.equal(new URL(settings.kituneOrigin).protocol, "https:");
const callback = "http://127.0.0.1:9876/callback";
const client = "deployment-smoke";
const lifecycle = process.env.FLY_TEST_LIFECYCLE ?? "stop";
assert(["stop", "suspend"].includes(lifecycle), "FLY_TEST_LIFECYCLE must be stop or suspend");
const report: Record<string, unknown> = { testedAt: new Date().toISOString(), lifecycle };
const kitune = new Agent(
  request => fetch(request, { redirect: "manual", signal: AbortSignal.timeout(55_000) }), settings.kituneOrigin,
);
const json = async (url: string) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(55_000) });
  assert.equal(response.status, 200, `${new URL(url).pathname} status`);
  return response.json();
};
async function fly(...args: string[]) {
  const child = Bun.spawn(["fly", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  // SSH output can contain an enrollment URL: never include it in error logs.
  if (code !== 0 && args[0] === "machine") console.error(stderr.trim());
  assert.equal(code, 0, `fly ${args[0]} ${args[1]} failed`);
  return stdout.trim();
}
async function machine(app: string) {
  const machines = JSON.parse(await fly("machine", "list", "-a", app, "--json"));
  assert.equal(machines.length, 1, `${app} must have one Machine`);
  return machines[0].id as string;
}
const kituneMachine = await machine(settings.kituneApp);
const cli = (...args: string[]) => fly("ssh", "console", "-a", settings.kituneApp, "--machine", kituneMachine,
  "-C", `gosu bun bun /app/src/cli.ts ${args.join(" ")}`);
async function pause(app: string, id: string) {
  if (lifecycle === "suspend") {
    // Drain traffic before manual suspension and expose the paused guest to
    // autostart afterward. Actual Proxy autosuspend also needs a separate check.
    try {
      await fly("machine", "cordon", id, "-a", app);
      await Bun.sleep(10_000);
      await fly("machine", "suspend", id, "-a", app, "--wait-timeout", "45s");
    } finally {
      await fly("machine", "uncordon", id, "-a", app);
    }
  } else await fly("machine", "stop", id, "-a", app, "--signal", "SIGTERM", "--timeout", "20", "--wait-timeout", "45s");
  const state = JSON.parse(await fly("machine", "list", "-a", app, "--json"));
  assert.equal(state.find((m: { id: string }) => m.id === id)?.state, lifecycle === "suspend" ? "suspended" : "stopped");
}
async function cold(app: string, id: string, url: string) {
  await pause(app, id);
  const start = performance.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(55_000) });
  if (response.status !== 200) {
    const machines = JSON.parse(await fly("machine", "list", "-a", app, "--json"));
    const current = machines.find((m: { id: string }) => m.id === id);
    report.failedRecovery = { status: response.status, state: current?.state, events: current?.events };
  }
  assert.equal(response.status, 200, "Cold request failed");
  await response.arrayBuffer();
  return Math.round(performance.now() - start);
}
const kituneToken = (body: Record<string, string>) => kitune.request("/api/auth/oauth2/token", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${client}:${settings.smoke}`).toString("base64")}` },
  body: new URLSearchParams(body),
});

async function exercise(mutations: CredentialMutations) {
  const kituneDiscovery = await json(`${settings.kituneOrigin}/api/auth/.well-known/openid-configuration`);
  assert.equal(kituneDiscovery.issuer, `${settings.kituneOrigin}/api/auth`);
  assert.equal((await kitune.get("/login")).status, 200);
  assert.equal((await kitune.get("/assets/client.js")).status, 200);
  const kituneKeys = await json(kituneDiscovery.jwks_uri);
  console.log("Live TLS, Discovery, JWKS and UI assets passed");

  const output = await mutations.issueEnrollment(() => cli("enroll", settings.smokeUser));
  const enrollment = new URL(output.split(/\s+/).find(value => value.startsWith(`${settings.kituneOrigin}/enroll#`))!);
  assert.equal((await kitune.post("/enrollment", { token: enrollment.hash.slice(1) })).status, 200);
  assert.equal(await (await kitune.get("/api/auth/get-session")).json(), null);
  const options = await (await kitune.get("/api/auth/passkey/generate-register-options")).json();
  const key = new Authenticator("bada5566-a7aa-401f-bd96-45619a55120d");
  const withoutUV = await mutations.registerPasskey(() => kitune.post("/api/auth/passkey/verify-registration", { response: key.registration(options, settings.kituneOrigin, false), createSession: true }));
  assert(withoutUV.status >= 400, "Registration without UV must fail");
  const retryOptions = await (await kitune.get("/api/auth/passkey/generate-register-options")).json();
  const registration = await mutations.registerPasskey(() => kitune.post("/api/auth/passkey/verify-registration", { response: key.registration(retryOptions, settings.kituneOrigin), createSession: true }));
  assert.equal(registration.status, 200, "Live Passkey registration");
  await kitune.post("/api/auth/sign-out", {});
  const loginOptions = await (await kitune.get("/api/auth/passkey/generate-authenticate-options")).json();
  assert.equal((await kitune.post("/api/auth/passkey/verify-authentication", { response: key.assertion(loginOptions, settings.kituneOrigin) })).status, 200);
  console.log("Live Passkey enrollment, UV rejection and login passed");

  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(20).toString("hex"), nonce = randomBytes(20).toString("hex");
  const params = new URLSearchParams({ client_id: client, redirect_uri: callback, response_type: "code", scope: "openid profile email groups offline_access",
    state, nonce, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") });
  let target = `${settings.kituneOrigin}/api/auth/oauth2/authorize?${params}`;
  let consentExercised = false;
  for (let hop = 0; hop < 8 && !target.startsWith(callback); hop++) {
    const url = new URL(target);
    assert.equal(url.origin, settings.kituneOrigin, "Unexpected redirect origin");
    const response = await kitune.get(target);
    if (response.status === 200 && url.pathname === "/consent") {
      consentExercised = true;
      const consent = await kitune.post("/api/auth/oauth2/consent", { accept: true, oauth_query: url.search.slice(1) });
      assert.equal(consent.status, 200);
      const result = await consent.json();
      target = new URL(result.redirect_uri ?? result.url, target).href;
      continue;
    }
    assert(response.status >= 300 && response.status < 400, `Flow status ${response.status} at ${url.origin}${url.pathname}`);
    assert(response.headers.get("location"));
    target = new URL(response.headers.get("location")!, target).href;
  }
  const result = new URL(target);
  assert.equal(`${result.origin}${result.pathname}`, callback);
  assert.equal(result.searchParams.get("state"), state);
  assert(consentExercised, "Kitune consent screen must be exercised");
  const code = result.searchParams.get("code");
  assert(code, "Authorization code missing");
  const exchange = await kituneToken({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: callback });
  assert.equal(exchange.status, 200, "Kitune authorization code exchange");
  let tokens = await exchange.json();
  const verify = (jwt: string) => jwtVerify(jwt, createLocalJWKSet(kituneKeys), { issuer: kituneDiscovery.issuer, audience: client });
  const { payload } = await verify(tokens.id_token);
  assert.equal(payload.sub, settings.smokeUser);
  assert.equal(payload.nonce, nonce);
  assert.equal(payload.exp! - payload.iat!, 900);
  assert.deepEqual(payload.groups, ["deployment-test"]);
  const info = await kitune.request("/api/auth/oauth2/userinfo", { headers: { authorization: `Bearer ${tokens.access_token}` } });
  assert.equal(info.status, 200);
  const userInfo = await info.json();
  assert.equal(userInfo.sub, settings.smokeUser);
  assert.deepEqual(userInfo.groups, ["deployment-test"]);
  // Code replay intentionally revokes the tokens issued for that code in Better
  // Auth. Its rejection is covered by auth.test.ts; keep this grant for recovery.
  console.log("Direct Kitune login, consent, S256, JWT signatures, stable subject, groups and UserInfo passed");

  const kituneCold: number[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    kituneCold.push(await cold(settings.kituneApp, kituneMachine, `${settings.kituneOrigin}/healthz`));
    console.log(`${lifecycle} recovery ${attempt + 1}: Kitune ${kituneCold.at(-1)}ms`);
  }
  report.kituneColdMs = kituneCold;
  assert.deepEqual(await json(kituneDiscovery.jwks_uri), kituneKeys);
  assert.equal((await (await kitune.get("/api/auth/get-session")).json()).user.id, settings.smokeUser);
  await pause(settings.kituneApp, kituneMachine);
  const refreshStarted = performance.now();
  const previousRefresh = tokens.refresh_token;
  const refresh = await kituneToken({ grant_type: "refresh_token", refresh_token: previousRefresh });
  assert.equal(refresh.status, 200, "Refresh must wake up Kitune");
  tokens = await refresh.json();
  report.refreshColdMs = Math.round(performance.now() - refreshStarted);
  assert.notEqual(tokens.refresh_token, previousRefresh);
  assert.equal((await verify(tokens.id_token)).payload.sub, payload.sub);
  const refreshedInfo = await kitune.request("/api/auth/oauth2/userinfo", { headers: { authorization: `Bearer ${tokens.access_token}` } });
  assert.equal(refreshedInfo.status, 200, "Refreshed grant must remain valid until explicit revocation");
  console.log(`Refresh woke Kitune in ${report.refreshColdMs}ms; subject and signing keys survived restart`);

  await cli("revoke", settings.smokeUser);
  assert.equal(await (await kitune.get("/api/auth/get-session")).json(), null);
  assert((await kituneToken({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status >= 400, "Revoked identity could still refresh");
  assert((await kitune.request("/api/auth/oauth2/userinfo", { headers: { authorization: `Bearer ${tokens.access_token}` } })).status >= 400, "Revoked access token could still reach UserInfo");
  report.passed = true;
  console.log("Live revocation invalidated the direct Kitune session, refresh token and access token");
}

try {
  await withCredentialCleanup(exercise, {
    prepare: async () => {
      // A failed wake-up may leave the Machine suspended and unable to accept SSH.
      const machines = JSON.parse(await fly("machine", "list", "-a", settings.kituneApp, "--json"));
      if (machines.find((m: { id: string }) => m.id === kituneMachine)?.state !== "started") {
        await fly("machine", "start", kituneMachine, "-a", settings.kituneApp);
      }
      await json(`${settings.kituneOrigin}/healthz`);
    },
    recover: async () => { await cli("recover", settings.smokeUser); },
    revoke: async () => { await cli("revoke", settings.smokeUser); },
  }, () => {
    report.cleanupFailed = true;
    report.passed = false;
    console.error("Test credential cleanup failed; restore the canonical configuration before using the service");
  });
} catch (error) {
  report.passed = false;
  throw error;
} finally {
  await mkdir("test-results", { recursive: true });
  await writeFile(`test-results/fly-${lifecycle}.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
}
