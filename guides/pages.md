# GitHub Pagesの紹介サイト

`site/` にKituneの日本語紹介サイトのソースを置いています。Bun 1.4.2のHTMLビルドでCSS・JavaScriptを圧縮し、公開用ファイルを `site/dist/` に生成します。追加の依存インストールは不要です。認証サーバー本体はGitHub Pagesでは実行できません。

## ローカルで確認する

Bun 1.4.2で次を実行し、表示されたURLを開きます。

```sh
bun run site:dev
```

プレビューは `http://127.0.0.1:4173/Kitune/` です。GitHub Pagesのプロジェクトパスを再現し、`site/` の公開ファイルだけを配信します。HTML・CSS・JavaScriptの変更後はブラウザを再読み込みしてください。

公開用のビルドと、その確認には次を使います。

```sh
bun run site:build
bun run site:preview
```

`site:preview` は再ビルドして `http://127.0.0.1:4174/Kitune/` で生成物を配信します。編集用プレビューと同時に実行できます。

## ソースと生成物

次のソースとビルドスクリプトはGitに含めます。

- `site/index.html`: Kituneからサービスへ直接接続する構成、サービス別のOIDC例、導入手順、既存ガイドへのリンク。
- `site/style.css`: デザインとモバイル対応。
- `site/script.js`: 導入コマンドのコピー。JavaScriptが無効でも本文とリンクは利用できます。
- `site/favicon.svg`: 🦊のロゴ。
- `scripts/build-site.ts`: 公開用のビルド。

`site/dist/` は既存の `.gitignore` の `dist/` 規則で除外され、コミットしません。ビルド時はこの生成先だけを作り直します。アプリ本体の `dist/` には影響しません。

BunがCSS・JavaScript・faviconにハッシュ付きのファイル名を付け、HTMLの参照を相対パスで書き換えます。`pre` のコマンドなど、HTML内の文章や改行は維持します。CDNのフォント・ロゴは引き続きブラウザから直接読み込みます。

日本語フォントはGoogle FontsのCDNからLINE Seed JP（Regular 400・Bold 700・ExtraBold 800）を読み込みます。`display=swap` を指定し、取得中やCDNに接続できない場合は端末のフォントで表示します。コードは等幅フォント、ロゴは端末の🦊絵文字です。

構成図ではKituneからHeadscale・Gitea・Tailscaleへ直接接続する流れを示します。家族・サークル用の共有Dexは、複数のKituneを集約するときだけ使う選択肢として本文で説明します。名称も併記し、アイコンとロゴは装飾として扱います。

- Passkey: [Google Material Symbols](https://developers.google.com/fonts/docs/material_symbols)のRoundedスタイルの `passkey`（人と鍵）を使います。[Google CDNのSVG](https://fonts.gstatic.com/s/i/short-term/release/materialsymbolsrounded/passkey/default/24px.svg)をCSSマスクとして直接読み込み、サイトの文字色に合わせます。ライセンスはApache License 2.0です。
- Discord: [公式ブランドページ](https://discord.com/branding)が使うWebflow CDNから、青紫色のClydeシンボルを直接読み込みます。

サービス別の接続例は、secretを保持できるWebサーバーを対象にしています。Kituneではサービスごとに異なるクライアントIDと32文字以上のsecretを用意し、基本scopeを `openid profile email` とします。PKCEはS256が既定で必須です。GiteaなどPKCE非対応の接続先だけ、該当クライアントに `require_pkce = false` を指定します。公開クライアントやSPA・ネイティブアプリはこのサイトの対象外です。

- Headscale 0.29.3: `pkce.enabled: true` と `method: S256` を有効にし、callbackは `https://headscale.example.com/oidc/callback` とします。
- Gitea 1.27.3: 認証ソース名を `kitune` とし、callbackは `https://gitea.example.com/user/oauth2/kitune/callback`。 `require_pkce = false` とし、 `offline_access` は付けません。
- Tailscale: callbackは `https://login.tailscale.com/a/oauth_response`。WebFingerのhrefをKituneのissuer（例: `https://id.example.com/api/auth`）にし、Discoveryのissuerと一致させます。初期設定は `client_secret_basic` とします。PKCE送信と実サービスの接続は未確認です。

直接接続時の `sub` はKituneに設定した固定ユーザーID、 `groups` は `personal` など元の値です。既存サービスの利用者をメール一致で自動移行しません。

ローカルのCSS・JavaScript・faviconは相対パスなので、リポジトリのサブパスでも配信できます。GitHubへのリンクは `glyzinie/Kitune` を参照しています。fork先で使う場合はリンクと `scripts/preview-site.ts` の `basePath` も更新してください。

## 初回公開

1. リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** に設定します。
2. サイトと `.github/workflows/pages.yml` をコミットし、`main` へpushします。
3. **Actions → GitHub Pages** の成功を確認します。手動実行するときも `main` を選びます。

標準の公開先は <https://glyzinie.github.io/Kitune/> です。カスタムドメインの設定は含めていません。

以後はサイトのソース、ビルドスクリプト、`package.json`、`.bun-version` またはPages workflowに変更を加えて `main` へpushすると、Actionsがビルドして再公開します。workflowが公開するのは `site/dist/` だけです。設定、秘密値、SQLiteデータ、バックアップはサイトのソースや生成先に置かないでください。

`site/`、`scripts/build-site.ts`、`scripts/preview-site.ts`、`guides/pages.md`、`.github/workflows/pages.yml` だけを変更したPRと `main` へのpushでは、Container workflowのテスト・ビルド・公開を省略します。それ以外のファイルも変更した場合は実行します。`package.json`、`bun.lock`、`.bun-version` はアプリと共有するため除外しません。`v*` タグのpushと手動実行では、変更ファイルにかかわらず実行します。

コミット・push・GitHub Pagesの有効化と公開は、ローカルでのサイト作成とは別の操作です。
