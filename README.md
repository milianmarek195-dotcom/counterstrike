# Celtist – CS2 Turnierplattform

Monorepo: Web (Next.js), API (NestJS + Prisma + PostgreSQL + Redis), CS2-Plugin (CounterStrikeSharp), Mock-Server.

| Ordner | Inhalt |
| --- | --- |
| `apps/api` | REST, Socket.IO, Server-Gateway, Jobs |
| `apps/web` | Next.js-Oberfläche inkl. Admin |
| `packages/shared` | Regeln, Elo, Bracket, Veto, Schemas (isoliert testbar) |
| `packages/database` | Prisma-Schema, Migrationen, Seed |
| `plugins/CeltistTournament` | CS2-Plugin (C#, ungetestet) |
| `services/mock-cs2-server` | simulierter Spieleserver |
| `docker`, `docker-compose*.yml` | Betrieb |
| `docs` | Dokumentation |

## Schnellstart (Entwicklung, Windows/PowerShell)

```powershell
npm install
npm run bootstrap
node scripts/dev-postgres.mjs        # eigenes Fenster/Hintergrund
npm run db:seed
npm run dev:api-mock                 # API auf :4000 (In-Memory-Redis)
npm run dev:web                      # Web auf :3000
```

Tests: `npm test`. Der API-Test startet sein eigenes PostgreSQL.

## Dokumentation

[Aktueller Stand](docs/CURRENT_STATUS.md) · [Architektur](docs/ARCHITECTURE.md) · [Turniere & Matches](docs/TOURNAMENTS.md) · [Skins](docs/SKIN_SYSTEM.md) · [Plugin](docs/PLUGIN.md) · [Deployment](docs/DEPLOYMENT.md) · [Ubuntu](docs/UBUNTU_SETUP.md) · [Sicherheit](docs/SECURITY.md) · [Fehlersuche](docs/TROUBLESHOOTING.md) · [API](docs/API.md)

Wingman Cups sind **Coming Soon** (nur Seite, keine Logik).
