export type CredentialMutation = <T>(operation: () => Promise<T>) => Promise<T>;

export interface CredentialMutations {
  issueEnrollment: CredentialMutation;
  registerPasskey: CredentialMutation;
}

interface CredentialCleanupActions {
  prepare?: () => Promise<void>;
  recover: () => Promise<void>;
  revoke: () => Promise<void>;
}

async function attempt(errors: unknown[], operation?: () => Promise<void>) {
  if (!operation) return;
  try {
    await operation();
  } catch (error) {
    errors.push(error);
  }
}

export async function withCredentialCleanup<T>(
  work: (mutations: CredentialMutations) => Promise<T>,
  actions: CredentialCleanupActions,
  onCleanupError?: (error: unknown) => void,
): Promise<T> {
  let phase: "none" | "enrollment" | "registration" = "none";
  let workFailed = false;
  const mutations: CredentialMutations = {
    issueEnrollment: async <T>(operation: () => Promise<T>) => {
      // Remote mutations may commit before their response reaches this process.
      if (phase === "none") phase = "enrollment";
      return operation();
    },
    registerPasskey: async <T>(operation: () => Promise<T>) => {
      phase = "registration";
      return operation();
    },
  };

  try {
    return await work(mutations);
  } catch (error) {
    workFailed = true;
    throw error;
  } finally {
    if (phase !== "none") {
      const errors: unknown[] = [];
      await attempt(errors, actions.prepare);
      // recover removes a possibly committed Passkey but creates a replacement
      // enrollment, so revoke must run afterward even when recover throws.
      if (phase === "registration") await attempt(errors, actions.recover);
      await attempt(errors, actions.revoke);
      if (errors.length) {
        const cleanupError = errors.length === 1 ? errors[0] : new AggregateError(errors, "Credential cleanup failed");
        onCleanupError?.(cleanupError);
        if (!workFailed) throw cleanupError;
      }
    }
  }
}
