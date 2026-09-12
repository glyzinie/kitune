# Kitune

- Bun 1.4.2を使用する。依存バージョンは `package.json` と `bun.lock` が正。
- ユーザー・Discord紐付け・OIDCクライアントは設定を唯一の管理元にする。
- 認証フロー・失効・DB変更時は [開発・検証](guides/development.md) を読む。
- Fly・秘密値・バックアップを扱うときは [運用](guides/operations.md) を読む。
- Dexとの接続・ドメイン構成を変更するときは [認証構成](guides/federation.md) を読む。
- 本番デプロイとGitコミットは、それぞれ依頼された場合に実施する。
