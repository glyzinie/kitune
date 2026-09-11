# Kituneと個人DexのFly配置

| 役割 | 例示URL | 設定の雛形 |
| --- | --- | --- |
| Kitune | `https://id.example.com` | `fly.toml`、`config.example.toml` |
| 個人Dex | `https://auth.example.com` | `deploy/dex/fly.toml`、`deploy/dex/config.yaml` |

各アプリはnrt・shared CPU 1基・512MB・Volume 1GB・1 Machineを初期値とします。未使用時はstopし、HTTP要求で起動します。Kituneのissuerは `{origin}/api/auth`、Dexのissuerは個人Dexのoriginです。既存環境を更新するときはissuer・connector ID・ユーザーID・Volumeを維持します。

## 非公開の設定

実際のメールアドレス・ドメイン・Fly App名を追跡対象の雛形に書き込まないでください。`config.toml` と `deploy/local/` はGit・Dockerビルドの対象外です。個人情報を含むMarkdownは `.codex/` に保存します。`.codex/*` は既定でGit対象外とし、共有が必要なファイルだけ `.gitignore` に個別の例外を追加します。Dockerには `.codex` 全体を含めません。公開前には差分だけでなく、pushする未公開コミットの履歴も確認してください。

```sh
mkdir -p deploy/local
chmod 700 deploy/local
cp fly.toml deploy/local/kitune.fly.toml
cp deploy/dex/fly.toml deploy/local/dex.fly.toml
cp deploy/dex/config.yaml deploy/local/dex.yaml
cp config.example.toml config.toml
chmod 600 deploy/local/* config.toml
```

コピーしたファイルのapp名・issuer・callback・ユーザーを編集します。Kitune側のクライアントは通常 `personal-dex` の1件です。個人サービス・家族／サークルDexの追加先は個人Dexの `staticClients` です。秘密値はFly Secretsへ保存し、Gitやイメージには含めません。

## Dexの公式イメージ

独自Dockerfileや起動スクリプトは不要です。`deploy/dex/fly.toml` の `[build].image` にDex 2.45.1の公式イメージをdigestで固定し、`[processes]` で `dex serve /etc/dex/config.yaml` を指定します。`[[files]]` で設定を渡し、SQLiteは `/data/dex.sqlite` に永続化します。

公式イメージはUID/GID 1001で動作します。新しいVolumeでは、初回起動前にVolumeをマウントしたメンテナンスMachineで `/data` を `1001:1001`、モード700に設定してください。既存Volumeでも所有者を確認します。設定ファイルはDexから読み取れる必要があります。YAMLの秘密値は `$PERSONAL_DEX_CLIENT_SECRET` などの環境変数参照とし、Fly Secretsで注入します。

このdigestの公式イメージはSIGTERM時に `run groups: received signal terminated` と終了コード2を返します。停止の確認ではOOM・強制終了との区別と、再起動後のDB・署名鍵・トークン更新を確認してください。

## 設定の反映

両アプリに同じ `PERSONAL_DEX_CLIENT_SECRET`、Kituneに `BETTER_AUTH_SECRET` を設定します。設定全体はbase64にして、それぞれ `IDP_CONFIG` と `DEX_CONFIG` に保存します。以下はリポジトリルートで実行します。

```sh
bun -e 'console.log("IDP_CONFIG=" + Buffer.from(await Bun.file("config.toml").text()).toString("base64"))' | fly secrets import --stage -c deploy/local/kitune.fly.toml
fly config validate -c deploy/local/kitune.fly.toml
fly deploy . -c deploy/local/kitune.fly.toml --dockerfile Dockerfile --remote-only --ha=false --strategy immediate

bun -e 'console.log("DEX_CONFIG=" + Buffer.from(await Bun.file("deploy/local/dex.yaml").text()).toString("base64"))' | fly secrets import --stage -c deploy/local/dex.fly.toml
fly config validate -c deploy/local/dex.fly.toml
fly deploy . -c deploy/local/dex.fly.toml --ha=false --strategy immediate
```

Kituneから順に配置します。Dexは起動時にKituneのDiscoveryへ接続します。各アプリの `/healthz`、Discovery、JWKSを確認し、接続先でログイン・更新を検証します。再起動前後でissuer・ユーザーの `sub`・署名鍵が維持されることも確認してください。

## バックアップと復元

Kituneは[運用手順](operations.md)の `VACUUM INTO` でバックアップします。DexはSQLiteのオンラインバックアップを使用します。公式イメージにはSQLite CLIが含まれないため、稼働Machineに管理者として一時導入して実行できます。イメージ更新後は再導入が必要です。

```sh
fly ssh console -c deploy/local/dex.fly.toml -u root -C 'apk add --no-cache sqlite'
fly ssh console -c deploy/local/dex.fly.toml -u dex -C 'mkdir -p /data/backups'
fly ssh console -c deploy/local/dex.fly.toml -u dex -C 'sqlite3 /data/dex.sqlite ".backup /data/backups/dex-YYYYMMDD.sqlite"'
fly ssh sftp get -c deploy/local/dex.fly.toml /data/backups/dex-YYYYMMDD.sqlite backups/dex-YYYYMMDD.sqlite
```

保存先は毎回新しい名前にし、完成したDBをMachine外へ取得して暗号化保管します。停止中のMachineへSSH接続するときは、先にHTTP要求で起動します。稼働中のDB本体だけをコピーする方法や、別時点のWALの持ち込みは使用しません。

復元は新しいVolumeで行い、同じissuer・connector ID・秘密値で起動します。Kituneは再開前に `revoke-all` を実行します。Dexもバックアップに含まれるrefresh token・auth code・auth request・offline sessionを利用再開前に失効させてください。
