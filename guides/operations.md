# Fly運用・バックアップ

## 初回配置

`fly.toml` は例示用です。[配置手順](deployment.md)に従い、実際のapp名・ドメイン・ユーザー設定はGit対象外のファイルに保存してください。Passkey登録後のorigin変更は移行作業です。

デプロイするときに以下を実施します。

1. Fly Appを作り、`kitune_data` Volumeを `nrt` に1GBで作成する。
2. TLS証明書とDNSを設定する。Discordのcallback URLも本番originに合わせる。
3. `BETTER_AUTH_SECRET`、必要なDiscord秘密値、クライアントシークレットをFly Secretsに設定する。`IDP_CONFIG` には `config.toml` 全体をbase64にした値を設定する。`[[files]]` がデコードして `/app/config.toml` に配置する。秘密値の受け渡しには `fly secrets import` の標準入力を利用し、シェル履歴やログへ出さない。
4. `fly config validate` で設定を確認してから、`fly deploy --ha=false --strategy immediate` で1 Machineへ配置する。必要に応じ `fly scale count 1` で台数を確認する。
5. `/healthz` とDiscoveryを確認し、実機のPasskey登録・Discord・Webサービスからの直接OIDCログインを検証する。

SQLiteのデータは `/data/kitune.sqlite` に保存します。Volumeは複製しないため、複数Machineへのスケールアウトはしません。`release_command` にはVolumeが付かないため使用せず、DB移行と設定同期はアプリ起動時に実行します。

初期値はshared CPU 1基・256MB・swapなしです。低負荷時は `suspend` で休止し、リクエストで復帰します。実環境では完全停止からの起動とsuspendからの復帰を複数回試し、直接OIDC認可による起動、トークン更新、ピークメモリ、OOM、タイムアウトを確認します。1台構成なのでデプロイ中・障害時には停止時間が発生します。

## 管理CLI

CLIはWeb APIとして公開しません。稼働MachineのSSHで、アプリと同じユーザー・DB・環境を使います。

```sh
fly ssh console -C 'gosu bun bun /app/src/cli.ts enroll owner'
fly ssh console -C 'gosu bun bun /app/src/cli.ts recover owner'
```

`recover` は対象のPasskeyとログイン状態を失効させます。Discordの紐付けは残ります。Discord自体を外す場合は設定を変更してください。設定変更後はSecretの更新と再起動で同期します。`sync` はその場でDBへ反映しますが、稼働プロセスのOIDCクライアント表示・origin等を再読込しないため、通常運用は再起動に統一します。

アプリは非rootで実行します。コンテナ起動時のみVolumeと設定ファイルの所有権を調整します。SIGTERM／SIGINT後は最大15秒リクエストを待ち、DBを閉じます。この待機に合わせ、Kituneの `kill_timeout` は20秒を確保します。

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

## 個人Dexから直接接続への切替

個人Dexを廃止するときは、Kituneの更新とDexの削除を分けます。WebFingerの公開応答がKituneを指すまでDexを残し、失敗時に旧経路を利用できる状態を維持します。実際のApp名、メールドメイン、秘密値は追跡対象の文書へ記録しません。

1. 稼働中Dexの設定と `staticClients`、App、Machine、Volume、証明書、DNSを実環境から再確認する。想定外の接続先が1つでもあれば削除工程を止め、先に移行対象と所有者を確定する。
2. KituneとDexの復元可能なSQLiteバックアップを取得する。DBをMachine外へ取り出して暗号化保管し、DBを読み取れることを確認する。対応する設定、issuer、署名鍵の復号に必要な `BETTER_AUTH_SECRET`、クライアントシークレットが揃っていることも確認する。
3. 個人Dexクライアントを残したまま更新版Kituneを配置する。一時的な機密クライアントで直接認可、コード交換、UserInfo、必要な更新、失効、stop／suspendからの復帰を確認し、origin、PasskeyのRP ID、固定ユーザーID、署名鍵が維持されていることを確認する。
4. メールドメインの管理者が、Kituneの配置とは別にWebFingerのissuer参照をDexからKituneの `{origin}/api/auth` へ変更・公開する。外部ネットワークから取得したWebFingerのhrefとKitune Discoveryの `issuer` がパスまで完全に一致するまで、次の削除工程へ進まない。
5. Kituneの設定から個人Dexクライアントを削除して再配置する。削除したクライアントの未使用コードとgrantだけが失効し、通常ログインとほかのクライアントが継続することを確認する。不要になった上流シークレットと一時検証用の設定・シークレットを削除する。
6. Dex専用のDNSレコードを削除してから、個人Dexの証明書、App、Machine、Volume、専用リソースを削除する。Kitune、メール配信、同じドメインのほかのDNSレコードや共有リソースは変更しない。
7. Kituneの正常応答、WebFinger、DiscoveryとJWKS、通常ログインを再確認し、Dex専用リソースとシークレットが残っていないことを確認する。過去の検証記録と暗号化バックアップは保持する。

WebFingerが未反映の場合や、認可・復帰・失効の検証に失敗した場合は、個人DexとそのDNS・Volumeを削除せずに工程を保留します。切替後の直接接続ではKituneの固定 `sub` を使い、個人Dex経由の既存アカウントをメール一致で自動移行しません。

DexのSQLiteは稼働中のDBファイルを直接コピーせず、オンラインバックアップを取得します。既存の非公開Fly設定を使う例は次のとおりです。公式イメージにSQLite CLIがない場合だけ一時導入します。

```sh
fly ssh console -c deploy/local/dex/fly.toml -u root -C 'apk add --no-cache sqlite'
fly ssh console -c deploy/local/dex/fly.toml -u dex -C 'mkdir -p /data/backups'
fly ssh console -c deploy/local/dex/fly.toml -u dex -C 'sqlite3 /data/dex.sqlite ".backup /data/backups/dex-YYYYMMDD.sqlite"'
fly ssh sftp get -c deploy/local/dex/fly.toml /data/backups/dex-YYYYMMDD.sqlite backups/dex-YYYYMMDD.sqlite
```

保存先には毎回新しい名前を使います。暗号化後のコピーからSQLiteを開いて整合性を確認してから、Volume削除を実行します。バックアップに含まれるリフレッシュトークン、認可コード、認可要求、offline sessionは復元後の利用再開前に失効させます。

公式仕様: [Fly設定](https://fly.io/docs/reference/configuration/)、[Volumes](https://fly.io/docs/volumes/overview/)、[自動停止](https://fly.io/docs/launch/autostop-autostart/)、[Dex OIDC connector](https://dexidp.io/docs/connectors/oidc/)。
