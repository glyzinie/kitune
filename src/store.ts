import { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { APIError } from "better-auth/api";
import type { Settings } from "./config";

export const hash = (value: string) => createHash("sha256").update(value).digest("base64url");
export interface LocalUser { id: string; enabled: number; name: string; email: string; emailVerified: number; groups: string; epoch: number }

export function openDatabase(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  if (path !== ":memory:") chmodSync(path, 0o600);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
  return db;
}

export class Store {
  constructor(readonly db: Database) {}

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kituneIdentity (
        id TEXT PRIMARY KEY, retired INTEGER NOT NULL DEFAULT 0, fingerprint TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kituneClient (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kituneMeta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kituneEnrollment (
        tokenHash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES user(id),
        expiresAt INTEGER NOT NULL, epoch INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS kitune_account_identity ON account(providerId, accountId);
      CREATE UNIQUE INDEX IF NOT EXISTS kitune_passkey_credential ON passkey(credentialID);
    `);
  }

  user(id: string): LocalUser | null {
    return this.db.query<LocalUser, [string]>("SELECT id, enabled, name, email, emailVerified, groups, epoch FROM user WHERE id = ?").get(id);
  }

  active(id: string) {
    const user = this.user(id);
    if (!user?.enabled) throw new APIError("FORBIDDEN", { message: "このユーザーは利用できません。", code: "USER_DISABLED" });
    return user;
  }

  /** Caller owns the transaction. Delete grants before sessions (whose FK is SET NULL). */
  revokeUser(id: string) {
    this.db.query("DELETE FROM oauthAccessToken WHERE userId = ?").run(id);
    this.db.query("DELETE FROM oauthRefreshToken WHERE userId = ?").run(id);
    this.db.query("DELETE FROM oauthConsent WHERE userId = ?").run(id);
    this.db.query(`DELETE FROM verification WHERE CASE WHEN json_valid(value) THEN json_extract(value, '$.userId') END = ?
      OR CASE WHEN json_valid(value) THEN json_extract(value, '$.sessionId') END IN (SELECT id FROM session WHERE userId = ?)` ).run(id, id);
    this.db.query("DELETE FROM session WHERE userId = ?").run(id);
    this.db.query("DELETE FROM kituneEnrollment WHERE userId = ?").run(id);
    this.db.query("UPDATE user SET epoch = epoch + 1 WHERE id = ?").run(id);
  }

  revokeSession(id: string) {
    this.db.query("DELETE FROM oauthAccessToken WHERE sessionId = ?").run(id);
    this.db.query("DELETE FROM oauthRefreshToken WHERE sessionId = ?").run(id);
    this.db.query("DELETE FROM verification WHERE CASE WHEN json_valid(value) THEN json_extract(value, '$.sessionId') END = ?").run(id);
  }

  /** Restore-time invalidation also discards challenges and pending OAuth state. */
  revokeAll() {
    this.db.transaction(() => {
      this.db.exec(`
        DELETE FROM oauthAccessToken;
        DELETE FROM oauthRefreshToken;
        DELETE FROM oauthConsent;
        DELETE FROM verification;
        DELETE FROM session;
        DELETE FROM kituneEnrollment;
        UPDATE user SET epoch = epoch + 1;
      `);
    }).immediate();
  }

  private revokeClient(id: string) {
    this.db.query("DELETE FROM oauthAccessToken WHERE clientId = ?").run(id);
    this.db.query("DELETE FROM oauthRefreshToken WHERE clientId = ?").run(id);
    this.db.query("DELETE FROM oauthConsent WHERE clientId = ?").run(id);
    this.db.query("DELETE FROM verification WHERE CASE WHEN json_valid(value) THEN json_extract(value, '$.query.client_id') END = ?").run(id);
  }

  reconcile(settings: Settings) {
    const { config } = settings;
    this.db.transaction(() => {
      const previousOrigin = this.db.query<{ value: string }, []>("SELECT value FROM kituneMeta WHERE key = 'origin'").get();
      if (previousOrigin && previousOrigin.value !== config.origin) throw new Error("Origin is immutable for an existing database; use a separate database for another domain");
      this.db.query("INSERT OR IGNORE INTO kituneMeta(key, value) VALUES ('origin', ?)").run(config.origin);
      const previousUsers = this.db.query<{ id: string; retired: number; fingerprint: string }, []>("SELECT * FROM kituneIdentity").all();
      for (const old of previousUsers) {
        if (!config.users.some((user) => user.id === old.id) && !old.retired) {
          this.revokeUser(old.id);
          this.db.query("UPDATE user SET enabled = 0 WHERE id = ?").run(old.id);
          this.db.query("DELETE FROM account WHERE userId = ?").run(old.id);
          this.db.query("DELETE FROM passkey WHERE userId = ?").run(old.id);
          this.db.query("UPDATE kituneIdentity SET retired = 1 WHERE id = ?").run(old.id);
        }
      }
      // Remove outdated links before inserting any new ownership assignment.
      for (const account of this.db.query<{ id: string; userId: string; accountId: string }, []>("SELECT id, userId, accountId FROM account WHERE providerId = 'discord'").all()) {
        if (!config.users.some((user) => user.id === account.userId && user.discord_ids.includes(account.accountId))) {
          this.db.query("DELETE FROM account WHERE id = ?").run(account.id);
        }
      }
      const now = new Date().toISOString();
      for (const user of config.users) {
        const old = previousUsers.find((entry) => entry.id === user.id);
        if (old?.retired) throw new Error(`Retired user ID cannot be reused: ${user.id}`);
        const fingerprint = hash(JSON.stringify({ ...user, groups: [...user.groups].sort(), discord_ids: [...user.discord_ids].sort() }));
        if (old && old.fingerprint !== fingerprint) this.revokeUser(user.id);
        this.db.query(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, enabled, groups, epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name, email=excluded.email, emailVerified=excluded.emailVerified,
          enabled=excluded.enabled, groups=excluded.groups, updatedAt=excluded.updatedAt`).run(
          user.id, user.name, user.email, Number(user.email_verified), now, now, Number(user.enabled), JSON.stringify(user.groups),
        );
        this.db.query("INSERT INTO kituneIdentity(id, fingerprint) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint").run(user.id, fingerprint);
        for (const discordId of user.discord_ids) {
          this.db.query(`INSERT INTO account(id, userId, providerId, accountId, createdAt, updatedAt) VALUES (?, ?, 'discord', ?, ?, ?)
            ON CONFLICT(providerId, accountId) DO NOTHING`).run(randomUUID(), user.id, discordId, now, now);
        }
      }
      for (const old of this.db.query<{ id: string }, []>("SELECT id FROM kituneClient").all()) {
        if (!config.clients.some((client) => client.id === old.id)) {
          this.revokeClient(old.id);
          this.db.query("UPDATE oauthClient SET disabled = 1 WHERE clientId = ?").run(old.id);
        }
      }
      for (const client of config.clients) {
        const secret = settings.clientSecrets.get(client.id);
        if (!secret) throw new Error(`Missing secret for client: ${client.id}`);
        const secretHash = hash(secret);
        const fingerprint = hash(JSON.stringify({ ...client, secretHash }));
        const old = this.db.query<{ fingerprint: string }, [string]>("SELECT fingerprint FROM kituneClient WHERE id = ?").get(client.id);
        if (old && old.fingerprint !== fingerprint) this.revokeClient(client.id);
        this.db.query(`INSERT INTO oauthClient(id, clientId, clientSecret, disabled, name, scopes, redirectUris, postLogoutRedirectUris,
          tokenEndpointAuthMethod, grantTypes, responseTypes, applicationType, requirePKCE, skipConsent, subjectType, enableEndSession, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'web', 1, ?, 'public', 1, ?, ?)
          ON CONFLICT(clientId) DO UPDATE SET clientSecret=excluded.clientSecret, disabled=excluded.disabled, name=excluded.name,
          scopes=excluded.scopes, redirectUris=excluded.redirectUris, postLogoutRedirectUris=excluded.postLogoutRedirectUris,
          tokenEndpointAuthMethod=excluded.tokenEndpointAuthMethod, grantTypes=excluded.grantTypes, requirePKCE=1,
          skipConsent=excluded.skipConsent, updatedAt=excluded.updatedAt`).run(
          randomUUID(), client.id, secretHash, Number(!client.enabled), client.name, JSON.stringify(client.scopes),
          JSON.stringify(client.redirect_uris), JSON.stringify(client.post_logout_redirect_uris), client.token_endpoint_auth_method,
          JSON.stringify(["authorization_code", ...(client.scopes.includes("offline_access") ? ["refresh_token"] : [])]),
          JSON.stringify(["code"]), Number(client.skip_consent), now, now,
        );
        this.db.query("INSERT INTO kituneClient(id, fingerprint) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint").run(client.id, fingerprint);
      }
    }).immediate();
  }

  issueEnrollment(id: string, origin: string, recover = false) {
    return this.db.transaction(() => {
      this.active(id);
      const count = this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM passkey WHERE userId = ?").get(id)!.n;
      if (count && !recover) throw new Error("Passkeys already exist; sign in to add one, or use recover to revoke existing credentials");
      if (recover) {
        this.revokeUser(id);
        this.db.query("DELETE FROM passkey WHERE userId = ?").run(id);
      }
      this.db.query("DELETE FROM kituneEnrollment WHERE userId = ? OR expiresAt <= ?").run(id, Date.now());
      const token = randomBytes(32).toString("base64url");
      this.db.query("INSERT INTO kituneEnrollment(tokenHash, userId, expiresAt, epoch) VALUES (?, ?, ?, ?)")
        .run(hash(token), id, Date.now() + 15 * 60_000, this.active(id).epoch);
      // A fragment keeps the bearer secret out of request URLs and proxy logs.
      return `${origin}/enroll#${token}`;
    }).immediate();
  }

  enrollment(token: string | null | undefined) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new APIError("FORBIDDEN", { message: "登録URLが無効か期限切れです。" });
    const entry = this.db.query<{ userId: string; epoch: number }, [string, number]>("SELECT userId, epoch FROM kituneEnrollment WHERE tokenHash = ? AND expiresAt > ?").get(hash(token), Date.now());
    if (!entry) throw new APIError("FORBIDDEN", { message: "登録URLが無効か期限切れです。" });
    const user = this.active(entry.userId);
    if (entry.epoch !== user.epoch) throw new APIError("FORBIDDEN", { message: "登録URLは失効しています。" });
    return user;
  }

  /** Run inside the Passkey plugin's registration transaction with createSession=true. */
  consumeEnrollment(token: string, userId: string) {
    const user = this.enrollment(token);
    if (user.id !== userId) throw new APIError("FORBIDDEN");
    const result = this.db.query("DELETE FROM kituneEnrollment WHERE tokenHash = ? AND userId = ? AND expiresAt > ? AND epoch = ?")
      .run(hash(token), userId, Date.now(), user.epoch);
    if (result.changes !== 1) throw new APIError("FORBIDDEN", { message: "登録URLは使用済みです。" });
  }

  backup(destination: string) {
    const target = resolve(destination);
    if (existsSync(target)) throw new Error("Backup destination already exists");
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    this.db.query("VACUUM INTO ?").run(target);
    chmodSync(target, 0o600);
    return target;
  }
}
