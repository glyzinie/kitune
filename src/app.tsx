import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { setCookie } from "hono/cookie";
import { APIError } from "better-auth/api";
import type { Child } from "hono/jsx";
import { assertFresh, ENROLLMENT_COOKIE, type Runtime } from "./auth";
import { consentDetails } from "./consent";
import { themeStyles } from "./theme";
import { clientIP, clientIPRequest } from "./client-ip";

const publicAssetTypes = new Map([
  ["client.js", "text/javascript; charset=utf-8"],
  ["style.css", "text/css; charset=utf-8"],
  ["favicon.svg", "image/svg+xml"],
]);

function Icon({ name }: { name: "passkey" | "discord" | "person" | "devices" | "logout" | "add" | "edit" | "delete" }) {
  if (name === "discord") return <img class="icon icon-discord" src="https://cdn.prod.website-files.com/6257adef93867e50d84d30e2/66e3d80db9971f10a9757c99_Symbol.svg" width="65" height="48" alt="" aria-hidden="true" decoding="async" referrerpolicy="no-referrer"/>;
  return <span class={`icon icon-${name}`} aria-hidden="true"></span>;
}

function Shell({ name, title, children, wide = false }: { name: string; title: string; children: Child; wide?: boolean }) {
  return <html lang="ja"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=LINE+Seed+JP:wght@400;700;800&display=swap" referrerpolicy="no-referrer"/>
    <title>{title} · {name}</title><link rel="icon" type="image/svg+xml" href="/assets/favicon.svg"/><link rel="stylesheet" href="/assets/style.css"/><script type="module" src="/assets/client.js"></script>
  </head><body><header class="site-header"><a href="/" class="brand"><span class="brand-mark" aria-hidden="true">🦊</span>{name}</a><span class="header-note">自分のための、認証基盤。</span></header>
    <main class={wide ? "page page-wide" : "page"}>{children}<p id="status" role="status" aria-live="polite"></p></main>
    <footer>あなたのアカウントを、あなたの手で。</footer></body></html>;
}

