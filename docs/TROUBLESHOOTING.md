# Fehlersuche

| Problem | Ursache / Lösung |
| --- | --- |
| API startet nicht, „env invalid“ | `.env` prüfen; die Fehlermeldung nennt die Variable (Secrets min. 32 Zeichen, `ENCRYPTION_KEY` = Base64 von 32 Bytes). |
| Login-Schleife / nicht angemeldet | `PUBLIC_WEB_URL`, `CORS_ORIGINS`, `COOKIE_DOMAIN` müssen zur Domain passen; in Produktion HTTPS. |
| Server bleibt `OFFLINE` | Uhrzeit des Spieleservers (±30 s), ApiKey/ServerId, Firewall ausgehend. Heartbeat-Antwort 401/403 im Plugin-Log. |
| Ergebnis wird mit 422 abgelehnt | Plausibilitätsprüfung (`DURATION_IMPLAUSIBLE`, Score/Runden passen nicht). Details stehen in der Antwort. |
| Spieler bekommt „ACCESS DENIED“ | Nicht dem Match oder keinem Team zugewiesen (`NOT_ASSIGNED`), entfernt oder gebannt. |
| Match bleibt in `WAITING` | Kein freier Server; der Ticker wartet. Server `READY` machen oder zuweisen. |
| Skins erscheinen nicht | Server-Flag `skinsEnabled`, `SkinsEnabled` in der Plugin-Config, Skin-Level des Spielers. |
| Windows: `&&` im PowerShell-Fehler | PowerShell 5.1 kennt `&&` nicht; Befehle einzeln oder mit `;` ausführen. |
| npm blockiert Install-Scripts | `npm approve-scripts <paket> --no-allow-scripts-pin`. |
| Steam-Login: `NONCE_INVALID` | Uhr des Servers weicht um mehr als 5 Minuten von Steam ab. `date -u` mit dem `Date`-Header von steamcommunity.com vergleichen, NTP/`timedatectl` reparieren. |
| Cloudflare „DNS points to prohibited IP“ | Im Tunnel zeigt die Route auf eine Adresse statt auf `http://localhost:<port>`, oder es gibt noch einen alten A-Eintrag für den Namen. |
| Plugin baut nicht: „CounterStrikeSharp.API 1.0.376 nicht kompatibel mit net8.0“ | Das Projekt muss `net10.0` zielen (steht so im Repo). SDK 10 nötig. |
