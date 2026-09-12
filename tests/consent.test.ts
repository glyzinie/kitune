import { describe, expect, test } from "bun:test";
import { consentDetails } from "../src/consent";
import { authorize, clientSecret, enroll, fixture, fixtureConfig, token } from "./helpers";

describe("OIDC consent details", () => {
  test("includes individually requested standard UserInfo claims in the displayed and accepted set", () => {
    const details = consentDetails("openid", JSON.stringify({
      userinfo: {
        sub: null,
        name: { essential: true },
        picture: null,
        given_name: null,
        family_name: null,
        email: { essential: true },
        email_verified: null,
      },
    }), ["openid", "profile", "email"]);

    expect(details).toEqual({
      scope: "openid",
      claims: { userinfo: {
        sub: null,
        name: null,
        picture: null,
        given_name: null,
        family_name: null,
        email: null,
        email_verified: null,
      } },
      labels: [
        "あなたを識別するID",
        "名前",
        "プロフィール画像",
        "名",
        "姓",
        "メールアドレス",
        "メールアドレスの確認状態",
      ],
    });
  });

  test("deduplicates scope labels and excludes unknown or non-UserInfo claims", () => {
    const details = consentDetails("openid email email unsupported", JSON.stringify({
      userinfo: { email: null, unknown: null, iss: null, ["__proto__"]: null, constructor: null },
      id_token: { email: null, acr: { essential: true, value: "0" } },
      future_extension: { arbitrary: true },
    }), ["openid", "profile", "email", "groups", "offline_access"]);

    expect(details).toEqual({
      scope: "openid email",
      claims: { userinfo: { email: null } },
      labels: ["あなたを識別するID", "メールアドレス・確認状態"],
    });
  });

  test("uses explicit empty claims when no supported individual claim was requested", () => {
    expect(consentDetails("openid", undefined, ["openid"])).toEqual({
      scope: "openid",
      claims: {},
      labels: ["あなたを識別するID"],
    });
    expect(consentDetails("openid", JSON.stringify({ userinfo: { unknown: null } }), ["openid"])?.claims).toEqual({});
  });

  test("displays individual claims independently of the corresponding scope", () => {
    expect(consentDetails("openid", JSON.stringify({ userinfo: { email: null } }), ["openid"])).toEqual({
      scope: "openid",
      claims: { userinfo: { email: null } },
      labels: ["あなたを識別するID", "メールアドレス"],
    });
  });

  test.each([
    "{",
    "null",
    "[]",
    JSON.stringify({ userinfo: [] }),
    JSON.stringify({ userinfo: { email: "required" } }),
    JSON.stringify({ userinfo: { email: [] } }),
  ])("rejects malformed claims request %s", (claims) => {
    expect(consentDetails("openid", claims, ["openid", "email"])).toBeUndefined();
  });

  test("renders and submits the same claim subset through the signed authorization flow", async () => {
    const client = { ...fixtureConfig().clients[0]!, skip_consent: false };
    const { runtime, agent } = await fixture({ clients: [client] });
    try {
      await enroll(runtime, agent);
      const claims = JSON.stringify({ userinfo: { email: { essential: true } } });
      const flow = await authorize(agent, { scope: "openid", claims });
      const consentURL = new URL(flow.location, agent.origin);
      expect(consentURL.pathname).toBe("/consent");

      const page = await agent.get(consentURL.toString());
      const html = await page.text();
      expect(page.status).toBe(200);
      expect(html).toContain("あなたを識別するID");
      expect(html).toContain("メールアドレス");
      expect(html).not.toContain("名前・ユーザー名");

      const displayed = consentDetails(consentURL.searchParams.get("scope") ?? undefined, consentURL.searchParams.get("claims") ?? undefined, client.scopes)!;
      const accepted = await agent.post("/api/auth/oauth2/consent", {
        accept: true,
        scope: displayed.scope,
        claims: displayed.claims,
        oauth_query: consentURL.search.slice(1),
      });
      expect(accepted.status).toBe(200);
      const result = await accepted.json() as { url: string };
      const code = new URL(result.url).searchParams.get("code")!;
      const tokenResponse = await token(agent, {
        grant_type: "authorization_code",
        code,
        code_verifier: flow.verifier,
        redirect_uri: "http://localhost:9000/callback",
      }, { id: "test-client", secret: clientSecret });
      expect(tokenResponse.status).toBe(200);
      const tokens = await tokenResponse.json() as { access_token: string };
      const userInfo = await agent.request("/api/auth/oauth2/userinfo", { headers: { authorization: `Bearer ${tokens.access_token}` } });
      expect(userInfo.status).toBe(200);
      expect(await userInfo.json()).toEqual({ sub: "owner", email: "owner@example.com" });

      const tampered = new URL((await authorize(agent, { scope: "openid", claims, prompt: "consent" })).location, agent.origin);
      tampered.searchParams.set("claims", JSON.stringify({ userinfo: { name: null } }));
      const tamperedDetails = consentDetails(tampered.searchParams.get("scope") ?? undefined, tampered.searchParams.get("claims") ?? undefined, client.scopes)!;
      expect((await agent.post("/api/auth/oauth2/consent", {
        accept: true,
        scope: tamperedDetails.scope,
        claims: tamperedDetails.claims,
        oauth_query: tampered.search.slice(1),
      })).status).toBe(400);

      const malformed = new URL(tampered);
      malformed.searchParams.set("claims", "{");
      expect((await agent.get(malformed.toString())).status).toBe(400);
    } finally {
      runtime.close();
    }
  });

  test("shows the provider's individual claims even for an openid-only client", async () => {
    const client = { ...fixtureConfig().clients[0]!, scopes: ["openid"], skip_consent: false };
    const { runtime, agent } = await fixture({ clients: [client] });
    try {
      await enroll(runtime, agent);
      const flow = await authorize(agent, {
        scope: "openid",
        claims: JSON.stringify({ userinfo: { email: { essential: true } } }),
      });
      const consentURL = new URL(flow.location, agent.origin);
      const page = await agent.get(consentURL.toString());
      const html = await page.text();
      expect(html).toContain("あなたを識別するID");
      expect(html).toContain("メールアドレス");

      const displayed = consentDetails(consentURL.searchParams.get("scope") ?? undefined, consentURL.searchParams.get("claims") ?? undefined, client.scopes)!;
      expect(displayed.claims).toEqual({ userinfo: { email: null } });
      const accepted = await agent.post("/api/auth/oauth2/consent", {
        accept: true,
        scope: displayed.scope,
        claims: displayed.claims,
        oauth_query: consentURL.search.slice(1),
      });
      expect(accepted.status).toBe(200);
      const result = await accepted.json() as { url: string };
      const tokenResponse = await token(agent, {
        grant_type: "authorization_code",
        code: new URL(result.url).searchParams.get("code")!,
        code_verifier: flow.verifier,
        redirect_uri: "http://localhost:9000/callback",
      }, { id: "test-client", secret: clientSecret });
      expect(tokenResponse.status).toBe(200);
      const tokens = await tokenResponse.json() as { access_token: string };
      const userInfo = await agent.request("/api/auth/oauth2/userinfo", { headers: { authorization: `Bearer ${tokens.access_token}` } });
      expect(await userInfo.json()).toEqual({ sub: "owner", email: "owner@example.com" });
    } finally {
      runtime.close();
    }
  });
});
