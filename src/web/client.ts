import { createAuthClient } from "better-auth/client";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";

const auth = createAuthClient({ plugins: [oauthProviderClient()] });
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const enrollmentToken = location.pathname === "/enroll" ? location.hash.slice(1) : "";
if (enrollmentToken) history.replaceState(null, "", "/enroll");

async function api<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  const result = await auth.$fetch<T>(path, { method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body }) });
  if (result.error) throw new Error(result.error.message || "処理に失敗しました。サービスからやり直してください。");
  return result.data as T;
}
async function local(path: string, body = {}) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || "処理に失敗しました。");
  return result;
}
function finish(result: Record<string, unknown>) {
  const target = result.redirect_uri ?? result.url;
  // Targets come only from the server's validated OAuth response, never location.search.
  location.assign(typeof target === "string" ? target : "/account");
}
async function register(enroll: boolean) {
  if (enroll) {
    if (!enrollmentToken) throw new Error("管理者から受け取った登録URLを開き直してください。");
    await local("/enrollment", { token: enrollmentToken });
  }
  const options = await api<PublicKeyCredentialCreationOptionsJSON>("/passkey/generate-register-options");
  const response = await startRegistration({ optionsJSON: options });
  const result = await api("/passkey/verify-registration", { response, createSession: enroll });
  finish(result);
}

document.addEventListener("click", async (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("button[data-action]");
  if (!button || button.disabled) return;
  status.textContent = "";
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    switch (button.dataset.action) {
      case "login-passkey": {
        const options = await api<PublicKeyCredentialRequestOptionsJSON>("/passkey/generate-authenticate-options");
        const response = await startAuthentication({ optionsJSON: { ...options, userVerification: "required" } });
        finish(await api("/passkey/verify-authentication", { response }));
        break;
      }
      case "login-discord": {
        finish(await api("/sign-in/social", { provider: "discord", callbackURL: "/account", errorCallbackURL: "/login?error=discord" }));
        break;
      }
      case "enroll": await register(true); break;
      case "add-passkey": await register(false); break;
      case "logout": await api("/sign-out", {}); location.assign("/login"); break;
      case "switch-account": await api("/sign-out", {}); status.textContent = "ログアウトしました。別のアカウントでログインできます。"; break;
      case "rename-passkey": {
        const name = prompt("Passkeyの名前", button.dataset.name || "Passkey");
        if (!name?.trim()) break;
        if (name.length > 100) throw new Error("名前は100文字以内にしてください。");
        await api("/passkey/update-passkey", { id: button.dataset.id, name: name.trim() });
        location.reload(); break;
      }
      case "delete-passkey": {
        if (!confirm("このPasskeyを削除しますか？")) break;
        await local(`/account/passkeys/${encodeURIComponent(button.dataset.id!)}/delete`);
        location.reload(); break;
      }
      case "revoke-session": {
        const result = await local(`/account/sessions/${encodeURIComponent(button.dataset.id!)}/delete`);
        location.assign(result.current ? "/login" : "/account"); break;
      }
      case "consent-accept": {
        if (button.dataset.consentScope === undefined || button.dataset.consentClaims === undefined) throw new Error("認証リクエストが無効です。サービスからやり直してください。");
        finish(await api("/oauth2/consent", { accept: true, scope: button.dataset.consentScope, claims: JSON.parse(button.dataset.consentClaims) })); break;
      }
      case "consent-deny":
        finish(await api("/oauth2/consent", { accept: false })); break;
    }
  } catch (error) {
    status.textContent = error instanceof Error && error.name === "NotAllowedError"
      ? "操作をキャンセルしたか、時間が経過しました。もう一度お試しください。"
      : error instanceof Error ? error.message : "処理に失敗しました。";
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
});
