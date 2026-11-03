# Reach Swiftnest away from home

A relay is a small cloud computer (VPS) you rent. Your home Swiftnest server connects out to it, and your App connects to it when you are away. It forwards encrypted bytes; only your App and home server can read the chat and approvals. It cannot impersonate your paired server, but can see connection times, traffic sizes and a server identifier. There is no default relay. Without one, everything on your home network keeps working as before.

## Prepare

1. Choose any provider's small always-on Linux VPS: 1 CPU, 1 GB RAM and 10 GB disk are enough for running it; building needs temporary 2 GB RAM or swap. No GPU needed. Choose a nearby location, public IPv4 and incoming TCP ports 80/443. Check the traffic allowance and renewal charges.
2. Select Debian 12/13 or Ubuntu 24.04/26.04 LTS. Leave your home server on and online. You do not need home router port forwarding.
3. Point a domain such as `relay.example.com` at the VPS using a DNS A record. Omit AAAA unless IPv6 works. Allow TCP 80, 443 and your SSH login port in the provider's firewall.

Without a domain, the simplest safe option is a trusted private VPN to your home server, or help setting up an SSH tunnel to the VPS loopback listener. Never expose `http://PUBLIC-IP:8787` or skip certificate checks. The installer stops without a domain; a public relay address must use HTTPS.

## Run one command on the VPS

Open the provider's web terminal as root. Replace the domain and paste the whole line:

```sh
apt-get update && apt-get install -y curl && curl -fsSL https://raw.githubusercontent.com/lvy-jsd/swiftnest/main/packages/relay/install.sh -o /tmp/swiftnest-relay-install.sh && sh /tmp/swiftnest-relay-install.sh relay.example.com
```

