#!/bin/sh
# Fresh Debian/Ubuntu VPS. No home router changes. Usage: sudo sh install.sh relay.example.com
set -eu
umask 077
relay_domain=${1:-}
case "$relay_domain" in
  *[!a-zA-Z0-9.-]*|''|.*|*.|*..*|*-.*|*.-*|-*|*-)
    echo '请先准备域名并指向云服务器。 / First point a domain name at this VPS.' >&2
    echo '没有域名：先使用受信任的 VPN 或 SSH 隧道；请勿公开 HTTP 端口。 / Without a domain, use a trusted VPN or SSH tunnel; never publish plain HTTP.' >&2
    exit 1 ;;
esac
case "$relay_domain" in *.[a-zA-Z]*) ;; *) exit 1 ;; esac
[ "$(id -u)" -eq 0 ] || { echo '请使用 sudo。 / Run with sudo.' >&2; exit 1; }
relay_dir=/opt/swiftnest-relay
[ ! -e "$relay_dir" ] || { echo '已安装；请查看教程更新。 / Already installed; see the guide to update.' >&2; exit 1; }
apt-get update
apt-get install -y ca-certificates docker.io git openssl
systemctl enable --now docker
mkdir -p "$relay_dir"
# Resolve the release source once; the command can select an owner-reviewed release tag.
git clone --depth 1 --branch "${SWIFTNEST_RELAY_REF:-main}" https://github.com/lvy-jsd/swiftnest.git "$relay_dir/source"
relay_secret=$(openssl rand -hex 32)
printf 'SWIFTNEST_RELAY_SECRET=%s\n' "$relay_secret" > "$relay_dir/relay.env"
cat > "$relay_dir/Caddyfile" <<CADDY
$relay_domain {
  tls {
    issuer acme {
      dir https://acme-v02.api.letsencrypt.org/directory
    }
  }
  reverse_proxy 127.0.0.1:8787
}
CADDY
# No access log, no request bodies. Caddy stores only TLS certificates in its named volume.
docker build -t swiftnest-relay:local -f "$relay_dir/source/packages/relay/Dockerfile" "$relay_dir/source"
docker run -d --name swiftnest-relay --network host --restart unless-stopped \
  --read-only --cap-drop ALL --security-opt no-new-privileges --memory 256m --cpus 1 \
  -e SWIFTNEST_RELAY_HOST=127.0.0.1 -e SWIFTNEST_RELAY_TRUST_PROXY=127.0.0.1 \
  --env-file "$relay_dir/relay.env" --log-driver none swiftnest-relay:local
docker run -d --name swiftnest-relay-tls --network host --restart unless-stopped \
  -v "$relay_dir/Caddyfile:/etc/caddy/Caddyfile:ro" -v swiftnest-relay-certs:/data \
  caddy:2
printf '\n中转地址 / Relay address: https://%s/\n中转密钥 / Relay secret: %s\n' "$relay_domain" "$relay_secret"
echo '请保存到密码管理器，再粘贴到 App 高级设置。 / Save these in your password manager, then paste into App advanced settings.'
