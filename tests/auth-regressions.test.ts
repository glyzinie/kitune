import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, type Runtime } from "../src/auth";
import { openDatabase, Store } from "../src/store";
import { Agent, authorize, enroll, fixture, fixtureSettings, grant, token } from "./helpers";
import { createApp } from "../src/app";

const runtimes: Runtime[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { try { runtime.close(); } catch {} }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

test("authorization POST validates its form body and ignores contradictory URL parameters", async () => {
  const { runtime, agent } = await fixture(); runtimes.push(runtime);
  await enroll(runtime, agent);
  const flow = await authorize(agent);
  const send = (query: string, form: URLSearchParams) => agent.request(`/api/auth/oauth2/authorize${query}`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form,
  });
  const good = await send("", flow.params);
  expect(good.status).toBe(302);
  const location = new URL(good.headers.get("location")!);
  expect(location.origin + location.pathname).toBe("http://localhost:9000/callback");
  expect((await token(agent, { grant_type: "authorization_code", code: location.searchParams.get("code")!,
    code_verifier: flow.verifier, redirect_uri: "http://localhost:9000/callback" })).status).toBe(200);
  const bad = new URLSearchParams(flow.params);
  bad.set("redirect_uri", "http://localhost:9999/callback");
  const rejected = await send(`?${flow.params}`, bad);
  expect(rejected.status).toBe(400);
  expect(rejected.headers.get("location")).toBeNull();
  const accepted = await send(`?${bad}`, flow.params);
  expect(accepted.status).toBe(302);
  expect(new URL(accepted.headers.get("location")!).port).toBe("9000");
});

for (const stage of ["session creation", "session insert"] as const) {
  test(`recovery on another DB connection prevents an in-flight login at ${stage}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "kitune-session-race-")); directories.push(directory);
    const path = join(directory, "kitune.sqlite");
    const { runtime, agent } = await fixture({}, path); runtimes.push(runtime);
    const key = await enroll(runtime, agent);
    await agent.post("/api/auth/sign-out", {});
    const options = await (await agent.get("/api/auth/passkey/generate-authenticate-options")).json();
    const context = await runtime.auth.$context;
    let recovered = false;
    const recover = () => {
      const db = openDatabase(path);
      try {
        new Store(db).issueEnrollment("owner", agent.origin, true);
        expect(db.query("SELECT COUNT(*) AS n FROM passkey WHERE userId='owner'").get()).toEqual({ n: 0 });
        expect(db.query("SELECT COUNT(*) AS n FROM session WHERE userId='owner'").get()).toEqual({ n: 0 });
        recovered = true;
      } finally { db.close(); }
    };
    const originalSession = context.internalAdapter.createSession.bind(context.internalAdapter);
    const originalCreate = context.adapter.create.bind(context.adapter);
    const hook = stage === "session creation"
      ? spyOn(context.internalAdapter, "createSession").mockImplementation(async (...args) => {
        recover(); return originalSession(...args);
      })
      : spyOn(context.adapter, "create").mockImplementation(async (data) => {
        if (data.model === "session") recover();
        return originalCreate(data);
      });
    try {
      const response = await agent.post("/api/auth/passkey/verify-authentication", { response: key.assertion(options, agent.origin) });
      expect(recovered).toBe(true);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await (await agent.get("/api/auth/get-session")).json()).toBeNull();
      expect(runtime.store.db.query("SELECT COUNT(*) AS n FROM session WHERE userId='owner'").get()).toEqual({ n: 0 });
      expect(runtime.store.user("owner")?.epoch).toBe(1);
      const denied = await authorize(agent);
      expect(new URL(denied.location, agent.origin).pathname).toBe("/login");
    } finally { hook.mockRestore(); }
  });
}

test("v1 database migration preserves identities, credentials, sessions, grants and signing keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kitune-schema-upgrade-")); directories.push(directory);
  const path = join(directory, "kitune.sqlite");
  const { runtime, agent } = await fixture({}, path); runtimes.push(runtime);
  await enroll(runtime, agent);
  const tokens = await grant(agent);
  const keys = await (await agent.get("/api/auth/jwks")).json();
  const credentials = runtime.store.db.query("SELECT id, credentialID FROM passkey").all();
  runtime.store.db.exec("DROP TRIGGER kitune_session_epoch; PRAGMA user_version = 1");
  runtime.close();
  const upgraded = await createRuntime(fixtureSettings({}, path), { testing: true }); runtimes.push(upgraded);
  const app = createApp(upgraded);
  const restored = new Agent((request) => app.fetch(request), agent.origin);
  for (const [name, value] of agent.cookies) restored.cookies.set(name, value);
  expect(upgraded.store.db.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
  expect(upgraded.store.db.query("SELECT id, credentialID FROM passkey").all()).toEqual(credentials);
  expect((await (await restored.get("/api/auth/get-session")).json()).user.id).toBe("owner");
  expect(await (await restored.get("/api/auth/jwks")).json()).toEqual(keys);
  expect((await token(restored, { grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status).toBe(200);
  upgraded.close();
  const db = openDatabase(path);
  try { db.exec("PRAGMA user_version = 3"); } finally { db.close(); }
  await expect(createRuntime(fixtureSettings({}, path), { testing: true })).rejects.toThrow("newer than this application");
});