This targets `main` after R2 is released. Before release, select a branch/tag containing R2 in both the download URL and `SWIFTNEST_RELAY_REF`. You can download and read the script first. It installs Docker, builds the relay from source, creates a random secret, and starts the relay and Caddy with automatic restart. Containers avoid installing Node or writing service files. The relay listens only on the VPS's loopback address; Caddy is its public HTTPS entrance. Caddy obtains and renews a Let's Encrypt certificate in its own volume; the relay saves no forwarded data and enables no access logs. [Caddy's HTTPS documentation](https://caddyserver.com/docs/automatic-https)

After a few minutes, save the printed **Relay address** and **Relay secret** in your password manager. Keep the secret private. A root-only copy is in `/opt/swiftnest-relay/relay.env`. Open `https://relay.example.com/health` in a browser: an empty page without a certificate warning means it is ready. Initial certificate setup may take another minute.

## Fill in the App

1. At home, open your already-paired installed desktop or phone App. First pairing must happen at home.
2. Open **Preferences → Advanced: access away from home**. Paste the HTTPS address and secret into their separate boxes and select **Save**.
3. Wait a few seconds, then select **Check connection**. Once your server is connected, reconnect each other paired App at home once. It learns the new address and secret through the encrypted channel without pairing again.
4. Turn off phone Wi-Fi, use mobile data, reopen the App and send a message. Check the reply and the “This App is using your relay” status. Try answering an approval too.

Installed Apps keep the secret with their existing private pairing file, outside Web storage. The browser App keeps it only in the current page's memory. The relay does not host the browser App; use the installed App away from home. Each connection tries home addresses before the relay, and never automatically resends a chat. Reconnect after returning home to prefer your LAN again.

Live view, take-over and file transfers currently need home Wi-Fi; the App explains this. Defaults per server: 8 connections, 128 KiB frames, combined 256 KiB/second and 128 frames/second, with a brief 1 MiB burst. This is for small API, chat and approval traffic. Exceeding a limit disconnects the channel; wait and reconnect.

Both the relay and the home encrypted channel also allow at most 8 unfinished sign-ins and 60 connection attempts per minute from one IP address. The installer configures the relay to trust only Caddy at `127.0.0.1` for the real client IP. A client cannot choose its own IP by sending a forwarded header. If you use another reverse proxy, set `SWIFTNEST_RELAY_TRUST_PROXY` to its exact immediate IP and make it append or replace `X-Forwarded-For` with the actual client's IP. Proxy trust is off when this setting is absent.

## Optional: put the home web App behind HTTPS

Skip this section for the usual setup above: the VPS installer already handles TLS for the relay. This section is for an owner who already has a reverse proxy (a program such as Caddy that receives HTTPS, then passes requests to Swiftnest). No home port forwarding is needed for the relay.

For example, if Caddy and Swiftnest run on the same home computer, Caddy can use:

```text
assistant.example.com {
  reverse_proxy 127.0.0.1:3077
}
```

Set these environment variables **on the home Swiftnest process**, then restart it using your usual start command:

```sh
export SWIFTNEST_TRUSTED_PROXY_IP=127.0.0.1
export SWIFTNEST_TRUSTED_PROXY_ORIGIN=https://assistant.example.com
```

Use your own exact HTTPS origin (include the port if it is not 443, with no trailing slash or path). Use the proxy IP as seen by Swiftnest; it may be `::1` or an explicit private IP on another computer. Keep the connection from proxy to Swiftnest private. Caddy preserves Host/Origin, supports WebSockets, and supplies the client IP; other proxies must do the same. Do not rewrite Origin to hide a different website. [Caddy proxy headers and streaming](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

Open the fresh **web App link** printed after restart. It uses this HTTPS address and retains the pinned server key. Pair once, create a chat, then refresh the page: the chat should stay open without another pairing link. A missing or wrong proxy IP/origin returns 403; unset **both** settings to turn this trust off again. Arbitrary forwarded Host or protocol headers never enable it.

The browser keeps the existing signed owner session in a `HttpOnly; SameSite=Strict` cookie (`Secure` over HTTPS), so scripts cannot read it. Each reload exchanges it for a 30-second single-use ticket used only to open the pinned encrypted channel. The owner credential is never returned to JavaScript or written to local/session storage. Public server keys and addresses can stay in local storage. If browser cookies are cleared or the session expires, pair again.

## Troubleshooting

| Problem                                       | What to do                                                                                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Address unreachable or certificate warning    | Check the A record, ports 80/443 and server clock; remove an incorrect AAAA record. Do not bypass warnings.                                     |
| “Not connected yet”                           | Keep the home server online; check its internet connection and paste the exact address and secret again.                                        |
| Works at home, fails away                     | Reconnect this App at home once to learn the address. Use the installed App. Check VPS billing and traffic allowance.                           |
| Live view or transfers request Wi-Fi          | Expected for this version; reconnect at home.                                                                                                   |
| Many connections or traffic cause disconnects | Close extra Apps, wait, then reconnect.                                                                                                         |
| Secret exposed                                | Replace it in the VPS `relay.env`, recreate the relay container, save the new secret in the App at home, then reconnect other Apps to learn it. |

TLS diagnostics: `sudo docker logs --tail 30 swiftnest-relay-tls`. The relay itself disables logs. Restart: `sudo docker restart swiftnest-relay swiftnest-relay-tls`. To stop remote access, select **Turn off remote access** in App settings, then run `sudo docker stop swiftnest-relay swiftnest-relay-tls`; LAN use continues. For upgrades keep `relay.env` and the certificate volume, rebuild from a reviewed release, and recreate the relay container with the same arguments shown in the installer. Do not delete the certificate volume.

## Optional server configuration

Owners familiar with configuration can set this and restart Swiftnest. Omit `relay` to disable it. App-saved `<home>/relay.json` takes precedence, including an explicit disable. Never commit secrets.

```yaml
relay:
  address: https://relay.example.com/
  secret: THE_SECRET_FROM_THE_INSTALLER
```

Environment equivalents: `SWIFTNEST_RELAY_ADDRESS`, `SWIFTNEST_RELAY_SECRET`. These configure the home server, not the VPS environment file. The relay reuses the existing maintained MIT-licensed `ws` dependency; no new third-party npm library is added.
