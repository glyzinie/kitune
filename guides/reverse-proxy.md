# ホストのリバースプロキシからDockerへ配置

KituneはPasskey登録とBetter Authのレート制限・セッション記録に接続元IPを使います。`config.toml` の `trusted_ip_source` で、実際の配置経路を1つだけ選びます。

| 値 | 信頼する接続元 | 用途 |
| --- | --- | --- |
| `fly` | 単一の `Fly-Client-IP` | Fly。省略時の既定 |
| `reverse_proxy` | 単一の `X-Forwarded-For` | 同じホストのCaddy/Nginx |
| `localhost` | `127.0.0.1` | `http://localhost` の直接開発だけ |

`fly` と `reverse_proxy` は、選択したヘッダーが欠落、不正、カンマ区切りの複数値なら接続元IPとして扱いません。もう一方のヘッダーへ自動的に切り替えません。IPv6はレート制限用にBetter Authと同じ `/64` へ正規化します。`localhost` はlocalhost以外のoriginでは設定エラーになり、待ち受け先もloopbackに限定します。`HOST` を指定する場合は `127.0.0.1`、`::1`、`localhost` のいずれかにします。

## Dockerをホスト内だけへ公開する

公開originでは次を設定します。

```toml
origin = "https://id.example.com"
trusted_ip_source = "reverse_proxy"
```

既存のconfig、秘密値、Volume指定とともに、コンテナの3000番をホストのloopbackだけへ公開します。次は起動例です。

```sh
docker run -d --name kitune --restart unless-stopped \
  --env-file /srv/kitune/kitune.env \
  --mount type=bind,src=/srv/kitune/config.toml,dst=/app/config.toml \
  --mount type=volume,src=kitune-data,dst=/data \
  -p 127.0.0.1:3000:3000 \
  ghcr.io/glyzinie/kitune:latest
```

`-p 3000:3000` や `-p 0.0.0.0:3000:3000` は使いません。ホストのファイアウォールでも3000番への外部接続を許可せず、公開通信はTLSを終端するリバースプロキシだけに通します。Dockerでdirect routingを有効化している場合は、その経路からコンテナIPへ直接到達できないことも確認してください。

## Caddy

Caddyがインターネットから直接接続を受ける構成では、受信した値を引き継がず、直近の接続元 `{remote_host}` で `X-Forwarded-For` を上書きします。選択外の `Fly-Client-IP` も削除します。

```caddyfile
id.example.com {
    reverse_proxy 127.0.0.1:3000 {
        header_up X-Forwarded-For {remote_host}
        header_up -Fly-Client-IP
    }
}
```

Caddyの前にCDNなど別のプロキシがある場合、`{remote_host}` はそのプロキシのIPです。Caddyのglobal optionsで実際のプロキシ範囲を限定し、右から検証した `{client_ip}` を単一値で渡します。次の予約済み範囲は説明用なので、実際のCDN等が公開する範囲へ置き換えてください。

```caddyfile
{
    servers {
        trusted_proxies static 192.0.2.0/24 2001:db8::/32
        trusted_proxies_strict
        client_ip_headers X-Forwarded-For
    }
}

id.example.com {
    reverse_proxy 127.0.0.1:3000 {
        header_up X-Forwarded-For {client_ip}
        header_up -Fly-Client-IP
    }
}
```

クライアントが送った転送チェーンや、CDN全体より広いprivate networkをそのまま信頼しません。

## Nginx

Nginxがインターネットから直接接続を受ける構成では、`$proxy_add_x_forwarded_for` ではなく `$remote_addr` を指定します。前者は受信した値へ追記するため、Kituneが要求する単一値になりません。

```nginx
server {
    listen 443 ssl;
    server_name id.example.com;

    # ssl_certificate / ssl_certificate_key はホストの証明書を指定する。

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Fly-Client-IP "";
    }
}
```

Nginxの前に別のプロキシがある場合は、`set_real_ip_from` をそのプロキシの実アドレス範囲だけに設定し、`real_ip_header X-Forwarded-For` と `real_ip_recursive on` で検証後の `$remote_addr` を作ってからKituneへ渡します。広いprivate network全体や任意の送信元を信頼しません。

## 確認

設定とホスト内の到達性を確認します。

```sh
docker exec --user bun kitune bun src/cli.ts check-config
docker port kitune 3000
curl --fail http://127.0.0.1:3000/healthz
curl --fail https://id.example.com/healthz
```

`docker port` は `127.0.0.1:3000` を示す必要があります。別の端末からホストの3000番へ直接接続できないこと、通常のPasskey登録・ログインとOIDC認可が公開originで動くことも確認します。

設定の詳細は[Caddyの`reverse_proxy`ヘッダー操作](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#headers)、[Nginxの`proxy_set_header`](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header)、[Dockerのport publishing](https://docs.docker.com/engine/network/port-publishing/)を参照してください。
