import { expect, test } from "bun:test";
import { createRuntime } from "../src/auth";
import { createApp } from "../src/app";
import { Agent, enroll, fixtureSettings } from "./helpers";

for (const source of ["fly", "reverse_proxy"] as const) {
  test(`${source}: enrollment and Better Auth isolate clients using only the configured proxy header`, async () => {
    const runtime = await createRuntime(fixtureSettings({ trusted_ip_source: source }), { testing: true });
    const app = createApp(runtime);
    const header = source === "fly" ? "fly-client-ip" : "x-forwarded-for";
    const ignored = source === "fly" ? "x-forwarded-for" : "fly-client-ip";
    let ignoredIP = 1;
    const makeAgent = (ip: string) => new Agent((request) => {
      request.headers.set(header, ip);
      request.headers.set(ignored, `203.0.113.${ignoredIP++}`);
      return app.fetch(request);
    }, runtime.settings.config.origin);
    try {
      const first = makeAgent("192.0.2.10"), second = makeAgent("192.0.2.20");
      for (let i = 0; i < 5; i++) expect((await first.post("/enrollment", { token: "invalid" })).status).toBe(403);
      expect((await first.post("/enrollment", { token: "invalid" })).status).toBe(429);
      await enroll(runtime, second);
      const session = await (await second.get("/api/auth/get-session")).json();
      expect(session.session.ipAddress).toBe("192.0.2.20");

      const context = await runtime.auth.$context;
      context.rateLimit.enabled = true;
      context.rateLimit.max = 2;
      expect((await first.get("/api/auth/get-session")).status).toBe(200);
      expect((await first.get("/api/auth/get-session")).status).toBe(200);
      expect((await first.get("/api/auth/get-session")).status).toBe(429);
      expect((await second.get("/api/auth/get-session")).status).toBe(200);

      for (const value of [undefined, "not-an-ip", "192.0.2.30, 192.0.2.40"]) {
        const headers = new Headers({ [ignored]: "192.0.2.50", origin: runtime.settings.config.origin, "content-type": "application/json" });
        if (value !== undefined) headers.set(header, value);
        expect((await app.request("/api/auth/get-session", { headers })).status).toBe(400);
        expect((await app.request("/enrollment", { method: "POST", headers, body: JSON.stringify({ token: "invalid" }) })).status).toBe(400);
      }
    } finally { runtime.close(); }
  });
}

test("localhost: enrollment and Better Auth share the fixed loopback client", async () => {
  const runtime = await createRuntime(fixtureSettings(), { testing: true });
  const app = createApp(runtime);
  let forwardedIP = 1;
  const makeAgent = () => new Agent((request) => {
    request.headers.set("x-kitune-localhost-ip", `198.51.100.${forwardedIP}`);
    request.headers.set("fly-client-ip", `192.0.2.${forwardedIP}`);
    request.headers.set("x-forwarded-for", `203.0.113.${forwardedIP++}`);
    return app.fetch(request);
  }, runtime.settings.config.origin);
  try {
    const first = makeAgent(), second = makeAgent();
    await enroll(runtime, first);
    const session = await (await first.get("/api/auth/get-session")).json();
    expect(session.session.ipAddress).toBe("127.0.0.1");

    const context = await runtime.auth.$context;
    context.rateLimit.enabled = true;
    context.rateLimit.max = 2;
    expect((await first.get("/api/auth/get-session")).status).toBe(200);
    expect((await first.get("/api/auth/get-session")).status).toBe(200);
    expect((await second.get("/api/auth/get-session")).status).toBe(429);
  } finally { runtime.close(); }
});
