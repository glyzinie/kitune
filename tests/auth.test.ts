import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, copyFile, rm, writeFile, stat } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, jwtVerify, decodeJwt } from "jose";
import { configSchema, loadSettings } from "../src/config";
import { createRuntime, type Runtime } from "../src/auth";
import { createApp } from "../src/app";
import { Agent, Authenticator, authorize, enroll, fixture, fixtureConfig, fixtureSettings, grant, prepareEnrollment, token, testSecret, clientSecret } from "./helpers";

const runtimes: Runtime[] = [];
const tempPaths: string[] = [];
async function setup(overrides: Record<string, unknown> = {}, path = ":memory:") {
  const result = await fixture(overrides, path); runtimes.push(result.runtime); return result;
}
async function cli(args: string[], env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], { env: { ...process.env, NODE_ENV: "test", ...env }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  return stdout.trim();
}
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { try { runtime.close(); } catch {} }
  for (const path of tempPaths.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("configuration and boundaries", () => {
  test("unknown keys, duplicate Discord ownership, weak redirects are rejected", () => {
    expect(() => configSchema.parse({ ...fixtureConfig(), typo: true })).toThrow();
    const config = fixtureConfig(); config.users[1]!.discord_ids = [config.users[0]!.discord_ids[0]!];
    expect(() => configSchema.parse(config)).toThrow();
    expect(() => fixtureConfig({ origin: "http://auth.example.com" })).toThrow();
    expect(() => fixtureConfig({ origin: "http://127.0.0.1:3000" })).toThrow();
    expect(() => fixtureConfig({ origin: "https://127.0.0.1" })).toThrow();
    expect(() => fixtureConfig({ clients: [{ ...config.clients[0], redirect_uris: ["https://example.com/*"] }] })).toThrow();
    expect(() => fixtureConfig({ clients: [{ ...config.clients[0], require_pkce: "false" }] })).toThrow();
  });
  test.each([
    ["public", "startup"], ["secret_env", "settings loading"],
    ["missing secret", "startup"], ["short secret", "settings loading"],
  ] as const)("invalid %s client configuration fails during %s", async (invalid, phase) => {
    const directory = await mkdtemp(join(tmpdir(), "kitune-config-test-")); tempPaths.push(directory);
    const config = fixtureConfig({ users: [{ id: "owner", name: "Owner", email: "owner@example.com" }] });
    const client: Record<string, unknown> = { ...config.clients[0] };
    if (invalid === "public") client.token_endpoint_auth_method = "none";
    if (invalid === "secret_env") delete client.secret_env;
    const configPath = join(directory, "config.toml"), databasePath = join(directory, "uncreated.sqlite");
    await writeFile(configPath, Bun.TOML.stringify({ ...config, clients: [client] })!);
    const env = { ...process.env, NODE_ENV: "test", CONFIG_PATH: configPath, DATABASE_PATH: databasePath, PORT: "0",
      BETTER_AUTH_SECRET: testSecret, TEST_CLIENT_SECRET: invalid === "missing secret" ? "" : invalid === "short secret" ? "short" : clientSecret };
    const error = invalid === "public" ? "Only confidential clients" : invalid === "secret_env" ? "secret_env" : "TEST_CLIENT_SECRET must contain at least 32 characters";
    if (phase === "settings loading") {
      await expect(loadSettings(env)).rejects.toThrow(error);
    } else {
      const child = Bun.spawn([process.execPath, "src/server.ts"], { env, stdout: "pipe", stderr: "pipe" });
      const timeout = setTimeout(() => child.kill(), 5_000);
      try {
        const [code, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect(code).not.toBe(0);
        expect(stderr).toContain(error);
      } finally { clearTimeout(timeout); }
    }
    expect(await Bun.file(databasePath).exists()).toBe(false);
  });
  test("only the agreed authentication and management endpoints are exposed", async () => {
    const { runtime, agent } = await setup();
    await enroll(runtime, agent);
    const accounts = runtime.store.db.query<{ id: string }, []>("SELECT id FROM account WHERE userId='owner' ORDER BY id").all();
    const passkeys = await (await agent.get("/api/auth/passkey/list-user-passkeys")).json();
    const client = { client_name: "Unmanaged client", redirect_uris: ["http://localhost:9000/unmanaged"], scope: "openid" };
    // Valid inputs and a real session must reach the application's endpoint boundary.
    for (const [path, body] of [
      ["/sign-up/email", { name: "Unmanaged", email: "unmanaged@example.com", password: "test-only-password" }],
      ["/sign-in/email", { email: "owner@example.com", password: "test-only-password" }],
      ["/link-social", { provider: "discord", callbackURL: "/account" }],
      ["/unlink-account", { accountId: accounts[0]!.id }],
      ["/update-user", { name: "Unmanaged profile" }],
      ["/oauth2/register", client],
      ["/oauth2/create-client", client],
      ["/admin/oauth2/create-client", client],
      ["/passkey/delete-passkey", { id: passkeys[0].id }],
    ] as const) {
      expect((await agent.post(`/api/auth${path}`, body)).status, path).toBe(404);
    }
    expect((await agent.get("/api/auth/token")).status).toBe(404);
    expect(runtime.store.db.query("SELECT id, name FROM user ORDER BY id").all()).toEqual([
      { id: "alternate", name: "Alternate" }, { id: "owner", name: "Owner" },
    ]);
    expect(runtime.store.db.query("SELECT id FROM account WHERE userId='owner' ORDER BY id").all()).toEqual(accounts);
    expect(await (await agent.get("/api/auth/passkey/list-user-passkeys")).json()).toEqual(passkeys);
    expect(runtime.store.db.query("SELECT clientId FROM oauthClient").all()).toEqual([{ clientId: "test-client" }]);
    const metadata = await (await agent.get("/api/auth/.well-known/openid-configuration")).json();
    expect(metadata.issuer).toBe("http://localhost:3000/api/auth");
    expect(metadata.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(metadata.token_endpoint_auth_methods_supported).not.toContain("none");
  });
  test("enrollment endpoint rejects cross-origin requests and large payloads", async () => {
    const { app } = await setup();
    const response = await app.request("/enrollment", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(403);
    const large = await app.request("/enrollment", { method: "POST", body: "a".repeat(70_000) });
    expect(large.status).toBe(413);
  });
});

describe("Passkey ceremonies", () => {
  test("provider names are suggested after registration, editable, and unknown AAGUIDs stay generic", async () => {
    for (const [aaguid, expected] of [
      ["fbfc3007-154e-4ecc-8c0b-6e020557d7bd", "Apple Passwords"],
      ["bada5566-a7aa-401f-bd96-45619a55120d", "1Password"],
      ["00000000-0000-0000-0000-000000000000", "Passkey"],
      ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "Passkey"],
    ] as const) {
      const { runtime, agent } = await setup();
      const { options } = await prepareEnrollment(runtime, agent);
      const response = await agent.post("/api/auth/passkey/verify-registration", { response: new Authenticator(aaguid).registration(options, agent.origin), createSession: true });
      expect(response.status).toBe(200);
      const key = await response.json();
      expect(key.name).toBe(expected);
      if (aaguid === "fbfc3007-154e-4ecc-8c0b-6e020557d7bd") {
        expect((await agent.post("/api/auth/passkey/update-passkey", { id: key.id, name: "自分のPasskey" })).status).toBe(200);
        expect((await (await agent.get("/api/auth/passkey/list-user-passkeys")).json())[0].name).toBe("自分のPasskey");
      }
    }
  });
  test("an enrollment URL is not a session and cannot be used without createSession", async () => {
    const { runtime, agent } = await setup();
    const { options } = await prepareEnrollment(runtime, agent);
    expect(await (await agent.get("/api/auth/get-session")).json()).toBeNull();
    const response = await agent.post("/api/auth/passkey/verify-registration", { response: new Authenticator().registration(options, agent.origin), createSession: false });
    expect(response.status).toBe(400);
    expect(runtime.store.db.query("SELECT * FROM passkey").all()).toHaveLength(0);
  });
  test("UV-less registration fails without consuming enrollment; retry succeeds", async () => {
    const { runtime, agent } = await setup();
    const { options, token: enrollment } = await prepareEnrollment(runtime, agent);
    const key = new Authenticator();
    const failed = await agent.post("/api/auth/passkey/verify-registration", { response: key.registration(options, agent.origin, false), createSession: true });
    expect(failed.status).toBe(403);
    expect(runtime.store.enrollment(enrollment).id).toBe("owner");
    const next = await (await agent.get("/api/auth/passkey/generate-register-options")).json();
    const success = await agent.post("/api/auth/passkey/verify-registration", { response: key.registration(next, agent.origin), createSession: true });
    expect(success.status).toBe(200);
  });
  test("registration and login create the owner's session; UV-less login, incorrect Origin/RP, bad signatures and replay are rejected", async () => {
    const { runtime, agent } = await setup();
    const key = await enroll(runtime, agent);
    expect((await (await agent.get("/api/auth/get-session")).json()).user.id).toBe("owner");
    expect(runtime.store.db.query("SELECT * FROM kituneEnrollment").all()).toHaveLength(0);
    await agent.post("/api/auth/sign-out", {});
    for (const failure of ["uv", "origin", "rp", "signature"] as const) {
      const options = await (await agent.get("/api/auth/passkey/generate-authenticate-options")).json();
      if (failure === "rp") options.rpId = "wrong.example";
      const assertion = key.assertion(options, failure === "origin" ? "https://wrong.example" : agent.origin, failure !== "uv");
      if (failure === "signature") assertion.response.signature = Buffer.from("invalid").toString("base64url");
      expect((await agent.post("/api/auth/passkey/verify-authentication", { response: assertion })).status).toBeGreaterThanOrEqual(400);
      expect(await (await agent.get("/api/auth/get-session")).json()).toBeNull();
    }
    const options = await (await agent.get("/api/auth/passkey/generate-authenticate-options")).json();
    const assertion = key.assertion(options, agent.origin);
    expect((await agent.post("/api/auth/passkey/verify-authentication", { response: assertion })).status).toBe(200);
    expect((await (await agent.get("/api/auth/get-session")).json()).user.id).toBe("owner");
    expect((await agent.post("/api/auth/passkey/verify-authentication", { response: assertion })).status).toBeGreaterThanOrEqual(400);
  });
  test("expired enrollment and parallel reuse cannot mint credentials", async () => {
    const { runtime, agent, app } = await setup();
    const first = await prepareEnrollment(runtime, agent);
    const secondAgent = new Agent((r) => app.fetch(r), agent.origin);
    const second = await prepareEnrollment(runtime, secondAgent, "owner", first.token);
    const responses = await Promise.all([
      agent.post("/api/auth/passkey/verify-registration", { response: new Authenticator().registration(first.options, agent.origin), createSession: true }),
      secondAgent.post("/api/auth/passkey/verify-registration", { response: new Authenticator().registration(second.options, agent.origin), createSession: true }),
    ]);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(runtime.store.db.query("SELECT * FROM passkey").all()).toHaveLength(1);
    const expired = runtime.store.issueEnrollment("alternate", agent.origin).split("#")[1]!;
    runtime.store.db.query("UPDATE kituneEnrollment SET expiresAt=0").run();
    expect((await secondAgent.post("/enrollment", { token: expired })).status).toBe(403);
  });
  test("failed persistence rolls back the one-time token consumption", async () => {
    const { runtime, agent } = await setup();
    const first = await prepareEnrollment(runtime, agent);
    runtime.store.db.exec("CREATE TRIGGER reject_passkey BEFORE INSERT ON passkey BEGIN SELECT RAISE(ABORT, 'test persistence failure'); END");
    const response = await agent.post("/api/auth/passkey/verify-registration", { response: new Authenticator().registration(first.options, agent.origin), createSession: true });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(runtime.store.enrollment(first.token).id).toBe("owner");
    expect(runtime.store.db.query("SELECT * FROM session").all()).toHaveLength(0);
    runtime.store.db.exec("DROP TRIGGER reject_passkey");
  });
  test("last Passkey is protected, additional keys and rename work, stale sessions cannot modify", async () => {
    const { runtime, agent } = await setup({ users: [{ id: "owner", name: "Owner", email: "owner@example.com" }] });
    await enroll(runtime, agent);
    const first = runtime.store.db.query<{ id: string }, []>("SELECT id FROM passkey").get()!.id;
    expect((await agent.post(`/account/passkeys/${first}/delete`, {})).status).toBe(400);
    const options = await (await agent.get("/api/auth/passkey/generate-register-options")).json();
    expect((await agent.post("/api/auth/passkey/verify-registration", { response: new Authenticator().registration(options, agent.origin), createSession: false })).status).toBe(200);
    expect((await agent.post("/api/auth/passkey/update-passkey", { id: first, name: "Renamed" })).status).toBe(200);
    expect((await agent.post(`/account/passkeys/${first}/delete`, {})).status).toBe(200);
    runtime.store.db.query("UPDATE session SET createdAt = ?").run(new Date(Date.now() - 11 * 60_000).toISOString());
    expect((await agent.get("/api/auth/passkey/generate-register-options")).status).toBe(403);
  });
});

describe("Discord identity mapping", () => {
  test("main and alt share sub; separate user differs; unknown ID and state mismatch fail", async () => {
    const { runtime, agent } = await setup();
    let discordId = "111111111111111111";
    const mock = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://discord.com/api/oauth2/token") return Response.json({ access_token: "mock-discord-access-token", token_type: "Bearer", expires_in: 3600, scope: "identify" });
      if (decodeURIComponent(url).includes("discord.com/api/users/@me")) return Response.json({ id: discordId, username: "discord-name", global_name: "Discord Name", verified: true, email: "owner@example.com", avatar: null, discriminator: "0" });
      throw new Error(`Unexpected OAuth test request: ${new URL(url).pathname}`);
    }) as typeof fetch);
    try {
      for (const [id, expected] of [["111111111111111111", "owner"], ["222222222222222222", "owner"], ["333333333333333333", "alternate"], ["999999999999999999", null]] as const) {
        discordId = id;
        await agent.post("/api/auth/sign-out", {});
        const start = await (await agent.post("/api/auth/sign-in/social", { provider: "discord", callbackURL: "/account", errorCallbackURL: "/login?error=discord" })).json();
        expect(new URL(start.url).searchParams.get("scope")).toBe("identify");
        const state = new URL(start.url).searchParams.get("state")!;
        const response = await agent.get(`/api/auth/callback/discord?code=mock&state=${encodeURIComponent(state)}`);
        const session = await (await agent.get("/api/auth/get-session")).json();
        expect(session?.user.id ?? null).toBe(expected);
        if (expected) {
          const tokens = await grant(agent);
          expect(decodeJwt(tokens.id_token).sub).toBe(expected);
        } else expect(response.status).toBeGreaterThanOrEqual(300);
      }
      expect(runtime.store.db.query("SELECT * FROM user").all()).toHaveLength(2);
      const encrypted = runtime.store.db.query<{ accessToken: string }, []>("SELECT accessToken FROM account WHERE accessToken IS NOT NULL LIMIT 1").get()!;
      expect(encrypted.accessToken).not.toContain("mock-discord-access-token");
      expect((await agent.get("/api/auth/callback/discord?code=mock&state=wrong")).status).toBeGreaterThanOrEqual(300);
      expect(await (await agent.get("/api/auth/get-session")).json()).toBeNull();
    } finally { mock.mockRestore(); }
  });
});

