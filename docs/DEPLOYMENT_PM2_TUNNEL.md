# Deployment ohne Docker: pm2 + Cloudflare-Tunnel

Das ist der Weg, der auf einem echten Server (Ubuntu 22.04, hinter NAT, Domain bei Cloudflare) funktioniert hat. Die Docker-Variante steht in `DEPLOYMENT.md`.

## Aufbau

| Teil | Wie |
| --- | --- |
| PostgreSQL 17 | Docker-Container `celtist-db`, nur `127.0.0.1:5433`, Volume `celtist_pg` |
| Redis | vorhandenes Redis, Datenbank `1` (`redis://127.0.0.1:6379/1`); Version ≥ 6.2 empfohlen |
| API | `pm2 start apps/api/dist/main.js --name celtist-api` |
| Web | `pm2 start apps/web/.next/standalone/apps/web/server.js --name celtist-web` (`PORT=3000 HOSTNAME=127.0.0.1`) |
| Erreichbarkeit | `cloudflared`-Tunnel (kein offener Port, kein nginx, HTTPS von Cloudflare) |
| Backups | `~/backup-celtist.sh` per Cron, täglich 03:30 |

## Schritte

1. Benutzer `celtist` anlegen (kein sudo), Repo nach `~/celtist` klonen, `npm ci`.
2. Datenbank-Container starten, `.env` anlegen (siehe `.env.example`): `NODE_ENV=production`, `DATABASE_URL`, `REDIS_URL`, `PUBLIC_WEB_URL=https://<domain>`, `PUBLIC_API_URL=https://api.<domain>`, `COOKIE_DOMAIN=.<domain>`, `CORS_ORIGINS=https://<domain>`, `TRUST_PROXY=1`, `STEAM_API_KEY`, `OWNER_STEAM_IDS`, drei Secrets.
3. Bauen: `npm run bootstrap`, `npm run build -w @celtist/api`, `npm run migrate:deploy -w @celtist/database`, danach die Web-App mit `NEXT_PUBLIC_API_URL=https://api.<domain> npm run build -w @celtist/web` (die API-Adresse wird beim Bauen eingebrannt) und `apps/web/.next/static` nach `apps/web/.next/standalone/apps/web/.next/` kopieren.
4. Mit pm2 starten, `pm2 save`, einmalig als sudo-Benutzer `pm2 startup systemd -u celtist --hp /home/celtist`.
5. Cloudflare Zero Trust → Tunnels: Tunnel anlegen, zwei **Published application routes**: `<domain>` → `http://localhost:3000`, `api.<domain>` → `http://localhost:4000`. Den Tunnel-Token nur auf dem Server eingeben: `TUNNEL_TOKEN=… pm2 start ~/bin/cloudflared --name tunnel -- tunnel --no-autoupdate run`.

## Typische Stolpersteine

- **Service muss lokal sein.** Steht bei der API-Route `http://api.<domain>` statt `http://localhost:4000`, antwortet Cloudflare mit „DNS points to prohibited IP“.
- **Alte A-Einträge löschen**, bevor der Tunnel die CNAMEs anlegt.
- **Serveruhr:** Steam-Login (Nonce, ±5 min) und Game-Server-Signaturen (±30 s) brauchen eine korrekte Uhr. `timedatectl` muss „System clock synchronized: yes“ zeigen. Sperrt der Hoster NTP (UDP 123), die Uhr per HTTPS nachstellen.
- **IPv6:** Hängt SteamCMD oder ein Download bei 0 %, IPv4 bevorzugen: `precedence ::ffff:0:0/96 100` in `/etc/gai.conf`.
- **Ports 80/443** können beim Hoster auf einen anderen Rechner zeigen; der Tunnel umgeht das.
