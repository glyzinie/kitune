# Kitune

PasskeyとDiscordだけでログインする、認証ブローカー向けの個人用OIDC認証元。Better Auth 1.7.4・Hono 4.13.7・Bun 1.4.0・SQLiteで動作します。

各人が自分のDexを持つ構成です。自分のKitune（`id.example.com`）→自分のDex（`auth.example.com`）→家族Dex（`auth.example.jp`）／サークルDex（`auth.example.net`）へつなぎます。他の参加者も各人のDexを接続します。[構成と役割分担](guides/federation.md)を参照してください。Kituneと個人DexのFly構成は[配置手順](guides/deployment.md)にまとめています。

## はじめる

```sh
cp config.example.toml config.toml
cp .env.example .env
bun install --frozen-lockfile
```

`config.toml` のユーザー・クライアントと、`.env` の秘密値を設定します。`BETTER_AUTH_SECRET` と各クライアントsecretには、`openssl rand -hex 32` などで個別に生成した値を使ってください。Bunが `.env` を読み込みます。

ローカルでは `http://localhost:3000` を開きます。PasskeyのRP IDにはIPアドレスを使えないため、`127.0.0.1` はIdPのoriginに指定できません。本番はHTTPSのドメインを使います。

```sh
bun run cli check-config
bun run dev
```

別のターミナルで `bun run cli enroll owner` を実行し、表示されたURLをブラウザで開いてPasskeyを登録します。登録URLは15分間・一度限り有効です。

Discordを使う場合は `users[].discord_ids` と環境変数 `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` を設定し、Discord Developer Portalに `{origin}/api/auth/callback/discord` を登録します。権限は `identify` のみで、メールやGuild情報は取得しません。

## 設定と認証

- 画面を色で見分けたい場合は、`config.toml` のトップレベル（`[[users]]` より前）に `theme_color = "#2563eb"` のように6桁の16進カラーを指定して再起動します。ログイン・登録・アカウント・同意画面の主ボタン、背景、アクセントなどに共通で反映し、文字色は読みやすさに合わせて調整します。省略時は既定の配色です。
- 同じ `users[].discord_ids` に複数IDを置くと、どれでログインしても同じ `sub` になります。別ユーザーに割り当てると別の `sub` になります。Discord IDは文字列で指定します。
- ユーザーの固定 `id` はOIDCの `sub` です。メールはプロフィール属性で、ログイン・自動統合には使いません。メールはDB内で一意です。`email_verified` は管理者が確認した場合のみ `true` にします。
- ユーザー・クライアントの変更は設定を更新して再起動します。ユーザーの削除・無効化・属性・Discord紐付け変更で、そのユーザーのセッションとOAuth grantを失効させます。クライアント変更では、そのクライアントのgrantを失効させます。設定から削除したユーザーIDは再利用できません。一時停止には `enabled = false` を使います。
- Passkeyにはユーザー確認（UV）を要求し、サーバーでもUVなしの応答を拒否します。登録後はApple Passwords・1Passwordなどの保存先から名前を自動設定し、後から編集できます。判別できない場合は「Passkey」です。別のログイン方法がない最後のPasskeyは削除できません。
- `groups` はローカルグループです。各サービスが認可を実装します。家族側の権限を個人IdPが任意に与える仕組みにはしません。

## OIDC接続

Kituneの正式な検証対象はDexです。各サービスは個人Dexへ接続し、サービスごとのOIDC互換性対応・クライアント管理はDex側で行います。サービスのKituneへの直接接続は正式サポート対象外です。他の認証ブローカーは同じ接続条件で検証してから対応対象へ追加します。

issuerは `{origin}/api/auth`、Discoveryは `{origin}/api/auth/.well-known/openid-configuration` です。

対応scopeは `openid profile email groups offline_access`。認可コード＋S256 PKCEとローテーション付きrefresh tokenを提供します。クライアントsecretを安全に保持できる機密クライアントだけを登録できます。全クライアントでPKCEと `secret_env` が必須です。認証方式は `client_secret_basic`（既定）と `client_secret_post` に対応します。

`[[clients]]` は複数設定できます。通常は個人Dexの1件とし、移行・検証時に別のブローカーを追加します。公開クライアントの `none`、`secret_env` の省略、必要な秘密値の欠落は起動時にエラーとなります。以前の公開クライアント設定は暗黙に変換せず、サービスの接続先をDexへ移してから設定を更新してください。既存の機密クライアント設定はそのまま利用でき、DBスキーマ・issuer・ユーザーID・署名鍵の移行は不要です。

ID／アクセストークンは15分、refresh tokenは30日、認可コードは5分、Kituneのセッションは7日です。設定からの失効後も、外部サービスが既に作ったセッションやオフライン検証されるIDトークンは各期限まで残り得ます。

[個人Dex接続例](examples/dex.yaml)と[家族](examples/family-dex.yaml)・[サークル](examples/circle-dex.yaml)の接続例に、各段の `offline_access`、S256 PKCE、UserInfo取得、接続元別のグループ接頭辞を含めています。

## 管理・検証

| コマンド | 動作 |
| --- | --- |
| `bun run cli check-config` | 設定・必要な秘密値を検証。DBは変更しない |
| `bun run cli sync` | マイグレーションと設定同期 |
| `bun run cli enroll USER` | 最初のPasskey用URLを発行。既存Passkeyがあれば拒否 |
| `bun run cli recover USER` | Passkey・セッション・grantを失効させ、再登録URLを発行。Discord紐付けは維持 |
| `bun run cli revoke USER` | セッション・grantを失効。ログイン方法は維持 |
| `bun run cli revoke-all` | 全ユーザーのセッション・grantを失効 |
| `bun run cli backup PATH` | 設定同期をせず、一貫したSQLiteバックアップを新規ファイルへ作成 |

```sh
bun run check
bun test
bun run build
bun run test:production
bun run test:docker
DEX_BIN=/path/to/dex bun run test:dex
CHROMIUM_PATH=/path/to/chromium bun run test:ui
```

詳細は [開発・検証](guides/development.md) と [Fly運用・復元](guides/operations.md) を参照してください。

## Dockerパッケージ

GitHub ActionsはAMD64・ARM64それぞれのネイティブランナーでビルドとDocker統合テストを実行し、成功したイメージを `ghcr.io/glyzinie/kitune` に発行します。PRでは検証のみ実施します。

- `main` へのpush: `latest` と `sha-<commit SHA>`。
- `vX.Y.Z` タグへのpush: `X.Y.Z` と `sha-<commit SHA>`。プレリリースタグも利用できます。
- 手動実行: 指定したrefをビルド。`main` を指定すると `latest` も更新します。

公開処理にはリポジトリの `GITHUB_TOKEN` を使い、Flyの秘密値は不要です。初回発行後、GitHub Packagesのパッケージ設定でVisibilityがPublicになっていることを確認してください。Flyへのデプロイはこのworkflowから実行しません。

コンテナには `BETTER_AUTH_SECRET` とクライアント秘密値を環境変数で渡し、設定を `/app/config.toml`、永続Volumeを `/data` に配置します。実ユーザー設定・秘密値・DB・バックアップはイメージに含めません。

## 紹介サイト

GitHub Pages向けの日本語サイトは `site/` にあります。`bun run site:dev` でローカルプレビューを起動できます。[編集と公開の手順](guides/pages.md)を参照してください。
