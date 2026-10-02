# Deployment (Docker)

> Die Compose- und Docker-Dateien wurden bisher **nicht gebaut oder gestartet**. Beim ersten Lauf sind Anpassungen möglich.

## Voraussetzungen

Docker + Compose, zwei DNS-Einträge (z. B. `celtist.example.com` für die Web-App, `api.celtist.example.com` für die API) auf den Server.

## Schritte

1. `node scripts/generate-secrets.mjs` und die Werte in `.env` eintragen (Vorlage: `.env.example`). Pflicht: `SESSION_SECRET`, `SERVER_API_SECRET`, `ENCRYPTION_KEY`, `STEAM_API_KEY`, `OWNER_STEAM_IDS` (deine SteamID64 → erste Owner-Rolle), `POSTGRES_PASSWORD`, `CELTIST_DOMAIN`, `CELTIST_API_DOMAIN`, `PUBLIC_WEB_URL`, `PUBLIC_API_URL`, `CORS_ORIGINS`, `COOKIE_DOMAIN` (z. B. `.example.com`).
2. `docker compose -f docker-compose.prod.yml --env-file .env up -d --build`
3. Die API wendet beim Start die Migrationen an (`RUN_MIGRATIONS=true`) und legt Rollen, Rang-Stufen, Maps und Einstellungen an. **Keine Demo-Daten** in Produktion.

## Backups

Der `backup`-Container sichert täglich 03:15 nach `./backups/daily` (7 Stück), sonntags zusätzlich nach `weekly` (4 Stück). Jeder Dump wird mit `pg_restore --list` geprüft.

Wiederherstellen (API vorher stoppen):

```bash
docker compose -f docker-compose.prod.yml stop api
docker compose -f docker-compose.prod.yml exec backup restore.sh /backups/daily/celtist-YYYYMMDD-HHMMSS.dump
docker compose -f docker-compose.prod.yml start api
```

## Updates

`git pull`, dann den Compose-Befehl aus Schritt 2 erneut ausführen. Migrationen laufen automatisch.

## Lokale Entwicklung (Windows ohne Docker)

`node scripts/dev-postgres.mjs` (eingebettetes PostgreSQL), `npm run db:seed`, `npm run dev:api-mock` (API mit In-Memory-Redis, nur Entwicklung), `npm run dev:web`.
