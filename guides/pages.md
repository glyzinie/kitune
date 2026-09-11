# GitHub Pagesの紹介サイト

`site/` にKituneの日本語紹介サイトを置いています。HTML・CSS・JavaScriptだけで構成し、依存のインストールやビルドは不要です。認証サーバー本体はGitHub Pagesでは実行できません。

## ローカルで確認する

Bun 1.4.0で次を実行し、表示されたURLを開きます。

```sh
bun run site:dev
```

プレビューは `http://127.0.0.1:4173/Kitune/` です。GitHub Pagesのプロジェクトパスを再現し、`site/` の公開ファイルだけを配信します。HTML・CSS・JavaScriptの変更後はブラウザを再読み込みしてください。

- `site/index.html`: 紹介、認証構成、導入手順、既存ガイドへのリンク。
- `site/style.css`: デザインとモバイル対応。
- `site/script.js`: 導入コマンドのコピー。JavaScriptが無効でも本文とリンクは利用できます。
- `site/favicon.svg`: 🦊のロゴ。

日本語フォントはGoogle FontsのCDNからLINE Seed JP（Regular 400・Bold 700・ExtraBold 800）を読み込みます。`display=swap` を指定し、取得中やCDNに接続できない場合は端末のフォントで表示します。コードは等幅フォント、ロゴは端末の🦊絵文字です。

アセットのURLは相対パスなので、リポジトリのサブパスでも配信できます。GitHubへのリンクは `glyzinie/Kitune` を参照しています。fork先で使う場合はリンクと `scripts/preview-site.ts` の `basePath` も更新してください。

## 初回公開

1. リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** に設定します。
2. サイトと `.github/workflows/pages.yml` をコミットし、`main` へpushします。
3. **Actions → GitHub Pages** の成功を確認します。手動実行するときも `main` を選びます。

標準の公開先は <https://glyzinie.github.io/Kitune/> です。カスタムドメインの設定は含めていません。

以後は `site/` またはPages workflowに変更を加えて `main` へpushすると再公開されます。workflowが公開するのは `site/` だけです。設定、秘密値、SQLiteデータ、バックアップはこのディレクトリに置かないでください。

コミット・push・GitHub Pagesの有効化と公開は、ローカルでのサイト作成とは別の操作です。