describe("OIDC and revocation", () => {
  // Build these requests without the PKCE/nonce defaults of authorize().
  async function withoutPKCE(agent: Agent, additional: Record<string, string> = {}) {
    const params = new URLSearchParams({ client_id: "test-client", redirect_uri: "http://localhost:9000/callback", response_type: "code", scope: "openid profile email", state: "test-state", ...additional });
    const response = await agent.get(`/api/auth/oauth2/authorize?${params}`);
    const location = new URL(response.headers.get("location") ?? "/", agent.origin);
    return { response, location };
  }
  async function brokers(requirePKCE?: boolean) {
    const settings = fixtureSettings();
    if (requirePKCE !== undefined) settings.config.clients[0]!.require_pkce = requirePKCE;
    const first = { id: "test-client", secret: clientSecret };
    const second = { id: "second-broker", secret: "second-broker-secret-for-isolation-test" };
    settings.config.clients.push({ ...settings.config.clients[0]!, id: second.id, name: "Second broker", secret_env: "SECOND_BROKER_SECRET" });
    settings.clientSecrets.set(second.id, second.secret);
    const runtime = await createRuntime(settings, { testing: true }); runtimes.push(runtime);
    const app = createApp(runtime);
    const agent = new Agent((request) => app.fetch(request), settings.config.origin);
    await enroll(runtime, agent);
    const codeFor = async (id: string): Promise<Record<string, string>> => {
      if (requirePKCE === false) {
        const flow = await withoutPKCE(agent, { client_id: id, scope: "openid profile email offline_access", nonce: "test-nonce" });
        const code = flow.location.searchParams.get("code");
        expect(code).toBeTruthy();
        return { grant_type: "authorization_code", code: code!, redirect_uri: "http://localhost:9000/callback" };
      }
      const flow = await authorize(agent, { client_id: id });
      return { grant_type: "authorization_code", code: new URL(flow.location).searchParams.get("code")!, code_verifier: flow.verifier, redirect_uri: "http://localhost:9000/callback" };
    };
    return { settings, runtime, agent, first, second, codeFor };
  }
  test("code, PKCE, signed ID token, UserInfo, refresh, nonce and group scope", async () => {
    const { runtime, agent } = await setup();
    await enroll(runtime, agent);
    const tokens = await grant(agent);
    const jwks = await (await agent.get("/api/auth/jwks")).json();
    const verified = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks), { issuer: `${agent.origin}/api/auth`, audience: "test-client" });
    expect(verified.payload.sub).toBe("owner");
    expect(verified.payload.nonce).toBe("test-nonce");
    expect(verified.payload.groups).toEqual(["personal", "reader"]);
    expect(Number(verified.payload.exp) - Number(verified.payload.iat)).toBe(900);
    const info = await agent.request("/api/auth/oauth2/userinfo", { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect((await info.json()).sub).toBe("owner");
    const refreshed = await token(agent, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    expect(refreshed.status).toBe(200);
    const rotated = await refreshed.json();
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    expect(decodeJwt(rotated.id_token).groups).toEqual(["personal", "reader"]);
    expect((await token(agent, { grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status).toBe(400);
    const flow = await authorize(agent, { scope: "openid profile" });
    const code = new URL(flow.location).searchParams.get("code")!;
    const narrow = await token(agent, { grant_type: "authorization_code", code, code_verifier: flow.verifier, redirect_uri: "http://localhost:9000/callback" });
    expect(decodeJwt((await narrow.json()).id_token).groups).toBeUndefined();
  });
  test("redirect mismatch, missing PKCE, wrong verifier and reused code are rejected", async () => {
    const { runtime, agent } = await setup();
    await enroll(runtime, agent);
    const mismatch = await agent.get("/api/auth/oauth2/authorize?client_id=test-client&response_type=code&redirect_uri=https://evil.example&scope=openid");
    expect(mismatch.headers.get("location") ?? "").not.toContain("https://evil.example");
    for (const redirect of ["http://localhost:9001/callback", "http://localhost:9000/callback/", "http://localhost:9000/callback?extra=1"]) {
      const response = await agent.get(`/api/auth/oauth2/authorize?${new URLSearchParams({ client_id: "test-client", response_type: "code", redirect_uri: redirect, scope: "openid" })}`);
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
    }
    const missing = await authorize(agent, { code_challenge: "", code_challenge_method: "" });
    expect(new URL(missing.location, agent.origin).searchParams.has("code")).toBe(false);
    expect((await withoutPKCE(agent)).location.searchParams.has("code")).toBe(false);
    const plain = await authorize(agent, { code_challenge_method: "plain" });
    expect(new URL(plain.location, agent.origin).searchParams.has("code")).toBe(false);
    const wrong = await authorize(agent);
    expect((await token(agent, { grant_type: "authorization_code", code: new URL(wrong.location).searchParams.get("code")!, code_verifier: "x".repeat(43), redirect_uri: "http://localhost:9000/callback" })).status).toBeGreaterThanOrEqual(400);
    const flow = await authorize(agent);
    const body = { grant_type: "authorization_code", code: new URL(flow.location).searchParams.get("code")!, code_verifier: flow.verifier, redirect_uri: "http://localhost:9000/callback" };
    expect((await token(agent, body)).status).toBe(200);
    expect((await token(agent, body)).status).toBe(400);
  });
  test.each(["client_secret_basic", "client_secret_post"] as const)("%s requires the correct secret for code exchange and refresh", async (method) => {
    const config = fixtureConfig();
    config.clients[0]!.token_endpoint_auth_method = method;
    const { runtime, agent } = await setup(config);
    await enroll(runtime, agent);
    const codeFor = async () => {
      const flow = await authorize(agent);
      return { grant_type: "authorization_code", code: new URL(flow.location).searchParams.get("code")!, code_verifier: flow.verifier, redirect_uri: "http://localhost:9000/callback" };
    };
    const missingSecret = (body: Record<string, string>) => agent.request("/api/auth/oauth2/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...body, client_id: "test-client" }),
    });
    // A rejected exchange can consume a code: issue independent codes for each case.
    expect((await missingSecret(await codeFor())).status).toBeGreaterThanOrEqual(400);
    expect((await token(agent, await codeFor(), { id: "test-client", secret: "wrong-secret", method })).status).toBeGreaterThanOrEqual(400);
    const refreshFor = async () => {
      const response = await token(agent, await codeFor(), { id: "test-client", secret: clientSecret, method });
      expect(response.status).toBe(200);
      const tokens = await response.json();
      expect(decodeJwt(tokens.id_token).sub).toBe("owner");
      return { grant_type: "refresh_token", refresh_token: tokens.refresh_token };
    };
    expect((await missingSecret(await refreshFor())).status).toBeGreaterThanOrEqual(400);
    expect((await token(agent, await refreshFor(), { id: "test-client", secret: "wrong-secret", method })).status).toBeGreaterThanOrEqual(400);
    const rotated = await token(agent, await refreshFor(), { id: "test-client", secret: clientSecret, method });
    expect(rotated.status).toBe(200);
    expect(decodeJwt((await rotated.json()).id_token).sub).toBe("owner");
  });
  test.each(["client_secret_basic", "client_secret_post"] as const)("Gitea-shaped requests without nonce or PKCE require a valid %s secret and support UserInfo", async (method) => {
    const config = fixtureConfig();
    Object.assign(config.clients[0]!, { require_pkce: false, token_endpoint_auth_method: method });
    const { runtime, agent } = await setup(config);
    await enroll(runtime, agent);
    const codeFor = async () => {
      const flow = await withoutPKCE(agent);
      expect(flow.location.searchParams.get("state")).toBe("test-state");
      const code = flow.location.searchParams.get("code");
      expect(code).toBeTruthy();
      return { grant_type: "authorization_code", code: code!, redirect_uri: "http://localhost:9000/callback" };
    };
    const missing = await agent.request("/api/auth/oauth2/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...await codeFor(), client_id: "test-client" }),
    });
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect((await token(agent, await codeFor(), { id: "test-client", secret: "incorrect-secret", method })).status).toBeGreaterThanOrEqual(400);
    const body = await codeFor();
    const client = { id: "test-client", secret: clientSecret, method };
    const exchanged = await token(agent, body, client);
    expect(exchanged.status).toBe(200);
    const tokens = await exchanged.json();
    expect(tokens.refresh_token).toBeUndefined();
    const jwks = await (await agent.get("/api/auth/jwks")).json();
    const { payload } = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks), { issuer: `${agent.origin}/api/auth`, audience: client.id });
    expect(payload.sub).toBe("owner");
    expect(payload.nonce).toBeUndefined();
    expect(payload.groups).toBeUndefined();
    const info = await agent.request("/api/auth/oauth2/userinfo", { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ sub: payload.sub, name: "Owner", email: "owner@example.com", email_verified: true, preferred_username: "owner" });
    expect((await token(agent, body, client)).status).toBeGreaterThanOrEqual(400);
  });
  test("optional PKCE still validates supplied S256 challenges and rejects plain", async () => {
    const config = fixtureConfig(); config.clients[0]!.require_pkce = false;
    const { runtime, agent } = await setup(config);
    await enroll(runtime, agent);
    const plain = await authorize(agent, { code_challenge_method: "plain" });
    expect(new URL(plain.location, agent.origin).searchParams.has("code")).toBe(false);
    for (const verifier of [undefined, "x".repeat(43)]) {
      const flow = await authorize(agent);
      const body: Record<string, string> = { grant_type: "authorization_code", code: new URL(flow.location).searchParams.get("code")!, redirect_uri: "http://localhost:9000/callback" };
      if (verifier !== undefined) body.code_verifier = verifier;
      expect((await token(agent, body)).status).toBeGreaterThanOrEqual(400);
    }
    const unchallenged = await withoutPKCE(agent);
    expect((await token(agent, { grant_type: "authorization_code", code: unchallenged.location.searchParams.get("code")!, code_verifier: "x".repeat(43), redirect_uri: "http://localhost:9000/callback" })).status).toBeGreaterThanOrEqual(400);
    const flow = await authorize(agent);
    const body = { grant_type: "authorization_code", code: new URL(flow.location).searchParams.get("code")!, code_verifier: flow.verifier, redirect_uri: "http://localhost:9000/callback" };
    expect((await token(agent, body)).status).toBe(200);
    expect((await token(agent, body)).status).toBeGreaterThanOrEqual(400);
  });
  test("offline_access without PKCE requires openid and a nonempty nonce", async () => {
    const config = fixtureConfig(); config.clients[0]!.require_pkce = false;
    const { runtime, agent } = await setup(config);
    await enroll(runtime, agent);
    for (const request of [
      { scope: "openid profile offline_access" },
      { scope: "openid profile offline_access", nonce: "" },
      { scope: "profile offline_access", nonce: "test-nonce" },
    ]) {
      const flow = await withoutPKCE(agent, request as Record<string, string>);
      expect(flow.location.searchParams.has("code")).toBe(false);
    }
    const flow = await withoutPKCE(agent, { scope: "openid profile offline_access", nonce: "refresh-nonce" });
    const exchanged = await token(agent, { grant_type: "authorization_code", code: flow.location.searchParams.get("code")!, redirect_uri: "http://localhost:9000/callback" });
    expect(exchanged.status).toBe(200);
    const tokens = await exchanged.json();
    expect(decodeJwt(tokens.id_token).nonce).toBe("refresh-nonce");
    expect(tokens.refresh_token).toBeString();
    expect((await token(agent, { grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status).toBe(200);
    const pkce = await authorize(agent, { nonce: "" });
    const withPKCE = await token(agent, { grant_type: "authorization_code", code: new URL(pkce.location).searchParams.get("code")!, code_verifier: pkce.verifier, redirect_uri: "http://localhost:9000/callback" });
    expect(withPKCE.status).toBe(200);
    expect((await withPKCE.json()).refresh_token).toBeString();
  });
  test.each([true, false])("clients cannot exchange each other's codes or refresh tokens with require_pkce=%s", async (required) => {
    const { agent, first, second, codeFor } = await brokers(required);
    for (const [owner, other] of [[first, second], [second, first]] as const) {
      expect((await token(agent, await codeFor(owner.id), other)).status).toBeGreaterThanOrEqual(400);
      const exchanged = await token(agent, await codeFor(owner.id), owner);
      expect(exchanged.status).toBe(200);
      const tokens = await exchanged.json();
      expect(decodeJwt(tokens.id_token).aud).toBe(owner.id);
      expect((await token(agent, { grant_type: "refresh_token", refresh_token: tokens.refresh_token }, other)).status).toBeGreaterThanOrEqual(400);
    }
  });
  test.each([
    ["secret", undefined, undefined],
    ["require_pkce to false", true, false],
    ["require_pkce to true", false, true],
    ["require_pkce to omitted", false, undefined],
  ] as const)("changing %s revokes only the affected client's codes and grants", async (change, previous, next) => {
    const { settings, runtime, agent, first, second, codeFor } = await brokers(previous);
    const issue = async (client: typeof first) => {
      const exchanged = await token(agent, await codeFor(client.id), client);
      expect(exchanged.status).toBe(200);
      return exchanged.json();
    };
    const firstTokens = await issue(first), secondTokens = await issue(second);
    const firstCode = await codeFor(first.id), secondCode = await codeFor(second.id);
    const updated = { ...first };
    if (change === "secret") {
      updated.secret = "rotated-broker-secret-for-isolation-test";
      settings.clientSecrets.set(first.id, updated.secret);
    } else if (next === undefined) delete settings.config.clients[0]!.require_pkce;
    else settings.config.clients[0]!.require_pkce = next;
    runtime.store.reconcile(settings);
    expect((await token(agent, firstCode, updated)).status).toBeGreaterThanOrEqual(400);
    expect((await token(agent, { grant_type: "refresh_token", refresh_token: firstTokens.refresh_token }, updated)).status).toBeGreaterThanOrEqual(400);
    expect((await agent.request("/api/auth/oauth2/userinfo", { headers: { authorization: `Bearer ${firstTokens.access_token}` } })).status).toBe(401);
    expect((await agent.request("/api/auth/oauth2/userinfo", { headers: { authorization: `Bearer ${secondTokens.access_token}` } })).status).toBe(200);
    expect((await token(agent, secondCode, second)).status).toBe(200);
    expect((await token(agent, { grant_type: "refresh_token", refresh_token: secondTokens.refresh_token }, second)).status).toBe(200);
    if (change === "secret") {
      expect((await token(agent, await codeFor(first.id), updated)).status).toBe(200);
    } else {
      const fresh = await withoutPKCE(agent);
      expect(fresh.location.searchParams.has("code")).toBe(next === false);
      if (next === false) expect((await token(agent, { grant_type: "authorization_code", code: fresh.location.searchParams.get("code")!, redirect_uri: "http://localhost:9000/callback" })).status).toBe(200);
      else expect(decodeJwt((await grant(agent)).id_token).sub).toBe("owner");
    }
    expect((await (await agent.get("/api/auth/get-session")).json()).user.id).toBe("owner");
  });
  test("legacy settings without require_pkce preserve grants, credentials and signing keys across restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kitune-legacy-client-")); tempPaths.push(directory);
    const databasePath = join(directory, "kitune.sqlite");
    const { runtime, agent } = await setup({}, databasePath);
    const key = await enroll(runtime, agent);
    const tokens = await grant(agent);
    const pending = await authorize(agent);
    const jwks = await (await agent.get("/api/auth/jwks")).json();
    const credentials = runtime.store.db.query("SELECT id, credentialID, userId FROM passkey").all();
    // Fingerprint of the fixture client produced before require_pkce existed.
    const legacyFingerprint = "jxuayG41ubqq71i86fCpSmwES5R05n1f1FdhaKDYxUo";
    const fingerprint = () => runtime.store.db.query<{ fingerprint: string }, []>("SELECT fingerprint FROM kituneClient WHERE id='test-client'").get()!.fingerprint;
    expect(fingerprint()).toBe(legacyFingerprint);
    expect(runtime.settings.config.clients[0]).not.toHaveProperty("require_pkce");
    runtime.close();
    const restored = await setup({}, databasePath);
    for (const [name, value] of agent.cookies) restored.agent.cookies.set(name, value);
    expect(restored.runtime.store.db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(restored.runtime.store.db.query("SELECT fingerprint FROM kituneClient WHERE id='test-client'").get()).toEqual({ fingerprint: legacyFingerprint });
    expect(await (await restored.agent.get("/api/auth/jwks")).json()).toEqual(jwks);
    expect(restored.runtime.store.db.query("SELECT id, credentialID, userId FROM passkey").all()).toEqual(credentials);
    expect((await (await restored.agent.get("/api/auth/get-session")).json()).user.id).toBe("owner");
    expect((await restored.agent.request("/api/auth/oauth2/userinfo", { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(200);
    expect((await token(restored.agent, { grant_type: "authorization_code", code: new URL(pending.location).searchParams.get("code")!, code_verifier: pending.verifier, redirect_uri: "http://localhost:9000/callback" })).status).toBe(200);
    const refreshed = await token(restored.agent, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    expect(refreshed.status).toBe(200);
    expect(decodeJwt((await refreshed.json()).id_token).sub).toBe("owner");
    restored.agent.cookies.clear();
    const options = await (await restored.agent.get("/api/auth/passkey/generate-authenticate-options")).json();
    expect(options.rpId).toBe("localhost");
    expect((await restored.agent.post("/api/auth/passkey/verify-authentication", { response: key.assertion(options, restored.agent.origin) })).status).toBe(200);
  });
  test("removing a session invalidates its pending code and OAuth grants", async () => {
    const { runtime, agent, app } = await setup();
    const key = await enroll(runtime, agent);
    const tokens = await grant(agent);
    const pending = await authorize(agent);
    const session = await (await agent.get("/api/auth/get-session")).json();
    const other = new Agent((r) => app.fetch(r), agent.origin);
    const options = await (await other.get("/api/auth/passkey/generate-authenticate-options")).json();
    expect((await other.post("/api/auth/passkey/verify-authentication", { response: key.assertion(options, other.origin) })).status).toBe(200);
    expect((await other.post(`/account/sessions/${session.session.id}/delete`, {})).status).toBe(200);
    expect(await (await agent.get("/api/auth/get-session")).json()).toBeNull();
    expect((await token(agent, { grant_type: "authorization_code", code: new URL(pending.location).searchParams.get("code")!, code_verifier: pending.verifier, redirect_uri: "http://localhost:9000/callback" })).status).toBe(400);
    expect((await token(agent, { grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status).toBe(400);
    expect((await agent.request("/api/auth/oauth2/userinfo", { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401);
    expect((await (await other.get("/api/auth/get-session")).json()).user.id).toBe("owner");
  });
  test("consent requires a valid signed query and supports accept and deny", async () => {
    const config = fixtureConfig(); config.clients[0]!.skip_consent = false;
    const { runtime, agent } = await setup(config);
    await enroll(runtime, agent);
    const flow = await authorize(agent);
    expect(new URL(flow.location, agent.origin).pathname).toBe("/consent");
    const query = new URL(flow.location, agent.origin).search.slice(1);
    expect((await agent.post("/api/auth/oauth2/consent", { accept: true, oauth_query: query.replace("test-client", "evil-client") })).status).toBe(400);
    const accept = await agent.post("/api/auth/oauth2/consent", { accept: true, oauth_query: query });
    expect(accept.status).toBe(200);
    expect((await accept.json()).url).toContain("code=");
    const again = await authorize(agent, { prompt: "consent" });
    const deny = await agent.post("/api/auth/oauth2/consent", { accept: false, oauth_query: new URL(again.location, agent.origin).search.slice(1) });
    expect((await deny.json()).url).toContain("error=access_denied");
  });
  for (const change of ["disable", "remove", "discord", "client"] as const) {
    test(`${change} invalidates sessions, pending code, access and refresh grants`, async () => {
      const { runtime, agent } = await setup();
      await enroll(runtime, agent);
      const tokens = await grant(agent);
      const pending = await authorize(agent);
      const changed = fixtureSettings();
      if (change === "disable") changed.config.users[0]!.enabled = false;
      if (change === "remove") changed.config.users = changed.config.users.slice(1);
      if (change === "discord") changed.config.users[0]!.discord_ids = ["111111111111111111"];
      if (change === "client") changed.config.clients = [];
      runtime.store.reconcile(changed);
      if (change !== "client") {
        const session = await agent.get("/api/auth/get-session");
        expect(session.status !== 200 || await session.json() === null).toBe(true);
      }
      expect((await token(agent, { grant_type: "authorization_code", code: new URL(pending.location).searchParams.get("code")!, code_verifier: pending.verifier, redirect_uri: "http://localhost:9000/callback" })).status).toBeGreaterThanOrEqual(400);
      expect((await token(agent, { grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status).toBeGreaterThanOrEqual(400);
      expect((await agent.request("/api/auth/oauth2/userinfo", { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBeGreaterThanOrEqual(400);
    });
  }
  test("retired IDs cannot return and failed configuration sync is atomic", async () => {
    const { runtime } = await setup();
    const removed = fixtureSettings(); removed.config.users = removed.config.users.slice(1);
    runtime.store.reconcile(removed);
    const alternate = runtime.store.user("alternate");
    const accounts = runtime.store.db.query("SELECT id, userId, accountId FROM account ORDER BY id").all();
    const changed = fixtureSettings();
    changed.config.users.reverse();
    changed.config.users[0]!.enabled = false;
    changed.config.users[0]!.discord_ids = [];
    // Update the live user and remove its Discord link before encountering the retired ID.
    expect(() => runtime.store.reconcile(changed)).toThrow("Retired user ID");
    expect(runtime.store.user("owner")?.enabled).toBe(0);
    expect(runtime.store.user("alternate")).toEqual(alternate);
    expect(runtime.store.db.query("SELECT id, userId, accountId FROM account ORDER BY id").all()).toEqual(accounts);
  });
  test("recovery invalidates keys and grants; backup/restore retain subject and signing keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kitune-test-")); tempPaths.push(directory);
    const { runtime, agent } = await setup({}, join(directory, "source.sqlite"));
    await enroll(runtime, agent);
    const tokens = await grant(agent);
    const before = await (await agent.get("/api/auth/jwks")).json();
    await cli(["backup", join(directory, "backup.sqlite")], { DATABASE_PATH: runtime.settings.databasePath, CONFIG_PATH: join(directory, "missing.toml"), BETTER_AUTH_SECRET: "" });
    expect((await stat(join(directory, "backup.sqlite"))).mode & 0o777).toBe(0o600);
    const backup = new Database(join(directory, "backup.sqlite"), { readonly: true });
    try { expect(backup.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" }); } finally { backup.close(); }
    await copyFile(join(directory, "backup.sqlite"), join(directory, "restored.sqlite"));
    const restored = await createRuntime(fixtureSettings({}, join(directory, "restored.sqlite")), { testing: true }); runtimes.push(restored);
    const restoredAgent = new Agent((r) => createApp(restored).fetch(r), agent.origin);
    expect(await (await restoredAgent.get("/api/auth/jwks")).json()).toEqual(before);
    expect((await token(restoredAgent, { grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status).toBe(200);
    expect(restored.store.user("owner")?.id).toBe("owner");
    const url = runtime.store.issueEnrollment("owner", agent.origin, true);
    expect(runtime.store.db.query("SELECT * FROM passkey WHERE userId='owner'").all()).toHaveLength(0);
    expect((await token(agent, { grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status).toBe(400);
    expect(runtime.store.enrollment(url.split("#")[1]).id).toBe("owner");
  });
  test("revoke-all CLI removes restored sessions, grants and enrollment while retaining credentials and keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kitune-revoke-all-")); tempPaths.push(directory);
    const { runtime, agent } = await setup({}, join(directory, "restored.sqlite"));
    const key = await enroll(runtime, agent);
    const tokens = await grant(agent);
    const pending = await authorize(agent);
    const enrollment = runtime.store.issueEnrollment("alternate", agent.origin).split("#")[1]!;
    const jwks = await (await agent.get("/api/auth/jwks")).json();
    const accounts = runtime.store.db.query("SELECT id, userId, accountId FROM account ORDER BY id").all();
    const configPath = join(directory, "config.toml");
    await writeFile(configPath, Bun.TOML.stringify(runtime.settings.config)!);
    await cli(["revoke-all"], { CONFIG_PATH: configPath, DATABASE_PATH: runtime.settings.databasePath, BETTER_AUTH_SECRET: testSecret, TEST_CLIENT_SECRET: clientSecret, DISCORD_CLIENT_ID: "123456789", DISCORD_CLIENT_SECRET: "test-discord-client-secret" });
    expect(await (await agent.get("/api/auth/get-session")).json()).toBeNull();
    expect((await token(agent, { grant_type: "authorization_code", code: new URL(pending.location).searchParams.get("code")!, code_verifier: pending.verifier, redirect_uri: "http://localhost:9000/callback" })).status).toBe(400);
    expect((await token(agent, { grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status).toBe(400);
    expect((await agent.request("/api/auth/oauth2/userinfo", { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401);
    expect(() => runtime.store.enrollment(enrollment)).toThrow();
    expect(runtime.store.db.query("SELECT id, userId, accountId FROM account ORDER BY id").all()).toEqual(accounts);
    expect(await (await agent.get("/api/auth/jwks")).json()).toEqual(jwks);
    const options = await (await agent.get("/api/auth/passkey/generate-authenticate-options")).json();
    expect((await agent.post("/api/auth/passkey/verify-authentication", { response: key.assertion(options, agent.origin) })).status).toBe(200);
    expect(decodeJwt((await grant(agent)).id_token).sub).toBe("owner");
  });
});
