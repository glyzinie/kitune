import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { getAuthenticatorName, passkey } from "@better-auth/passkey";
import { oauthProvider } from "@better-auth/oauth-provider";
import { getMigrations } from "better-auth/db/migration";
import { defineRequestState } from "@better-auth/core/context";
import { parse as parseCookie } from "hono/utils/cookie";
import { scopes, type Settings } from "./config";
import { hash, openDatabase, Store } from "./store";
import { clientIPOptions } from "./client-ip";

export const ENROLLMENT_COOKIE = "kitune-enrollment";
export const FRESH_AGE = 10 * 60;
const publicPaths = new Set([
  "/sign-in/social", "/callback/:id", "/get-session", "/sign-out", "/list-sessions",
  "/revoke-session", "/revoke-sessions", "/revoke-other-sessions",
  "/passkey/generate-register-options", "/passkey/verify-registration",
  "/passkey/generate-authenticate-options", "/passkey/verify-authentication",
  "/passkey/list-user-passkeys", "/passkey/update-passkey",
  "/oauth2/authorize", "/oauth2/consent", "/oauth2/continue", "/oauth2/token",
  "/oauth2/userinfo", "/oauth2/revoke", "/oauth2/introspect",
  "/oauth2/end-session", "/oauth2/end-session/confirm",
  "/.well-known/openid-configuration", "/.well-known/oauth-authorization-server", "/jwks",
]);
const sessionPaths = new Set([
  "/get-session", "/list-sessions", "/revoke-session", "/revoke-sessions", "/revoke-other-sessions",
  "/passkey/list-user-passkeys", "/passkey/update-passkey", "/oauth2/authorize", "/oauth2/consent", "/oauth2/continue",
  "/passkey/generate-register-options", "/passkey/verify-registration",
]);

function enrollmentCookie(request?: Request) {
  return parseCookie(request?.headers.get("cookie") ?? "")[ENROLLMENT_COOKIE];
}

export function assertFresh(createdAt: Date | string) {
  if (Date.now() - new Date(createdAt).getTime() > FRESH_AGE * 1000) {
    throw new APIError("FORBIDDEN", { code: "FRESH_SESSION_REQUIRED", message: "設定を変更するには、もう一度ログインしてください。" });
  }
}

