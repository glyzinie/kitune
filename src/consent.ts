const scopeLabels = {
  openid: "あなたを識別するID",
  profile: "名前・ユーザー名",
  email: "メールアドレス・確認状態",
  groups: "ローカルグループ",
  offline_access: "ログイン状態の更新",
} as const;

// Better Auth 1.7.4 can resolve these OIDC Standard Claims individually at
// UserInfo even when their usual profile/email scope was not requested.
const userInfoClaimLabels = {
  sub: { label: "あなたを識別するID", scope: "openid" },
  name: { label: "名前", scope: "profile" },
  picture: { label: "プロフィール画像", scope: "profile" },
  given_name: { label: "名", scope: "profile" },
  family_name: { label: "姓", scope: "profile" },
  email: { label: "メールアドレス", scope: "email" },
  email_verified: { label: "メールアドレスの確認状態", scope: "email" },
} as const;

export interface ConsentDetails {
  scope: string;
  claims: { userinfo?: Record<string, null> };
  labels: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function userInfoClaims(value: string | undefined): string[] | undefined {
  if (value === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return;
  }
  if (!isRecord(parsed)) return;
  if (parsed.userinfo === undefined) return [];
  if (!isRecord(parsed.userinfo)) return;
  if (!Object.values(parsed.userinfo).every((member) => member === null || isRecord(member))) return;
  return Object.keys(parsed.userinfo);
}

/**
 * Normalizes the consent page's displayed permissions and the exact subset
 * submitted to Better Auth. Individual OIDC claims are independent of scopes;
 * unsupported UserInfo claims are not accepted. Better Auth independently
 * checks this subset against its signed authorization query.
 */
export function consentDetails(scopeValue: string | undefined, claimsValue: string | undefined, allowedScopes: readonly string[]): ConsentDetails | undefined {
  const claims = userInfoClaims(claimsValue);
  if (!claims) return;

  const allowed = new Set(allowedScopes);
  const scopes = [...new Set((scopeValue ?? "").split(" ").filter((scope) => allowed.has(scope) && Object.hasOwn(scopeLabels, scope)))];
  const labels = new Set<string>(scopes.map((scope) => scopeLabels[scope as keyof typeof scopeLabels]));
  const userinfo: Record<string, null> = {};
  for (const claim of claims) {
    if (!Object.hasOwn(userInfoClaimLabels, claim)) continue;
    const definition = userInfoClaimLabels[claim as keyof typeof userInfoClaimLabels];
    userinfo[claim] = null;
    if (!scopes.includes(definition.scope)) labels.add(definition.label);
  }

  return {
    scope: scopes.join(" "),
    claims: Object.keys(userinfo).length ? { userinfo } : {},
    labels: [...labels],
  };
}
