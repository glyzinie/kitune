import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isIP } from "node:net";
import { z } from "zod";

export const scopes = ["openid", "profile", "email", "groups", "offline_access"] as const;
const identifier = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const origin = z.url().refine((value) => {
  const url = new URL(value);
  return !url.username && !url.password && !url.search && !url.hash &&
    !isIP(url.hostname) && !url.hostname.startsWith("[") &&
    url.pathname === "/" && value === url.origin &&
    (url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost"));
}, "Use an HTTPS domain origin without a path, or HTTP localhost for development; Passkeys cannot use an IP address as the RP ID");
const redirect = z.url().refine((value) => {
  const url = new URL(value);
  return !url.username && !url.password && !value.includes("#") && !value.includes("*") &&
    (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)));
}, "Use an exact HTTPS callback URL, or an HTTP loopback callback");

const userSchema = z.strictObject({
  id: identifier,
  name: z.string().trim().min(1).max(100),
  email: z.email().transform((value) => value.toLowerCase()),
  // An administrator may assert verification; Discord never changes this profile.
  email_verified: z.boolean().default(false),
  enabled: z.boolean().default(true),
  discord_ids: z.array(z.string().regex(/^\d{17,20}$/)).default([]),
  groups: z.array(identifier).default([]),
});
const clientSchema = z.strictObject({
  id: identifier,
  name: z.string().trim().min(1).max(100),
  redirect_uris: z.array(redirect).min(1),
  post_logout_redirect_uris: z.array(redirect).default([]),
  token_endpoint_auth_method: z.enum(["client_secret_basic", "client_secret_post"], {
    error: "Only confidential clients using client_secret_basic or client_secret_post are supported",
  }).default("client_secret_basic"),
  secret_env: envName,
  scopes: z.array(z.enum(scopes)).min(1).default([...scopes]),
  skip_consent: z.boolean().default(false),
  enabled: z.boolean().default(true),
}).superRefine((client, ctx) => {
  if (!client.scopes.includes("openid")) ctx.addIssue({ code: "custom", path: ["scopes"], message: "openid is required" });
});

export const configSchema = z.strictObject({
  origin,
  name: z.string().trim().min(1).max(100).default("Kitune"),
  theme_color: z.string().regex(/^#[0-9a-f]{6}$/i, "Use a six-digit hex color, for example #2563eb").optional(),
  users: z.array(userSchema).min(1),
  clients: z.array(clientSchema).default([]),
}).superRefine((config, ctx) => {
  const unique = (values: string[], path: string) => {
    if (new Set(values).size !== values.length) ctx.addIssue({ code: "custom", path: [path], message: "Duplicate values are not allowed" });
  };
  unique(config.users.map((u) => u.id), "users");
  unique(config.users.map((u) => u.email), "users");
  unique(config.users.flatMap((u) => u.discord_ids), "users");
  unique(config.clients.map((c) => c.id), "clients");
  for (const u of config.users) unique(u.groups, "users");
  for (const c of config.clients) { unique(c.redirect_uris, "clients"); unique(c.scopes, "clients"); }
});

export type Config = z.infer<typeof configSchema>;
export type ConfigUser = Config["users"][number];
export type Environment = Record<string, string | undefined>;
export interface Settings {
  config: Config;
  databasePath: string;
  secret: string;
  discord?: { clientId: string; clientSecret: string };
  clientSecrets: Map<string, string>;
}

export function settingsFrom(config: Config, env: Environment = process.env): Settings {
  const requiredSecret = (name: string) => {
    const value = env[name];
    if (!value || value.length < 32) throw new Error(`${name} must contain at least 32 characters`);
    return value;
  };
  const hasDiscord = config.users.some((u) => u.discord_ids.length > 0);
  if (hasDiscord && (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET)) {
    throw new Error("Configured Discord identities require DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET");
  }
  return {
    config,
    databasePath: env.DATABASE_PATH ?? "./data/kitune.sqlite",
    secret: requiredSecret("BETTER_AUTH_SECRET"),
    discord: hasDiscord ? { clientId: env.DISCORD_CLIENT_ID!, clientSecret: env.DISCORD_CLIENT_SECRET! } : undefined,
    clientSecrets: new Map(config.clients.map((c) => [c.id, requiredSecret(c.secret_env)])),
  };
}

export async function loadSettings(env: Environment = process.env) {
  const file = resolve(env.CONFIG_PATH ?? "config.toml");
  const config = configSchema.parse(Bun.TOML.parse(await readFile(file, "utf8")));
  return settingsFrom(config, env);
}
