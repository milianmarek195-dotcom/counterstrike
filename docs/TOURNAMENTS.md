# Turniere und Match-Engine

## Generische Match-Engine

Ein Match besteht aus `Match → MatchTeam A/B → MatchPlayer[]`. Jede Seite hat ein eigenes `maxPlayers` (1–16), 1v1, 2v3 oder 5v5 funktionieren gleich. Die Engine kennt keine Turniere: Turniere, Party-Matches (`CUSTOM`) und später Matchmaking erzeugen alle dasselbe Match.

## Status-Maschine

`SCHEDULED → WAITING → LOBBY → VETO | MAP_FORCED → CONFIGURING → LIVE → FINISHED`, dazu `CANCELLED` und `SERVER_ERROR`.

- **Kein Ready-Check.** Nach der Server-Zuweisung geht ein Turnier-Match automatisch ins Veto; ein Party-Match wartet in der `LOBBY` auf die manuelle Steuerung.
- **`MAP_FORCED`**: Die Map wird vom Controller gesetzt und überspringt das Veto. Backend prüft Recht, Match-Status (nur Setup-Phase), Map im Pool und Server-Verfügbarkeit; das Plugin prüft erneut.
- Maps können nur im Setup geändert werden; ein laufendes Match wird nie inkonsistent.

## Match-Control (Admin = Party-Leader)

Starten/Beenden, Server zuweisen, Spieler verschieben (`UNASSIGNED` / `TEAM A` / `TEAM B`), Map erzwingen, Veto starten/überspringen, Pause/Fortsetzen, Spieler entfernen/hinzufügen, Konfiguration. Admins brauchen das Recht `match.control`, der Party-Leader ist Controller seines Matches. **Jede** Aktion steht im Audit-Log (Akteur, Rolle, Aktion, Ziel, Match, alter/neuer Wert, Zeit).

## Verbinden

Der Server erscheint nur zugewiesenen Spielern („MIT SERVER VERBINDEN“). Beim Join fragt das Plugin `POST /server/v1/players/authorize`; Backend antwortet `NOT_IN_MATCH`, `NOT_ASSIGNED`, `REMOVED_FROM_MATCH`, `BANNED` oder `allowed` → sonst **ACCESS DENIED**.

## Turnierformate

Single und Double Elimination (Byes, Lower Bracket, Grand-Final-Reset, optional Best-of für Finale). Der Bracket-Generator ist reine Logik in `packages/shared/src/bracket`; der Snapshot liegt in `Tournament.settings.bracket`. Round Robin/Swiss sind nicht freigeschaltet.

## Elo

Nur gewertete Matches (Turnier, Matchmaking) verändern Elo; Party-/Custom-Matches sind ungewertet. Die Anwendung läuft in einer Transaktion mit Zeilensperren und einem Unique-Key `(matchId,userId)` – doppelte Auslieferung wendet Elo nie doppelt an (getestet mit 3 parallelen Ergebnissen).

## Wingman Cup – Coming Soon

Es gibt nur die Seite `/wingman`. Keine Wingman-Logik, keine Brackets, keine Automatisierung. Die Architektur erlaubt es später (`GameMode.WINGMAN`, `teamSize`), das Schema lehnt Wingman-Turniere heute mit „coming soon“ ab.