export function createApp(runtime: Runtime) {
  const { auth, store, settings } = runtime;
  const { config } = settings;
  const themeCss = themeStyles(config);
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ message: "リクエストが大きすぎます。" }, 413) }));
  app.use("*", secureHeaders({
    contentSecurityPolicy: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "https://fonts.googleapis.com"], fontSrc: ["'self'", "https://fonts.gstatic.com"], imgSrc: ["'self'", "data:", "https://fonts.gstatic.com", "https://cdn.prod.website-files.com"], connectSrc: ["'self'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'self'"] },
    referrerPolicy: "no-referrer",
    strictTransportSecurity: config.origin.startsWith("https:") ? "max-age=31536000" : false,
    permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
  }));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof APIError) return c.json({ message: error.body?.message ?? "この操作は許可されていません。", code: error.body?.code }, error.statusCode as 400);
    // Do not log requests, OAuth query strings, cookies, or provider responses.
    console.error("request_failed", error.name);
    return c.json({ message: "処理に失敗しました。もう一度お試しください。" }, 500);
  });
  app.get("/healthz", (c) => {
    store.db.query("SELECT 1").get();
    return c.json({ status: "ok" });
  });
  app.get("/assets/:file", async (c) => {
    const name = c.req.param("file");
    const contentType = publicAssetTypes.get(name);
    if (!contentType) return c.notFound();
    const file = Bun.file(new URL(`../dist/${name}`, import.meta.url));
    if (!await file.exists()) return c.notFound();
    const body = name === "style.css" ? `${await file.text()}\n${themeCss}` : file;
    return new Response(body, { headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    } });
  });
  app.all("/api/auth/*", (c) => {
    if (!clientIP(c.req.raw, config)) throw new APIError("BAD_REQUEST", { message: "接続元IPを確認できません。プロキシ設定を確認してください。" });
    return auth.handler(clientIPRequest(c.req.raw, config));
  });
  app.get("/.well-known/oauth-authorization-server/api/auth", (c) => auth.handler(clientIPRequest(c.req.raw, config)));

  const sessionFor = async (request: Request, fresh = false) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) throw new APIError("UNAUTHORIZED", { message: "ログインしてください。" });
    const user = store.active(session.user.id);
    if (session.session.epoch !== user.epoch) throw new APIError("UNAUTHORIZED");
    if (fresh) assertFresh(session.session.createdAt);
    return session;
  };
  app.get("/", async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    return c.redirect(session ? "/account" : "/login");
  });
  app.get("/login", (c) => c.html(<Shell name={config.name} title="ログイン"><section class="card login-card">
    <p class="eyebrow">YOUR PERSONAL IDENTITY</p><h1>おかえりなさい。</h1><p class="lede">Passkeyで、いつものサービスへ。</p>
    {c.req.query("error") && <p class="notice">ログインできませんでした。許可されたアカウントを選ぶか、もう一度お試しください。</p>}
    <button class="primary full with-icon" data-action="login-passkey"><Icon name="passkey"/>Passkeyでログイン</button>
    {settings.discord && <><div class="divider"><span>または</span></div><button class="secondary full with-icon" data-action="login-discord"><Icon name="discord"/>Discordでログイン</button></>}
    <p class="help">端末の指紋・顔認証やPINを使います。<br/>初めての方は、管理者から受け取った登録URLを開いてください。</p>
    <button class="text-button" data-action="switch-account">別のアカウントを使う</button>
  </section></Shell>));
  app.get("/enroll", (c) => c.html(<Shell name={config.name} title="Passkeyの初回登録"><section class="card login-card">
    <p class="eyebrow">FIRST STEP</p><h1>あなたのPasskeyを。</h1><p class="lede">この端末やパスワードマネージャーに保存して、<br/>パスワードなしでログインできます。</p>
    <button class="primary full with-icon" data-action="enroll"><Icon name="passkey"/>Passkeyを登録する</button><p class="help">登録URLは発行から15分間有効です。<br/>登録が完了すると再利用できなくなります。<br/>登録をキャンセルした場合は、期限内にやり直せます。</p>
    <p class="help">保存先に応じた名前を自動で設定します。名前はあとで変更できます。</p>
    <a class="subtle-link" href="/login">ログイン画面へ</a>
  </section></Shell>));

  const enrollmentAttempts = new Map<string, { count: number; until: number }>();
  app.post("/enrollment", async (c) => {
    if (c.req.header("origin") !== config.origin) throw new APIError("FORBIDDEN");
    const ip = clientIP(c.req.raw, config);
    if (!ip) throw new APIError("BAD_REQUEST", { message: "接続元IPを確認できません。プロキシ設定を確認してください。" });
    const now = Date.now();
    for (const [key, value] of enrollmentAttempts) if (value.until <= now) enrollmentAttempts.delete(key);
    const attempt = enrollmentAttempts.get(ip) ?? { count: 0, until: now + 60_000 };
    if (attempt.count >= 5 || (enrollmentAttempts.size >= 1000 && !enrollmentAttempts.has(ip))) return c.json({ message: "少し待ってからやり直してください。" }, 429);
    attempt.count++;
    enrollmentAttempts.set(ip, attempt);
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.token !== "string") throw new APIError("BAD_REQUEST");
    const user = store.enrollment(body.token);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (session && session.user.id !== user.id) throw new APIError("FORBIDDEN", { message: "一度ログアウトしてから、登録URLを開き直してください。" });
    setCookie(c, ENROLLMENT_COOKIE, body.token, { httpOnly: true, secure: config.origin.startsWith("https:"), sameSite: "Strict", path: "/api/auth/passkey", maxAge: 15 * 60 });
    return c.json({ name: user.name });
  });

  app.get("/account", async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.redirect("/login");
    const user = store.active(session.user.id);
    const passkeys = await auth.api.listPasskeys({ headers: c.req.raw.headers });
    const sessions = await auth.api.listSessions({ headers: c.req.raw.headers }).catch((error: unknown) => {
      if (error instanceof APIError && error.body?.code === "SESSION_NOT_FRESH") return null;
      throw error;
    });
    const discord = store.db.query<{ accountId: string }, [string]>("SELECT accountId FROM account WHERE userId = ? AND providerId = 'discord' ORDER BY accountId").all(user.id);
    return c.html(<Shell name={config.name} title="アカウント" wide><div class="page-heading"><div><p class="eyebrow">YOUR ACCOUNT</p><h1>{user.name}</h1><p class="lede">ログイン方法と、利用中の端末を管理します。</p></div><button class="secondary with-icon" data-action="logout"><Icon name="logout"/>ログアウト</button></div>
      <div class="account-grid"><section class="card"><h2 class="icon-heading"><Icon name="passkey"/>Passkey</h2><p class="section-note">予備の端末にも登録しておくと安心です。</p>
        <ul class="item-list">{passkeys.map((key) => <li><div><strong>{key.name || "名前のないPasskey"}</strong><small>{key.backedUp ? "同期されたPasskey" : "端末・セキュリティキー"}</small></div><div class="row-actions"><button class="text-button with-icon" data-action="rename-passkey" data-id={key.id} data-name={key.name || ""}><Icon name="edit"/>名前変更</button><button class="text-button danger with-icon" data-action="delete-passkey" data-id={key.id}><Icon name="delete"/>削除</button></div></li>)}</ul>
        {!passkeys.length && <p class="empty">Passkeyはまだ登録されていません。</p>}
        <button class="primary with-icon" data-action="add-passkey"><Icon name="add"/>Passkeyを追加</button><p class="help">保存先に応じた名前を自動で設定します。名前はあとで変更できます。</p>
        <p class="help">ログインから10分を過ぎた場合は、変更前に<a href="/login">もう一度ログイン</a>してください。</p>
      </section><aside class="card profile-card"><h2 class="icon-heading"><Icon name="person"/>プロフィール</h2><dl><dt>ユーザーID</dt><dd>{user.id}</dd><dt>メールアドレス</dt><dd>{user.email}</dd><dt>Kituneでの所属グループ</dt><dd>{(JSON.parse(user.groups) as string[]).join("、") || "なし"}</dd></dl><h2 class="icon-heading"><Icon name="discord"/>Discord</h2>{discord.length ? <ul class="discord-list">{discord.map((account) => <li>{account.accountId}</li>)}</ul> : <p class="section-note">連携なし</p>}<p class="help">プロフィールとDiscordの連携は管理者が設定します。</p></aside></div>
      <section class="card sessions-card"><h2 class="icon-heading"><Icon name="devices"/>ログイン中の端末</h2>
        {sessions ? <ul class="item-list">{sessions.map((entry) => <li><div><strong>{entry.id === session.session.id ? "この端末" : "別の端末"}</strong><small>{entry.userAgent || "端末情報なし"}</small><small>ログイン：{new Date(entry.createdAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}</small></div><button class="text-button danger with-icon" data-action="revoke-session" data-id={entry.id}><Icon name="logout"/>ログアウト</button></li>)}</ul>
          : <p class="section-note">ログイン中の端末を確認するには、<a href="/login">もう一度ログイン</a>してください。</p>}
      </section>
    </Shell>);
  });

  app.use("/account/*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.header("origin") !== config.origin) throw new APIError("FORBIDDEN");
    await next();
  });
  app.post("/account/passkeys/:id/delete", async (c) => {
    const session = await sessionFor(c.req.raw, true);
    store.db.transaction(() => {
      const keys = store.db.query<{ id: string }, [string]>("SELECT id FROM passkey WHERE userId = ?").all(session.user.id);
      if (!keys.some((key) => key.id === c.req.param("id"))) throw new APIError("NOT_FOUND");
      const discord = store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM account WHERE userId = ? AND providerId = 'discord'").get(session.user.id)!.n;
      if (keys.length === 1 && !discord) throw new APIError("BAD_REQUEST", { message: "最後のログイン方法は削除できません。先に予備のPasskeyを登録してください。" });
      store.db.query("DELETE FROM passkey WHERE id = ? AND userId = ?").run(c.req.param("id"), session.user.id);
    }).immediate();
    return c.json({ success: true });
  });
  app.post("/account/sessions/:id/delete", async (c) => {
    const session = await sessionFor(c.req.raw, true);
    const target = store.db.query<{ token: string }, [string, string]>("SELECT token FROM session WHERE id = ? AND userId = ?").get(c.req.param("id"), session.user.id);
    if (!target) throw new APIError("NOT_FOUND");
    await auth.api.revokeSession({ headers: c.req.raw.headers, body: { token: target.token } });
    return c.json({ success: true, current: c.req.param("id") === session.session.id });
  });
  app.get("/consent", async (c) => {
    const client = config.clients.find((client) => client.id === c.req.query("client_id") && client.enabled);
    if (!client || !client.redirect_uris.includes(c.req.query("redirect_uri") ?? "")) return c.text("認証リクエストが無効です。サービスからやり直してください。", 400);
    const consent = consentDetails(c.req.query("scope"), c.req.query("claims"), client.scopes);
    if (!consent) return c.text("認証リクエストが無効です。サービスからやり直してください。", 400);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.redirect(`/login?${new URL(c.req.url).searchParams}`);
    return c.html(<Shell name={config.name} title="サービスへの接続"><section class="card login-card"><p class="eyebrow">CONNECT A SERVICE</p><h1>{client.name}に接続</h1><p class="lede">{session.user.name}として接続します。共有する情報と、許可する操作を確認してください。</p>
      <ul class="scope-list">{consent.labels.map((label) => <li>{label}</li>)}</ul>
      <p class="help">接続先：{new URL(c.req.query("redirect_uri")!).host}</p><button class="primary full" data-action="consent-accept" data-consent-scope={consent.scope} data-consent-claims={JSON.stringify(consent.claims)}>許可して続ける</button><button class="secondary full" data-action="consent-deny">キャンセル</button>
    </section></Shell>);
  });
  app.notFound((c) => c.html(<Shell name={config.name} title="ページが見つかりません"><section class="card"><h1>ページが見つかりません。</h1><a href="/">ホームへ戻る</a></section></Shell>, 404));
  return app;
}
