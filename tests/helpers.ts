import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createRuntime, type Runtime } from "../src/auth";
import { createApp } from "../src/app";
import { configSchema, settingsFrom } from "../src/config";

export const testSecret = "c5ded72fc1ce76bfbc703622b20f315e96682de613630b427f2af56e84c6c99775";
export const clientSecret = "2a08012b01e3bb729b70d1c1973b0db1f40f7c9f581494f298325550903d3f32b";
export function fixtureConfig(overrides: Record<string, unknown> = {}) {
  return configSchema.parse({
    origin: "http://localhost:3000",
    trusted_ip_source: "localhost",
    users: [
      { id: "owner", name: "Owner", email: "owner@example.com", email_verified: true, discord_ids: ["111111111111111111", "222222222222222222"], groups: ["personal", "reader"] },
      { id: "alternate", name: "Alternate", email: "alt@example.com", discord_ids: ["333333333333333333"], groups: [] },
    ],
    clients: [{ id: "test-client", name: "Test client", redirect_uris: ["http://localhost:9000/callback"], secret_env: "TEST_CLIENT_SECRET", skip_consent: true }],
    ...overrides,
  });
}
export function fixtureSettings(overrides: Record<string, unknown> = {}, databasePath = ":memory:") {
  return settingsFrom(fixtureConfig(overrides), { BETTER_AUTH_SECRET: testSecret, DATABASE_PATH: databasePath, DISCORD_CLIENT_ID: "123456789", DISCORD_CLIENT_SECRET: "test-discord-client-secret", TEST_CLIENT_SECRET: clientSecret });
}
export async function fixture(overrides: Record<string, unknown> = {}, databasePath = ":memory:") {
  const runtime = await createRuntime(fixtureSettings(overrides, databasePath), { testing: true });
  const app = createApp(runtime);
  return { runtime, app, agent: new Agent((request) => app.fetch(request), runtime.settings.config.origin) };
}

export class Agent {
  readonly cookies = new Map<string, string>();
  constructor(readonly send: (request: Request) => Response | Promise<Response>, readonly origin: string) {}
  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    if (init.method && init.method !== "GET" && !headers.has("origin")) headers.set("origin", this.origin);
    const response = await this.send(new Request(new URL(path, this.origin), { ...init, headers, redirect: "manual" }));
    for (const cookie of response.headers.getSetCookie()) {
      const part = cookie.split(";")[0]!;
      const index = part.indexOf("=");
      const name = part.slice(0, index), value = part.slice(index + 1);
      if (!value || /max-age=0/i.test(cookie)) this.cookies.delete(name); else this.cookies.set(name, value);
    }
    return response;
  }
  get(path: string) { return this.request(path); }
  post(path: string, body: unknown) { return this.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
}

const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest();
function cbor(value: number | string | Uint8Array | Map<unknown, unknown>): Buffer {
  const head = (major: number, length: number) => {
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 256) return Buffer.from([(major << 5) | 24, length]);
    const data = Buffer.alloc(3); data[0] = (major << 5) | 25; data.writeUInt16BE(length, 1); return data;
  };
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") { const bytes = Buffer.from(value); return Buffer.concat([head(3, bytes.length), bytes]); }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  return Buffer.concat([head(5, value.size), ...[...value].flatMap(([key, value]) => [cbor(key as number), cbor(value as number)])]);
}

/** An independent software authenticator: real P-256 signatures and WebAuthn wire data. */
export class Authenticator {
  constructor(readonly aaguid = "00000000-0000-0000-0000-000000000000") {}
  private readonly pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  readonly id = randomBytes(32);
  counter = 0;
  userHandle = "";

