import { afterEach, describe, expect, test } from "bun:test";
import type { Runtime } from "../src/auth";
import { enroll, fixture, fixtureSettings } from "./helpers";

const runtimes: Runtime[] = [];

async function setup(overrides: Record<string, unknown> = {}) {
  const result = await fixture(overrides);
  runtimes.push(result.runtime);
  return result;
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
});

function emails(runtime: Runtime) {
  return runtime.store.db.query<{ id: string; email: string }, []>("SELECT id, email FROM user ORDER BY id").all();
}

function swapEmails(settings: ReturnType<typeof fixtureSettings>) {
  const owner = settings.config.users.find((user) => user.id === "owner")!;
  const alternate = settings.config.users.find((user) => user.id === "alternate")!;
  [owner.email, alternate.email] = [alternate.email, owner.email];
}

describe("configuration user synchronization", () => {
  test.each([false, true])("swaps two emails regardless of configuration order (reversed=%s)", async (reversed) => {
    const { runtime } = await setup();
    const changed = fixtureSettings();
    swapEmails(changed);
    if (reversed) changed.config.users.reverse();

    runtime.store.reconcile(changed);

    expect(emails(runtime)).toEqual([
      { id: "alternate", email: "owner@example.com" },
      { id: "owner", email: "alt@example.com" },
    ]);
  });

  test.each([false, true])("reassigns an email released by another user regardless of configuration order (reversed=%s)", async (reversed) => {
    const { runtime } = await setup();
    const changed = fixtureSettings();
    changed.config.users.find((user) => user.id === "owner")!.email = "alt@example.com";
    changed.config.users.find((user) => user.id === "alternate")!.email = "moved@example.com";
    if (reversed) changed.config.users.reverse();

    runtime.store.reconcile(changed);

    expect(emails(runtime)).toEqual([
      { id: "alternate", email: "moved@example.com" },
      { id: "owner", email: "alt@example.com" },
    ]);
  });

  test("a later synchronization failure restores emails and credentials", async () => {
    const users = [...fixtureSettings().config.users, {
      id: "departing", name: "Departing", email: "departing@example.com", email_verified: true,
      enabled: true, discord_ids: ["444444444444444444"], groups: [],
    }];
    const { runtime, agent } = await setup({ users });
    await enroll(runtime, agent, "departing");
    const before = {
      users: runtime.store.db.query("SELECT id, email, epoch FROM user ORDER BY id").all(),
      identities: runtime.store.db.query("SELECT id, retired, fingerprint FROM kituneIdentity ORDER BY id").all(),
      accounts: runtime.store.db.query("SELECT id, userId, providerId, accountId FROM account ORDER BY id").all(),
      passkeys: runtime.store.db.query("SELECT id, credentialID, userId FROM passkey ORDER BY id").all(),
      sessions: runtime.store.db.query("SELECT id, userId FROM session ORDER BY id").all(),
    };
    const changed = fixtureSettings();
    swapEmails(changed);
    changed.clientSecrets.delete("test-client");

    expect(() => runtime.store.reconcile(changed)).toThrow("Missing secret for client: test-client");

    expect(runtime.store.db.query("SELECT id, email, epoch FROM user ORDER BY id").all()).toEqual(before.users);
    expect(runtime.store.db.query("SELECT id, retired, fingerprint FROM kituneIdentity ORDER BY id").all()).toEqual(before.identities);
    expect(runtime.store.db.query("SELECT id, userId, providerId, accountId FROM account ORDER BY id").all()).toEqual(before.accounts);
    expect(runtime.store.db.query("SELECT id, credentialID, userId FROM passkey ORDER BY id").all()).toEqual(before.passkeys);
    expect(runtime.store.db.query("SELECT id, userId FROM session ORDER BY id").all()).toEqual(before.sessions);
  });
});