export async function createRuntime(settings: Settings, options: { testing?: boolean } = {}) {
  const db = openDatabase(settings.databasePath);
  const store = new Store(db);
  const { config } = settings;
  const authenticatedIdentity = defineRequestState<{ id: string; epoch: number } | null>(() => null);
  const rememberIdentity = async (id: string) => {
    const user = store.active(id);
    const previous = await authenticatedIdentity.get();
    if (previous && (previous.id !== id || previous.epoch !== user.epoch)) throw new APIError("UNAUTHORIZED");
    await authenticatedIdentity.set({ id, epoch: user.epoch });
  };
  const claims = (id: string, requestedScopes: string[]) => {
    const user = store.active(id);
    return {
      ...(requestedScopes.includes("profile") ? { preferred_username: user.id } : {}),
      ...(requestedScopes.includes("groups") ? { groups: JSON.parse(user.groups) as string[] } : {}),
    };
  };
  const authOptions = {
    appName: config.name,
    baseURL: config.origin,
    basePath: "/api/auth",
    secret: settings.secret,
    logger: { disabled: options.testing, level: "warn", log: (level) => { console.error(`auth_${level}`); } },
    database: db,
    trustedOrigins: [config.origin],
    emailAndPassword: { enabled: false },
    account: { accountLinking: { enabled: false, disableImplicitLinking: true }, encryptOAuthTokens: true },
    user: {
      additionalFields: {
        enabled: { type: "boolean", defaultValue: false, required: true, input: false },
        groups: { type: "string[]", defaultValue: [], required: true, input: false },
        epoch: { type: "number", defaultValue: 0, required: true, input: false },
      },
    },
    session: {
      expiresIn: 7 * 24 * 60 * 60,
      freshAge: FRESH_AGE,
      cookieCache: { enabled: false },
      additionalFields: { epoch: { type: "number", defaultValue: 0, required: true, input: false } },
    },
    advanced: { useSecureCookies: config.origin.startsWith("https:"), ipAddress: clientIPOptions(config) },
    rateLimit: { enabled: !options.testing, storage: "database", window: 60, max: 100 },
    socialProviders: settings.discord ? {
      discord: {
        ...settings.discord,
        disableSignUp: true,
        disableDefaultScope: true,
        scope: ["identify"],
        prompt: "consent",
        mapProfileToUser: async (profile) => {
          const link = db.query<{ userId: string }, [string]>("SELECT userId FROM account WHERE providerId = 'discord' AND accountId = ?").get(profile.id);
          if (!link) throw new APIError("FORBIDDEN", { message: "許可されていないDiscordアカウントです。" });
          const user = store.active(link.userId);
          await rememberIdentity(user.id);
          return { name: user.name, email: user.email, emailVerified: Boolean(user.emailVerified), image: undefined };
        },
      },
    } : {},
    databaseHooks: {
      user: { create: { before: async () => false } },
      session: {
        create: { before: async (session) => {
          const identity = await authenticatedIdentity.get();
          const user = store.active(session.userId);
          if (!identity || identity.id !== user.id || identity.epoch !== user.epoch) throw new APIError("UNAUTHORIZED");
          return { data: { ...session, epoch: identity.epoch } };
        } },
        delete: { before: async (session) => { store.revokeSession(session.id); } },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!publicPaths.has(ctx.path)) throw new APIError("NOT_FOUND");
        if (ctx.path === "/callback/:id" && ctx.params?.id !== "discord") throw new APIError("NOT_FOUND");
        // The provider permits varying native loopback ports. This IdP requires
        // a literal configured URI for every client, including local web apps.
        if (ctx.path === "/oauth2/authorize") {
          // Provider 1.7.4 resumes login/consent through this endpoint with its
          // verified query, even though the original request used POST.
          const mode = (ctx as typeof ctx & { authorizeSettings?: { isAuthorize?: boolean } }).authorizeSettings ?? { isAuthorize: true };
          const parameters = ctx.method === "POST" && mode.isAuthorize === true ? ctx.body : ctx.query;
          const client = config.clients.find((entry) => entry.enabled && entry.id === parameters?.client_id);
          if (!client || typeof parameters?.redirect_uri !== "string" || !client.redirect_uris.includes(parameters.redirect_uri)) {
            throw new APIError("BAD_REQUEST", { error: "invalid_request", error_description: "Unregistered redirect_uri" });
          }
        }
        if (sessionPaths.has(ctx.path)) {
          const current = await getSessionFromCtx(ctx, { disableCookieCache: true });
          if (current) {
            const user = store.active(current.user.id);
            if ((current.session as { epoch?: number }).epoch !== user.epoch) throw new APIError("UNAUTHORIZED");
            if (ctx.path.startsWith("/passkey/") && !ctx.path.includes("list-user")) assertFresh(current.session.createdAt);
          }
          if (ctx.path === "/passkey/verify-registration" && !current && ctx.body?.createSession !== true) {
            throw new APIError("BAD_REQUEST", { message: "初回登録にはcreateSessionが必要です。" });
          }
          if (ctx.path === "/passkey/verify-registration") {
            await rememberIdentity(current?.user.id ?? store.enrollment(enrollmentCookie(ctx.request)).id);
          }
        }
        if (ctx.path === "/passkey/verify-authentication") {
          const credentialId = ctx.body?.response?.id;
          const credential = typeof credentialId === "string"
            ? db.query<{ userId: string }, [string]>("SELECT userId FROM passkey WHERE credentialID = ?").get(credentialId)
            : null;
          if (!credential) throw new APIError("UNAUTHORIZED");
          await rememberIdentity(credential.userId);
        }
        // Enrollment credentials only travel in the HttpOnly cookie, never URL queries.
        if (ctx.path.startsWith("/passkey/") && (ctx.query?.context || ctx.body?.context)) throw new APIError("BAD_REQUEST");
      }),
    },
    plugins: [
      jwt({ jwks: { keyPairConfig: { alg: "RS256" } } }),
      passkey({
        rpID: new URL(config.origin).hostname,
        rpName: config.name,
        origin: config.origin,
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        registration: {
          requireSession: false,
          resolveUser: async ({ ctx }) => {
            const user = store.enrollment(enrollmentCookie(ctx.request));
            return { id: user.id, name: user.email, displayName: user.name };
          },
          afterVerification: async ({ ctx, verification, user }) => {
            if (!verification.registrationInfo?.userVerified) throw new APIError("FORBIDDEN", { message: "PIN・生体認証が必要です。" });
            await rememberIdentity(user.id);
            const current = await getSessionFromCtx(ctx, { disableCookieCache: true });
            if (current) {
              assertFresh(current.session.createdAt);
              if (current.user.id !== user.id) throw new APIError("FORBIDDEN");
            } else {
              if (ctx.body?.createSession !== true) throw new APIError("BAD_REQUEST");
              store.consumeEnrollment(enrollmentCookie(ctx.request) ?? "", user.id);
            }
            return { name: getAuthenticatorName(verification.registrationInfo.aaguid) ?? "Passkey" };
          },
        },
        authentication: {
          afterVerification: async ({ verification, clientData }) => {
            if (!verification.authenticationInfo.userVerified) throw new APIError("FORBIDDEN", { message: "PIN・生体認証が必要です。" });
            const credential = db.query<{ userId: string }, [string]>("SELECT userId FROM passkey WHERE credentialID = ?").get(clientData.id);
            if (!credential) throw new APIError("UNAUTHORIZED");
            await rememberIdentity(credential.userId);
          },
        },
      }),
      oauthProvider({
        loginPage: "/login",
        consentPage: "/consent",
        scopes: [...scopes],
        grantTypes: ["authorization_code", "refresh_token"],
        accessTokenExpiresIn: 900,
        idTokenExpiresIn: 900,
        refreshTokenExpiresIn: 30 * 24 * 60 * 60,
        codeExpiresIn: 300,
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        clientPrivileges: async () => false,
        resourcePrivileges: async () => false,
        storeClientSecret: { hash },
        customIdTokenClaims: async ({ user, scopes }) => claims(user.id, scopes),
        customUserInfoClaims: async ({ user, scopes }) => claims(user.id, scopes),
        customAccessTokenClaims: async ({ user }) => {
          if (!user) throw new APIError("FORBIDDEN");
          store.active(user.id);
          return {};
        },
      }),
    ],
  } satisfies BetterAuthOptions;
  try {
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
    if (version > 2) throw new Error("Database schema is newer than this application; refusing to start");
    if (version === 0) {
      const migrations = await getMigrations(authOptions);
      await migrations.runMigrations();
    }
    store.init();
    if (version < 2) {
      // A CLI recovery can commit after the async session hook, before INSERT.
      // Enforce the captured generation at the same instant as persistence.
      db.transaction(() => {
        db.exec(`CREATE TRIGGER kitune_session_epoch BEFORE INSERT ON session
          WHEN NOT EXISTS (SELECT 1 FROM user WHERE id = NEW.userId AND enabled = 1 AND epoch = NEW.epoch)
          BEGIN SELECT RAISE(ABORT, 'Session identity was revoked'); END;
          PRAGMA user_version = 2;`);
      }).immediate();
    }
    store.reconcile(settings);
    const auth = betterAuth(authOptions);
    await auth.$context;
    return { auth, store, settings, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}

export type Runtime = Awaited<ReturnType<typeof createRuntime>>;