  registration(options: { challenge: string; rp: { id: string }; user: { id: string } }, origin: string, uv = true) {
    this.userHandle = options.user.id;
    const jwk = this.pair.publicKey.export({ format: "jwk" });
    const cose = cbor(new Map<unknown, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
    const length = Buffer.alloc(2); length.writeUInt16BE(this.id.length);
    const authData = Buffer.concat([sha256(options.rp.id), Buffer.from([uv ? 0x45 : 0x41]), Buffer.alloc(4), Buffer.from(this.aaguid.replaceAll("-", ""), "hex"), length, this.id, cose]);
    const attestation = cbor(new Map<unknown, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false }));
    return {
      id: this.id.toString("base64url"), rawId: this.id.toString("base64url"), type: "public-key",
      response: { clientDataJSON: clientData.toString("base64url"), attestationObject: attestation.toString("base64url"), transports: ["internal"] },
      clientExtensionResults: {}, authenticatorAttachment: "platform",
    };
  }
  assertion(options: { challenge: string; rpId: string }, origin: string, uv = true) {
    const count = Buffer.alloc(4); count.writeUInt32BE(++this.counter);
    const authData = Buffer.concat([sha256(options.rpId), Buffer.from([uv ? 0x05 : 0x01]), count]);
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }));
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientData)]), this.pair.privateKey);
    return {
      id: this.id.toString("base64url"), rawId: this.id.toString("base64url"), type: "public-key",
      response: { clientDataJSON: clientData.toString("base64url"), authenticatorData: authData.toString("base64url"), signature: signature.toString("base64url"), userHandle: this.userHandle },
      clientExtensionResults: {}, authenticatorAttachment: "platform",
    };
  }
}

export async function prepareEnrollment(runtime: Runtime, agent: Agent, userId = "owner", token?: string) {
  token ??= runtime.store.issueEnrollment(userId, agent.origin).split("#")[1]!;
  const exchanged = await agent.post("/enrollment", { token });
  if (exchanged.status !== 200) throw new Error(`Enrollment exchange: ${exchanged.status} ${await exchanged.text()}`);
  const response = await agent.get("/api/auth/passkey/generate-register-options");
  if (response.status !== 200) throw new Error(`Registration options: ${response.status} ${await response.text()}`);
  return { token, options: await response.json() };
}

export async function enroll(runtime: Runtime, agent: Agent, userId = "owner") {
  const { options } = await prepareEnrollment(runtime, agent, userId);
  const key = new Authenticator();
  const response = await agent.post("/api/auth/passkey/verify-registration", { response: key.registration(options, agent.origin), createSession: true, name: "Primary key" });
  if (response.status !== 200) throw new Error(`Registration: ${response.status} ${await response.text()}`);
  return key;
}

export async function authorize(agent: Agent, additional: Record<string, string> = {}) {
  const verifier = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({ client_id: "test-client", redirect_uri: "http://localhost:9000/callback", response_type: "code", scope: "openid profile email groups offline_access", state: "test-state", nonce: "test-nonce", code_challenge_method: "S256", code_challenge: sha256(verifier).toString("base64url"), ...additional });
  const response = await agent.get(`/api/auth/oauth2/authorize?${params}`);
  const location = response.headers.get("location");
  if (!location) throw new Error(`Authorize: ${response.status} ${await response.text()}`);
  return { verifier, params, location, response };
}
export async function token(agent: Agent, body: Record<string, string>, client: {
  id: string; secret: string; method?: "client_secret_basic" | "client_secret_post";
} = { id: "test-client", secret: clientSecret }) {
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  const form = new URLSearchParams(body);
  if (client.method === "client_secret_post") {
    form.set("client_id", client.id);
    form.set("client_secret", client.secret);
  } else headers.set("authorization", `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString("base64")}`);
  return agent.request("/api/auth/oauth2/token", { method: "POST", headers, body: form });
}
export async function grant(agent: Agent) {
  const flow = await authorize(agent);
  const code = new URL(flow.location, agent.origin).searchParams.get("code");
  if (!code) throw new Error(`Missing authorization code: ${flow.location}`);
  const response = await token(agent, { grant_type: "authorization_code", code, code_verifier: flow.verifier, redirect_uri: "http://localhost:9000/callback" });
  if (response.status !== 200) throw new Error(`Token: ${response.status} ${await response.text()}`);
  return await response.json() as { access_token: string; refresh_token: string; id_token: string };
}
