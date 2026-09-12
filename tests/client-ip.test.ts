import { describe, expect, test } from "bun:test";
import { clientIP, clientIPOptions, clientIPRequest } from "../src/client-ip";
import { configSchema } from "../src/config";
import { fixture } from "./helpers";

function config(overrides: Record<string, unknown> = {}) {
  return configSchema.parse({
    origin: "https://id.example.com",
    users: [{ id: "owner", name: "Owner", email: "owner@example.com" }],
    ...overrides,
  });
}

describe("trusted client IP source", () => {
  test("Fly remains the default and is the only trusted header", () => {
    const settings = config();
    expect(settings.trusted_ip_source).toBe("fly");
    expect(clientIPOptions(settings)).toEqual({ ipAddressHeaders: ["fly-client-ip"], ipv6Subnet: 64 });
    expect(clientIP(new Headers({ "Fly-Client-IP": "192.0.2.10", "X-Forwarded-For": "198.51.100.20" }), settings)).toBe("192.0.2.10");
    expect(clientIP(new Headers({ "X-Forwarded-For": "198.51.100.20" }), settings)).toBeNull();
  });

  test("reverse proxy mode trusts only an overwritten X-Forwarded-For value", () => {
    const settings = config({ trusted_ip_source: "reverse_proxy" });
    expect(clientIPOptions(settings)).toEqual({ ipAddressHeaders: ["x-forwarded-for"], ipv6Subnet: 64 });
    expect(clientIP(new Headers({ "Fly-Client-IP": "192.0.2.10", "X-Forwarded-For": "198.51.100.20" }), settings)).toBe("198.51.100.20");
    expect(clientIP(new Headers({ "Fly-Client-IP": "192.0.2.10" }), settings)).toBeNull();
  });

  test("missing, malformed, or multi-value headers fail closed", () => {
    const settings = config({ trusted_ip_source: "reverse_proxy" });
    expect(clientIP(new Headers(), settings)).toBeNull();
    expect(clientIP(new Headers({ "X-Forwarded-For": "not-an-ip" }), settings)).toBeNull();
    expect(clientIP(new Headers({ "X-Forwarded-For": "198.51.100.20, 192.0.2.10" }), settings)).toBeNull();
  });

  test("IPv6 and IPv4-mapped IPv6 use Better Auth normalization", () => {
    const settings = config({ trusted_ip_source: "reverse_proxy" });
    expect(clientIP(new Headers({ "X-Forwarded-For": "2001:DB8:1234:5678:90ab:cdef:1234:5678" }), settings))
      .toBe("2001:0db8:1234:5678:0000:0000:0000:0000");
    expect(clientIP(new Headers({ "X-Forwarded-For": "::ffff:192.0.2.10" }), settings)).toBe("192.0.2.10");
  });

  test("localhost mode ignores forwarded headers and is limited to a localhost origin", () => {
    const settings = config({ origin: "http://localhost:3000", trusted_ip_source: "localhost" });
    const options = clientIPOptions(settings);
    expect(options.ipAddressHeaders).toHaveLength(1);
    expect(clientIP(new Headers({ "Fly-Client-IP": "192.0.2.10", "X-Forwarded-For": "198.51.100.20" }), settings)).toBe("127.0.0.1");
    const request = clientIPRequest(new Request("http://localhost:3000/api/auth/jwks", { headers: { [options.ipAddressHeaders[0]!]: "192.0.2.10" } }), settings);
    expect(request.headers.get(options.ipAddressHeaders[0]!)).toBe("127.0.0.1");
    expect(() => config({ trusted_ip_source: "localhost" })).toThrow("localhost is only allowed with a localhost origin");
  });

  test("authentication routes reject requests without the selected valid source", async () => {
    const { app, runtime } = await fixture({ trusted_ip_source: "reverse_proxy" });
    const status = async (headers?: HeadersInit) => (await app.fetch(new Request("http://localhost:3000/api/auth/jwks", { headers }))).status;
    try {
      expect(await status()).toBe(400);
      expect(await status({ "Fly-Client-IP": "192.0.2.10" })).toBe(400);
      expect(await status({ "X-Forwarded-For": "198.51.100.20, 192.0.2.10" })).toBe(400);
      expect(await status({ "X-Forwarded-For": "2001:db8:1234:5678::1" })).toBe(200);
    } finally {
      runtime.close();
    }
  });
});
