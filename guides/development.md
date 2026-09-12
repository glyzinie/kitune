# 開発・検証

サーバーは `src/server.ts`、HTTPと画面は `src/app.tsx`、Better Authとの接続は `src/auth.ts`、設定とSQLite同期は `src/config.ts` / `src/store.ts` にあります。ブラウザコードを変更したら `bun run build` で再構築します。

## 認証の境界

- Discordアカウントは起動時に事前登録し、OAuthで検証されたDiscord IDから所有者を解決します。公開サインアップとアカウント連携APIは閉じています。メールの一致は本人確認の根拠にしません。
- 通常の認証とOIDC処理はBetter Authに委ねます。バージョン更新時は実際のcallbackパス、署名付き `oauth_query`、トークンレスポンス、DBスキーマを再確認してください。
- OIDCはsecretを保持できるWebサービスからKituneへの直接接続を基本とします。KituneのOIDC処理はBetter Authに委ね、製品別の独自claimやプロトコル実装を増やしません。後述のAPIテストでDiscovery・署名・ログイン・同意・UserInfo・グループ・更新・失効・再起動後のID維持を確認し、共有Dexの1段接続はDex統合テストで確認します。
- クライアントは `secret_env` 必須の機密クライアントのみです。`none`、設定したsecretの欠落・32文字未満は起動時にDB作成・同期前に拒否します。`require_pkce` は省略時S256必須で、明示した `false` だけPKCEなしを許可します。PKCE任意のクライアントでも、送られたS256 challengeとverifierは検証し、`plain` は拒否します。既存の機密クライアント設定とDBスキーマは維持し、公開クライアントを暗黙に変換しません。
- Providerが許容するnative loopback URIの可変ポートも、このIdPでは認可前フックで拒否します。開発用クライアントを含め、設定したリダイレクトURIとの完全一致が必要です。
- `@better-auth/passkey` 1.7.4は検証時のUV必須設定がありません。登録・認証の検証後フックで署名検証済みの `userVerified` を確認します。認証オプションの `userVerification` はブラウザで `required` にします。
- Passkey名は同じ検証後フックでAAGUIDから補います。`@better-auth/passkey` の [`getAuthenticatorName`](https://better-auth.com/docs/plugins/passkey#naming-passkeys-by-authenticator) を使い、登録中の外部問い合わせは行いません。手動指定名は保持し、ライブラリに未収録・全ゼロのAAGUIDは「Passkey」にします。AAGUIDは表示名の候補にのみ使用し、提供元の真正性や認証可否の判断には使いません。
- UVの検証は認証器が返すフラグの検証です。[passkeys.devの既知の問題](https://passkeys.dev/docs/reference/known-issues/)には、一部のブラウザ拡張が確認操作なしでUVを立てる実装が掲載されています。実際のPIN・生体認証の操作までサーバーが独立に証明できるものではありません。
- 登録URLの秘密はURL fragmentからPOSTし、HttpOnly Cookieに格納します。GETのquery、ログ、通常セッションには入れません。未ログイン登録では `createSession=true` を必須とし、プラグインのトランザクション内で登録権とPasskey保存を一体化しています。
- ユーザー情報とPasskeyを扱うAPIでは有効状態を確認します。ユーザーのepochが変わった既存セッションは無効です。セッション削除時には関連grantも削除します。
- 設定同期はSQLiteの単一トランザクションです。ユーザー削除は固定IDを退役させ、Passkey・Discord紐付けを削除します。無効化では資格情報を残し、再有効化できるようにします。
- 失効時はセッションより先にaccess/refresh tokenを削除します。セッションFKの `SET NULL` でgrantが残ることを防ぎます。未使用の認可コードも削除します。

## マイグレーション

初回は固定したBetter Auth構成から公式migration APIでテーブルを作り、Kituneの補助テーブル・一意インデックスを追加します。`PRAGMA user_version=1` が現在のバージョンです。

スキーマを変える更新では番号を上げ、既存DB向けの明示的な移行を追加し、旧DBのコピーで検証してください。通常再起動でスキーマを推測変更しません。新しいバージョンのDBを古いアプリで開くことは拒否します。originの変更も既存DBでは拒否します。

## 必須チェック

`bun run check`、`bun test`、`bun run build` を実行します。認証・画面・依存更新では、関係する統合テストも実行してください。

- `tests/auth.test.ts`: 実際のHTTPエンドポイント、独立したP-256ソフトウェア認証器、モックしたDiscordのtoken/profileレスポンスを使用。署名、UV、Origin/RP、リプレイ、登録URL競合、ロールバック、OIDC、設定失効、復元を確認します。機密クライアントのBasic／POST認証、secret欠落・誤りの拒否、PKCE既定値と個別例外、S256併用時の検証、`offline_access` の追加条件、コード再利用・別クライアント交換の拒否、対象ごとの失効も検証します。Gitea相当のnonce・PKCE・`offline_access` なしの要求では、コード交換とUserInfoを確認します。Discordの実資格情報は不要です。
- `bun run test:dex`: Dex 2.45.1の実行ファイルを `DEX_BIN` で指定。ローカルでKitune→共有Dex→サービスの1段接続を起動し、ログイン、同意、PKCE、署名、グループ、更新、再起動、無効化を確認します。Goビルドする場合は公式v2.45.1タグの `./cmd/dex` が対象です。
- `bun run test:ui`: Chromiumを `CHROMIUM_PATH` で指定するか、PlaywrightのChromiumを事前インストール。仮想WebAuthn認証器を使い、登録、ログイン、名前変更、最後のPasskey保護、OIDC同意、モバイル幅を確認します。画像はGit対象外の `test-results/` に保存します。
- `bun run test:production`: 一時ディレクトリへ本番用ファイルとproduction依存だけを配置。実プロセスの起動、SSR、CLI、SIGTERMでの正常終了、再起動後のSQLite整合性と署名鍵を確認します。ホスト上の確認であり、Dockerイメージのビルド・Linux上の実行とは別です。
- `bun run test:docker`: Dockerデーモンのネイティブアーキテクチャでビルドし、1 CPU・256MB・swapなしのコンテナでAPIテスト、非root実行、Passkey／OIDC、4件同時の認可、Volume再起動、バックアップ復元と失効を確認します。テスト専用のコンテナ・Volumeを作成して終了時に削除します。`DOCKER_TEST_IMAGE` を指定すると既存イメージを使用・保持します。別アーキテクチャは `DOCKER_TEST_PLATFORM` で指定します。
- `FLY_TEST_SETTINGS=/path/to/private.json bun run test:fly`: 明示的な実環境テストです。JSONには `kituneOrigin`・`kituneApp`・`smokeUser`・`smoke`（テストクライアントsecret）を指定します。事前にKituneへ未使用の `deploy-test-*` ユーザーと、callback `http://127.0.0.1:9876/callback` の `deployment-smoke` クライアントを設定します。Kitune単体でTLS、Passkey、同意、OIDC、グループ、3回の復帰、休止からのrefresh token更新、ユーザー失効を確認します。`FLY_TEST_LIFECYCLE=stop`（既定）は完全停止、`FLY_TEST_LIFECYCLE=suspend` は休止を検証します。対象は1 Machine限定です。終了時にテスト資格情報を失効させますが、本番設定への復帰と再デプロイは別途必要です。削除済みのユーザーIDは次の試験で再利用しません。結果は `test-results/fly-stop.json` または `test-results/fly-suspend.json` に保存します。

Headscale・Gitea・Tailscaleを起動する大規模な専用テスト基盤は追加しません。PKCE・nonce・scopeの認可要求差は既存APIテストへ組み込み、製品側の設定互換性と実サービス上の接続確認は分けて記録します。

Docker CLIからBuildxが見つからない場合は、`DOCKER_TEST_BUILDX` にインストール済みBuildxの実行ファイルを指定できます。今回のHomebrew環境では `DOCKER_TEST_BUILDX=/opt/homebrew/lib/docker/cli-plugins/docker-buildx bun run test:docker` で実行します。Apple SiliconのColimaではQEMUのAMD64エミュレーションでBun 1.4.0がAVX未対応・segmentation faultを報告しました。`QEMU_CPU=max` でも解消していません。AMD64版はFlyのリモートビルドと実機で別途検証し、Passkey・OIDC・停止からの起動を確認しています。GitHub ActionsでもAMD64・ARM64のネイティブランナーを使います。

suspend試験ではcordonして10秒待ち、休止後にuncordonして新規通信による復帰を確認します。`fly machine suspend` 単独はProxyの自動休止時の通信停止処理を行わず、直後の要求が失敗する場合があります。CLIでの試験は自動休止の近似なので、無通信からの自動休止・復帰も別途確認してください。[Flyの自動休止時の処理](https://community.fly.io/t/fly-proxy-now-gracefully-terminates-websocket-connections-before-stopping-suspending-a-machine/27544)を参照してください。

実アカウントのDiscord認可画面、実機Passkey、Flyのcold startとメモリは別の実環境確認です。ローカルテストの成功だけで実測済みとは扱いません。ログにはリクエストURL、Cookie、登録URL、OAuthレスポンス、秘密値を出力しません。
