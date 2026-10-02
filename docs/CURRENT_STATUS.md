# Aktueller Stand

Stand: 2026-10-02. Ehrliche Übersicht, was fertig, was getestet und was offen ist.

## Fertig und automatisch getestet (API: 267 Tests, Shared: 263 Tests)

| Bereich | Inhalt |
| --- | --- |
| Auth | Steam-OpenID (eigene Verifikation), Sessions, CSRF, Rollen/Rechte, Rate-Limits |
| Matches | Generische Match-Engine (Team A/B, beliebige Teamgrößen), kein Ready-System, Veto, `MAP_FORCED`, Pause, Ergebnisvalidierung, Elo genau einmal |
| Match-Control | Admin und Party-Leader haben dieselben Rechte; jede Aktion im Audit-Log mit Rolle |
| Turniere | Single/Double Elimination, Byes, Grand-Final-Reset, Registrierung, Auto-Seeding |
| Parties | Party → Spieler → Teams → Map → Server → „MIT SERVER VERBINDEN“ |
| Teams | Gründen, Einladen, Kapitän, Logo-Upload (Magic-Byte-Prüfung) |
| Skins | Preis-Level, Pattern (0–1000, ganze Zahl), virtuelles Inventar, max. 3 Loadouts, Share-Codes, `!skch` |
| Admin | Dashboard, Spieler/Elo/Rank, Bans, Rollen (Owner-Schutz), Audit, Einstellungen, Rank-Stufen, verschlüsselte Webhooks |
| Realtime | Socket.IO (`/realtime`), nur „hat sich geändert“-Signale, Origin-Prüfung |
| Jobs | BullMQ: Match-Ticker, Skin-Rechte-Ablauf, Session-Purge, Event-Cleanup, Skin-Preis/Katalog-Sync |
| Mock-CS2-Server | Spricht das echte signierte Protokoll; End-to-End-Test gegen echte HTTP-API |
| Seed | 20 Spieler, 4 Teams, 2 Turniere, 10 Matches (nur Demo, idempotent) |

## Geschrieben, aber NICHT geprüft

- **CS2-Plugin (C#)**: konnte nicht kompiliert werden (auf dem Entwicklungsrechner fehlt das .NET-SDK) und lief nie auf einem echten CS2-Server. Das Protokoll ist durch den Mock-Server gegen die API abgesichert, die CounterStrikeSharp-Aufrufe (Events, Team-Wechsel, Pause, Statistiken) sind es nicht. Das Skin-Modul ist standardmäßig aus und besonders unsicher.
- **Docker/Compose/Caddy/Backups**: Dateien vorhanden, nie gebaut oder gestartet.
- **Redis-Adapter für Socket.IO** und **BullMQ-Worker**: Code vorhanden, nicht gegen echtes Redis getestet (Tests nutzen `ioredis-mock`).
- **Web-App**: Build und Typecheck laufen, Startseite, Admin-Dashboard geprüft. Die übrigen Seiten wurden noch nicht einzeln im Browser durchgeklickt.

## Offen

- Admin-UI für Turnier-Wizard, Server-Verwaltung, Rollen, Webhooks (die API dafür existiert).
- ESLint/Prettier-Läufe, Web-Tests.
- Matchmaking-Queue (nicht in v1).
- Wingman: **Coming Soon** (nur Seite, keine Logik).

## Erweiterung 2.2 – Umsetzungsstand

Flexible Teamgrößen ✔ · Manuelle Teamzuweisung (Buttons + Drag & Drop) ✔ · Map-Force ✔ · Pattern-Validierung ✔ · Virtuelles Inventar ✔ · Max. 3 Loadouts ✔ · Website-first Flow ✔ · Audit ✔ · Wingman = Coming Soon ✔ · Plugin-Re-Validierung (Join-Check, `NOT_ASSIGNED`) im Backend ✔, im Plugin ungetestet.
