# KituneのFly配置

KituneをFlyへ1 Appで配置し、secretを保持できるWebサービスから直接接続します。Kituneのissuerは `{origin}/api/auth` です。既存環境を更新するときはorigin、PasskeyのRP ID、固定ユーザーID、Volume、`BETTER_AUTH_SECRET` を維持します。

初期構成はnrt、shared CPU 1基、256MB、swapなし、Volume 1GB、1 Machineです。未使用時はsuspendし、HTTP要求で復帰します。複数の認証元をまとめる家族・サークル用Dexは任意の別サービスであり、このリポジトリに常用配置の雛形は置きません。

## 非公開の設定

実際のメールアドレス・ドメイン・Fly App名を追跡対象の雛形に書き込まないでください。`config.toml` と `deploy/local/` はGit・Dockerビルドの対象外です。個人情報を含むMarkdownは `.codex/` に保存します。`.codex/*` は既定でGit対象外とし、共有が必要なファイルだけ `.gitignore` に個別の例外を追加します。Dockerには `.codex` 全体を含めません。公開前には差分だけでなく、pushする未公開コミットの履歴も確認してください。

```sh
mkdir -p deploy/local/kitune
chmod 700 deploy/local deploy/local/kitune
cp fly.toml deploy/local/kitune/fly.toml
cp config.example.toml deploy/local/kitune/config.toml
chmod 600 deploy/local/kitune/*
```

コピーしたファイルのapp名、origin、ユーザー、OIDCクライアントを編集します。Kituneの `[build].dockerfile` は、移動先の設定ファイルから見た `../../../Dockerfile` に変更します。サービスごとに別のclient ID、callback、secret用環境変数を使います。[Webサービスの接続例](../examples/web-services.md)を参照してください。

`require_pkce` は省略時にS256必須です。接続先がPKCEを送信できないことを確認した機密Webクライアントだけ、`require_pkce = false` を設定します。`secret_env` と32文字以上のsecretは例外なく必須で、公開クライアントは登録できません。

## 設定の反映

`BETTER_AUTH_SECRET`、必要なDiscord秘密値、各OIDCクライアントのsecretをFly Secretsへ個別に保存します。設定全体はbase64にして `IDP_CONFIG` に保存します。以下はリポジトリルートで実行します。

```sh
bun run cli check-config
bun -e 'console.log("IDP_CONFIG=" + Buffer.from(await Bun.file("deploy/local/kitune/config.toml").text()).toString("base64"))' | fly secrets import --stage -c deploy/local/kitune/fly.toml
fly config validate -c deploy/local/kitune/fly.toml
fly deploy . -c deploy/local/kitune/fly.toml --remote-only --ha=false --strategy immediate
```

`fly secrets import` へ標準入力で渡し、設定やsecretをシェル履歴・ログへ展開しません。配置後は次を確認します。

1. `/healthz`、`/api/auth/.well-known/openid-configuration`、Discoveryが示すJWKSが正常に取得できる。
2. Discoveryのissuerが設定した `{origin}/api/auth` と完全に一致する。
3. 実機Passkeyでログインでき、直接接続した一時クライアントで認可、コード交換、UserInfo、必要ならrefresh token更新が成功する。
4. 再起動の前後でユーザーの `sub` と署名鍵が維持される。
5. クライアント設定を変えたとき、そのクライアントのコードとgrantだけが失効し、ほかのログインとクライアントは継続する。

Gitea、Headscale、Tailscaleの設定例は互換性確認用です。各サービスの導入や既存アカウント移行、実サービス上のログイン確認はこの配置手順に含みません。

## メモリ・復帰・静的配信

Docker統合テストは256MB・swapなしでAPIテスト、Passkey・OIDC、4件同時の認可、CLIと復元を確認します。実環境でも完全停止からの起動とsuspendからの復帰をそれぞれ試し、直接OIDC認可とトークン更新、OOM、メモリ余裕を確認してください。RSSはJavaScriptヒープ以外の領域も含み、OSのファイルキャッシュとも重複するため、プロセスRSSとcgroupの値を単純に合計しません。

`suspend` は実行状態から復帰するため起動時間を短縮できます。Flyがsuspendできない場合はstopへ戻るため、完全停止からの起動も必要です。stop・suspend中はCPU／RAMの課金が止まり、Volumeなどの料金は継続します。

`[[statics]]` はMachine内の静的ファイルサーバーへ配信を移す設定で、停止中のMachineを起動せずに配信する機能ではありません。ログイン画面はSSRのため、Honoからの配信を維持します。アプリから配信すればCache-Control等のヘッダーも設定できます。[Fly公式のstatics仕様](https://fly.io/docs/reference/configuration/#the-statics-sections)を参照してください。

## バックアップと復元

Kituneは[運用手順](operations.md)の `VACUUM INTO` で一貫したSQLiteバックアップを作成します。完成したDBはMachine外へ取得して暗号化保管し、対応する設定と `BETTER_AUTH_SECRET` も安全に保存します。稼働中のDB本体だけをコピーする方法や、別時点のWALの持ち込みは使用しません。

復元は新しいVolumeで行い、同じorigin、固定ユーザーID、設定、`BETTER_AUTH_SECRET` で起動します。再開前に `revoke-all` を実行し、バックアップに含まれるセッションとgrantを失効させます。既存Passkey、ユーザーID、署名鍵が維持されたことを確認してから利用を再開します。
