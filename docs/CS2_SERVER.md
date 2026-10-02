# CS2-Spieleserver anbinden

1. Dedizierten CS2-Server installieren (SteamCMD, App 730) und **Metamod:Source** sowie **CounterStrikeSharp** (mit Runtime) einrichten.
2. Im Admin-Panel einen Server anlegen (Name, IP, Port, Region). **Server-ID und API-Key werden nur einmal angezeigt**; Rotation über „Key rotieren“ (alter Key ungültig).
3. Plugin bauen/kopieren und `CeltistTournament.json` ausfüllen (siehe `PLUGIN.md`).
4. Server starten: Er sendet Heartbeats; im Admin-Dashboard erscheint er als `READY`. Bleibt der Heartbeat länger als ~30 s aus, gilt er als `OFFLINE`.
5. Firewall: Der Spieleserver braucht nur ausgehend HTTPS zur API; Spieler verbinden über den Spielport (UDP/TCP 27015).

Empfohlen: `sv_password` ungesetzt lassen – der Zutritt wird über die Join-Prüfung des Plugins geregelt („ACCESS DENIED“ für nicht zugewiesene SteamIDs).
