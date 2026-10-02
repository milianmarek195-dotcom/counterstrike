# API

Basis: `/v1`, JSON, Cookie `celtist_session`, bei Schreibaufrufen Header `x-csrf-token` (aus `GET /v1/auth/me`). Fehler: `{ "error": "CODE", "message": "…", "details"?, "requestId"? }`.

| Gruppe | Routen |
| --- | --- |
| Auth | `GET auth/steam/login`, `GET auth/steam/callback`, `POST auth/logout`, `GET auth/me`, `GET/DELETE auth/sessions` |
| Turniere | `GET tournaments`, `:id`, `:id/bracket`, `:id/matches`, `POST/DELETE :id/register` |
| Matches | `GET matches`, `:id`, `:id/scoreboard`, `:id/veto`, `POST :id/veto` |
| Match-Control | `POST matches/:id/control/{force-map,start-veto,skip-veto,start,pause,unpause,resume,restart,end,assign-server,assign-team,add-player,remove-player,config,change-map}` (Admin oder Party-Leader) |
| Parties | `GET parties/me`, `POST parties`, `invite`, `invites/:id/accept\|decline`, `leave`, `kick`, `transfer-leadership`, `match`, `DELETE parties` |
| Teams | `GET/POST teams`, `me`, `:id`, `:id/logo`, `invite`, `kick`, `leave`, `captain`, `DELETE :id` |
| Spieler | `players`, `:steamId`, `:steamId/stats`, `:steamId/matches`, `ranking`, `ranking/tiers` |
| Skins | `skins`, `stickers`, `skin-access`, `inventory`, `loadouts` (inkl. `activate`, `share-code`, `import`, `export`) |
| Admin | `admin/{dashboard,players,bans,roles,audit,settings,rank-tiers,webhooks,servers,maps,tournaments,matches,skins}` |
| Game-Server | `server/v1/{heartbeat,commands,events,matches/:id/result,matches/:id/config,players/authorize,loadouts/:steamId,skin-permissions}` (HMAC-signiert, siehe `PLUGIN.md`) |
| Realtime | Socket.IO `/realtime`; Nachrichten `subscribe`/`unsubscribe` mit Raum `match`, `tournament`, `live`, `servers`; Event `event` |

Gesundheit: `GET /health`, `GET /health/ready`.
