# WebサービスのOIDC接続例

3サービスには独立したクライアントIDとsecretを発行します。secretはそれぞれ32文字以上にし、Kituneでは別の環境変数から読み込みます。基本scopeは `openid profile email`、Kitune側のtoken endpoint認証は `client_secret_basic` を初期設定とします。接続先がPOSTを使う場合は、そのクライアントだけ `client_secret_post` に変更します。

ここに示すのは設定互換性を確認するための例です。Headscale、Gitea、Tailscale自体の導入、既存アカウントの移行、実サービスへの接続結果は含みません。

## Headscale 0.29.3

Kituneでは `require_pkce` を省略し、既定のS256必須を使います。

```toml
[[clients]]
id = "headscale"
name = "Headscale"
redirect_uris = ["https://headscale.example.com/oidc/callback"]
secret_env = "HEADSCALE_CLIENT_SECRET"
scopes = ["openid", "profile", "email"]
skip_consent = false
```

Headscale側ではKituneのissuerと同じclient ID・secretを設定し、PKCEを明示的に有効にします。

```yaml
oidc:
  issuer: "https://id.example.com/api/auth"
  client_id: "headscale"
  client_secret: "KituneのHEADSCALE_CLIENT_SECRETと同じ値"
  scope: ["openid", "profile", "email"]
  pkce:
    enabled: true
    method: S256
```

callbackは `https://headscale.example.com/oidc/callback` です。HeadscaleはPKCEに対応していますが、0.29.3の既定は無効なので `pkce.enabled: true` を省略しません。詳細は[HeadscaleのOIDC設定](https://headscale.net/stable/ref/oidc/)を参照してください。

## Gitea 1.27.3

Giteaの外部OpenID ConnectクライアントはPKCEとnonceを送信しないため、このクライアントだけPKCE必須を解除します。`offline_access` は設定しません。

```toml
[[clients]]
id = "gitea"
name = "Gitea"
redirect_uris = ["https://gitea.example.com/user/oauth2/kitune/callback"]
secret_env = "GITEA_CLIENT_SECRET"
scopes = ["openid", "profile", "email"]
require_pkce = false
skip_consent = false
```

Giteaの管理画面ではOAuth2認証ソースを次の値で追加します。認証ソース名 `kitune` はcallbackのパスに使われるため、変更する場合はKitune側の `redirect_uris` も同じ名前へ変更します。

| 項目 | 値 |
| --- | --- |
| 認証タイプ | OAuth2 |
| OAuth2プロバイダー | OpenID Connect |
| 認証ソース名 | `kitune` |
| Client ID | `gitea` |
| Client secret | Kituneの `GITEA_CLIENT_SECRET` と同じ値 |
| Auto Discovery URL | `https://id.example.com/api/auth/.well-known/openid-configuration` |
| Scope | `openid,profile,email` |

GiteaはID tokenのclaimを確認した後にUserInfoを取得し、メールやプロフィールを補います。KituneのID tokenへ製品固有のclaimを追加する必要はありません。この挙動とPKCE・nonceを送らない実装は、[Gitea 1.27.3のOpenID Connect provider](https://github.com/go-gitea/gitea/blob/v1.27.3/services/auth/source/oauth2/providers_openid.go#L39-L56)と、同版が利用する[GothのOpenID Connect実装](https://github.com/markbates/goth/blob/v1.82.0/providers/openidConnect/openidConnect.go#L214-L254)で確認できます。GiteaのScope欄は[実装どおり](https://github.com/go-gitea/gitea/blob/v1.27.3/routers/web/admin/auths.go#L182-L198)カンマで区切ります。

## Tailscale

Tailscaleの実挙動を確認するまでは、PKCEなしでも接続できる互換性設定にします。

```toml
[[clients]]
id = "tailscale"
name = "Tailscale"
redirect_uris = ["https://login.tailscale.com/a/oauth_response"]
token_endpoint_auth_method = "client_secret_basic"
secret_env = "TAILSCALE_CLIENT_SECRET"
scopes = ["openid", "profile", "email"]
require_pkce = false
skip_consent = false
```

Tailscaleにはclient ID `tailscale` と、Kituneの `TAILSCALE_CLIENT_SECRET` と同じsecretを設定します。issuer `https://id.example.com/api/auth` は、利用者のメールドメインにあるWebFingerから検出されます。callbackは `https://login.tailscale.com/a/oauth_response` です。

実際の設定画面にある「Select prompt behavior (optional)」は **Default** を選びます。画面の説明では、認可サーバーがセッションと過去の同意に応じて判断する標準ログイン向けの選択です。`Silent` は有効なセッションや既存同意がないと失敗し、`Prompted` で `consent` を選ぶと権限の再承認を要求します。この画面選択を使ったKituneへの実ログインは未確認です。

Tailscaleが利用者のメールドメインからKituneを見つけられるよう、`https://example.com/.well-known/webfinger?resource=acct:user@example.com` で次のJRDを返します。hrefはKitune Discoveryの `issuer` とパスまで完全に一致させます。

```json
{
  "subject": "acct:user@example.com",
  "links": [
    {
      "rel": "http://openid.net/specs/connect/1.0/issuer",
      "href": "https://id.example.com/api/auth"
    }
  ]
}
```

詳細は[TailscaleのCustom OIDC](https://tailscale.com/kb/1240/sso-custom-oidc)を参照してください。

公式資料では、Tailscaleが認可要求へPKCEを付けるか、汎用OIDCでBasic認証を使うか、パス付きissuerを実際のログインでどう扱うかを確認できていません。上記はBasic認証を仮定した初期設定であり、実tailnetで認可、コード交換、UserInfo、再ログインを確認するまで接続済みとは扱いません。TailscaleがS256 PKCEを送ることを確認できた場合は、Kituneの `require_pkce = false` を削除して既定へ戻せます。
