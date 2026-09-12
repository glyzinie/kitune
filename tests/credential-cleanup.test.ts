import { describe, expect, test } from "bun:test";
import { withCredentialCleanup } from "./credential-cleanup";
import { Authenticator, enroll, fixture, prepareEnrollment } from "./helpers";

describe("disposable credential cleanup", () => {
  test("removes a Passkey committed before its registration response is lost", async () => {
    const calls: string[] = [];
    const registrationError = new Error("registration response lost");
    const recoverError = new Error("recover response lost");
    let observedError: unknown;
    let observedCleanupError: unknown;
    const { runtime, agent } = await fixture();
    let remainingPasskeys: number | undefined;
    let remainingEnrollments: number | undefined;

    try {
      await withCredentialCleanup(async (mutations) => {
        const url = await mutations.issueEnrollment(async () => runtime.store.issueEnrollment("owner", agent.origin));
        const { options } = await prepareEnrollment(runtime, agent, "owner", url.split("#")[1]);
        await mutations.registerPasskey(async () => {
          const key = new Authenticator();
          const response = await agent.post("/api/auth/passkey/verify-registration", {
            response: key.registration(options, agent.origin), createSession: true,
          });
          expect(response.status).toBe(200);
          throw registrationError;
        });
      }, {
        prepare: async () => { calls.push("prepare"); },
        recover: async () => {
          calls.push("recover");
          runtime.store.issueEnrollment("owner", agent.origin, true);
          throw recoverError;
        },
        revoke: async () => {
          calls.push("revoke");
          runtime.store.db.transaction(() => runtime.store.revokeUser("owner")).immediate();
        },
      }, (error) => { observedCleanupError = error; });
    } catch (error) {
      observedError = error;
    } finally {
      remainingPasskeys = runtime.store.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM passkey").get()?.count;
      remainingEnrollments = runtime.store.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM kituneEnrollment").get()?.count;
      runtime.close();
    }

    expect(observedError).toBe(registrationError);
    expect(observedCleanupError).toBe(recoverError);
    expect(calls).toEqual(["prepare", "recover", "revoke"]);
    expect(remainingPasskeys).toBe(0);
    expect(remainingEnrollments).toBe(0);
  });

  test("does not recover an existing Passkey when the unused-user precondition rejects enrollment", async () => {
    const calls: string[] = [];
    let observedError: unknown;
    let preconditionError: unknown;
    const { runtime, agent } = await fixture();
    await enroll(runtime, agent);
    let remainingPasskeys: number | undefined;

    try {
      await withCredentialCleanup(async (mutations) => {
        await mutations.issueEnrollment(async () => {
          try {
            return runtime.store.issueEnrollment("owner", agent.origin);
          } catch (error) {
            preconditionError = error;
            throw error;
          }
        });
      }, {
        recover: async () => {
          calls.push("recover");
          runtime.store.issueEnrollment("owner", agent.origin, true);
        },
        revoke: async () => {
          calls.push("revoke");
          runtime.store.db.transaction(() => runtime.store.revokeUser("owner")).immediate();
        },
      });
    } catch (error) {
      observedError = error;
    } finally {
      remainingPasskeys = runtime.store.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM passkey").get()?.count;
      runtime.close();
    }

    expect(observedError).toBe(preconditionError);
    expect((observedError as Error).message).toContain("Passkeys already exist");
    expect(calls).toEqual(["revoke"]);
    expect(remainingPasskeys).toBe(1);
  });

  test("attempts revocation even when cleanup preparation cannot confirm service health", async () => {
    const calls: string[] = [];
    const workError = new Error("enrollment response lost");
    const prepareError = new Error("health check failed");
    let observedError: unknown;
    let observedCleanupError: unknown;

    try {
      await withCredentialCleanup(async (mutations) => {
        await mutations.issueEnrollment(async () => { throw workError; });
      }, {
        prepare: async () => {
          calls.push("prepare");
          throw prepareError;
        },
        recover: async () => { calls.push("recover"); },
        revoke: async () => { calls.push("revoke"); },
      }, (error) => { observedCleanupError = error; });
    } catch (error) {
      observedError = error;
    }

    expect(observedError).toBe(workError);
    expect(observedCleanupError).toBe(prepareError);
    expect(calls).toEqual(["prepare", "revoke"]);
  });
});
