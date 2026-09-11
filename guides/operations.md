# Fly運用・バックアップ

## 初回配置

`fly.toml` と `deploy/dex/fly.toml` は例示用です。[配置手順](deployment.md)に従い、実際のapp名・ドメイン・ユーザー設定はGit対象外のファイルに保存してください。Passkey登録後のorigin変更は移行作業です。

デプロイするときに以下を実施します。

1. Fly Appを作り、`kitune_data` Volumeを `nrt` に1GBで作成する。
2. TLS証明書とDNSを設定する。Discordのcallback URLも本番originに合わせる。
3. `BETTER_AUTH_SECRET`、必要なDiscord秘密値、クライアントsecretをFly Secretsに設定する。`IDP_CONFIG` には `config.toml` 全体をbase64にした値を設定する。`[[files]]` がデコードして `/app/config.toml` に配置する。秘密値の受け渡しには `fly secrets import` の標準入力を利用し、シェル履歴やログへ出さない。
4. `fly config validate` で設定を確認してから、`fly deploy --ha=false --strategy immediate` で1 Machineへ配置する。必要に応じ `fly scale count 1` で台数を確認する。
5. `/healthz` とDiscoveryを確認し、実機のPasskey登録・Discord・OIDCログインを検証する。

SQLiteのデータは `/data/kitune.sqlite` に保存します。Volumeは複製しないため、複数Machineへのスケールアウトはしません。`release_command` にはVolumeが付かないため使用せず、DB移行と設定同期はアプリ起動時に実行します。

初期値はshared CPU 1基・256MB・swapなしです。低負荷時は `suspend` で休止し、リクエストで復帰します。DexのDiscovery・UserInfo・トークン更新もリクエストに含まれます。実環境では完全停止からの起動とsuspendからの復帰を複数回試し、OIDC経由の起動、ピークメモリ、OOM、タイムアウトを確認します。1台構成なのでデプロイ中・障害時には停止時間が発生します。

## 管理CLI

CLIはWeb APIとして公開しません。稼働MachineのSSHで、アプリと同じユーザー・DB・環境を使います。

```sh
fly ssh console -C 'gosu bun bun /app/src/cli.ts enroll owner'
fly ssh console -C 'gosu bun bun /app/src/cli.ts recover owner'
```

`recover` は対象のPasskeyとログイン状態を失効させます。Discordの紐付けは残ります。Discord自体を外す場合は設定を変更してください。設定変更後はSecretの更新と再起動で同期します。`sync` はその場でDBへ反映しますが、稼働プロセスのOIDCクライアント表示・origin等を再読込しないため、通常運用は再起動に統一します。

アプリは非rootで実行します。コンテナ起動時のみVolumeと設定ファイルの所有権を調整します。SIGTERM後は最大15秒リクエストを待ち、DBを閉じます。

## バックアップ

```sh
fly ssh console -C 'gosu bun bun /app/src/cli.ts backup /data/backups/kitune-backup.sqlite'
```

SQLiteの `VACUUM INTO` を使うため、稼働中のWALを含めた一貫したDBを取得できます。保存先は新規ファイル限定です。このコマンドは設定同期やマイグレーションを実行しません。

完成したファイルをSFTP等でMachine外へ取得し、暗号化した保管先へ移してください。同じVolume上のファイルだけをバックアップとは扱いません。定期的に実行し、Flyの日次Volumeスナップショットも補助として残します。外部保管先への自動転送・スケジューラはこの初版には含みません。

`BETTER_AUTH_SECRET`、Discordとクライアントの秘密値、対応する設定も別途安全に保管します。特に元の `BETTER_AUTH_SECRET` はDB内の署名秘密鍵・OAuthトークンの復号に必要です。

## 復元

1. 復元先を新しいVolumeまたはローカルの空ディレクトリに用意する。稼働DBやWALへ上書きしない。
2. バックアップを新しい `kitune.sqlite` として配置する。旧環境の `-wal` / `-shm` は持ち込まない。
3. 元と同じorigin・ユーザーID・設定・ `BETTER_AUTH_SECRET` を使い、同じアプリ版で `bun run cli sync` を実行する。
4. `bun run cli revoke-all` でバックアップに含まれるセッション・grantを失効させる。既存Passkey・ユーザーID・署名鍵は維持される。
5. 起動してDiscovery/JWKS、既存Passkey、Discord、OIDCの `sub` を確認してから利用を再開する。

バックアップ時点より後の失効処理は復元されないため、復元後の全セッション失効を省略しないでください。外部サービス自身のセッションは、そのサービスの期限・失効操作に従います。

公式仕様: [Fly設定](https://fly.io/docs/reference/configuration/)、[Volumes](https://fly.io/docs/volumes/overview/)、[自動停止](https://fly.io/docs/launch/autostop-autostart/)、[Dex OIDC connector](https://dexidp.io/docs/connectors/oidc/)。
