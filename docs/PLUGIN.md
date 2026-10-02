# CS2-Plugin (CeltistTournament)

C# / .NET 8, Metamod + CounterStrikeSharp (API 1.0.376). Quellen: `plugins/CeltistTournament`.

> **Status:** nicht kompiliert und nie auf einem echten Server getestet (siehe `CURRENT_STATUS.md`). Das Wire-Protokoll ist durch den Mock-Server und Integrationstests abgesichert.

## Build

```powershell
cd plugins\CeltistTournament
dotnet publish -c Release
```

Benötigt das .NET-8-SDK. Das Ergebnis (`CeltistTournament.dll`) kommt nach `game/csgo/addons/counterstrikesharp/plugins/CeltistTournament/`.

## Konfiguration

`configs/plugins/CeltistTournament/CeltistTournament.json`: `ApiUrl`, `ServerId`, `ApiKey` (Hex, wird beim Anlegen/Rotieren des Servers im Admin-Panel **einmalig** angezeigt), `HeartbeatSeconds`, `CommandWaitSeconds`, `DenyMessage`, `SkinsEnabled` (Standard aus).

## Protokoll

Alle Aufrufe sind HMAC-signiert: `HMAC-SHA256(key, METHOD \n pfad+query \n timestampMs \n nonce \n sha256hex(body))` in den Headern `x-celtist-server/-timestamp/-nonce/-signature`. Zeitversatz max. ±30 s, Nonces nur einmal gültig. Schlüssel = HKDF(`SERVER_API_SECRET`, serverId, `celtist-server-key-v{n}`).

| Aufruf | Zweck |
| --- | --- |
| `POST /server/v1/heartbeat` | alle 10 s, Status/Spieler/Health |
| `GET /server/v1/commands?wait=25` | Long-Poll; danach `POST …/commands/:id/ack` |
| `POST /server/v1/events` | Batches mit Idempotency-Key (Outbox mit Retry) |
| `POST /server/v1/matches/:id/result` | signiertes Kartenergebnis, stabiler Key, Retry bis zur Antwort |
| `GET /server/v1/matches/:id/config` | Roster, Maps, Regeln |
| `POST /server/v1/players/authorize` | Join-Prüfung, **fail closed** |
| `GET /server/v1/loadouts/:steamId`, `POST …/skin-permissions` | Skins, `!skch` |

## Befehle des Backends

`MATCH_PREPARE`, `MATCH_START`, `MATCH_RESUME`, `MATCH_RESTART`, `MATCH_PAUSE`, `MATCH_UNPAUSE`, `MATCH_CANCEL`, `MATCH_CHANGE_MAP`, `MATCH_FORCE_TEAM`, `MATCH_REMOVE_PLAYER`, `MATCH_PARDON_PLAYER`, `MATCH_SET_SCORE`, `PLAYER_REFRESH_SKINS`, `SERVER_RELOAD_CONFIG`.

## Chat-Befehle

`!pause` / `!unpause` (Spieler des Matches; begrenzte Pausen pro Team, Unpause durch Admins), `!nobans` (Admin: Team-Damage-Strafen an/aus), `!pardon <Spieler>`, `!skch <Level> <Spieler|all> [Min]`.

## Mock-Server

`services/mock-cs2-server` simuliert einen Server ohne Spiel: `MOCK_SERVER_ID` und `MOCK_SERVER_KEY` setzen, dann `npm run dev:mock-server`.
