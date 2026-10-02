# Skin-System

## Level nach Marktpreis

Standard: unter 250 $ → Level 1, unter 1000 $ → Level 2, darüber oder unbekannter Preis → Level 3 (konfigurierbar in `skin.thresholds`). Ein Spieler darf Skins bis zu seinem Level nutzen. Preise kommen aus Skinport (`SKIN_PRICE_PROVIDER`); fällt der Anbieter aus, bleiben die alten Preise erhalten.

## Rechte

Admins mit `skin.assign` vergeben Level, optional Sticker-Crafts, Float-Bearbeitung und Loadouts, mit Ablauf (15 min, 1 h, 2 h, 1 Tag, 7 Tage, permanent, benutzerdefiniert). Der Ablauf wird beim Lesen ausgewertet (kein Race mit dem Job). In-game: `!skch <Level 0-3> <Spieler|all> [Minuten]` – das Plugin leitet nur weiter, das Backend prüft `skin.assign` und das passende `skin.level.N`.

## Pattern / Paint Seed

Eine **ganze Zahl von 0 bis 1000** (z. B. `661`). Dezimalzahlen und negative Werte werden abgelehnt: im UI (Eingabefilter), im Backend (Zod) und zusätzlich per Datenbank-CHECK-Constraint.

## Virtuelles Inventar

Jedes Item: Waffe, Paint Kit, Float, Pattern, StatTrak (mit Zähler), Souvenir (nie beides), bis zu 5 Sticker mit Slot/Wear, Name-Tag, Zeitstempel. Limit `skin.maxInventoryItems`.

## Loadouts

Maximal **3** pro Spieler (`skin.maxLoadoutsPerUser`, Obergrenze 3). Ein Loadout wählt je Waffe ein Inventar-Item. Aktivieren, Duplizieren, Share-Code (`CELTIST-XXXXXX`), Import per Code, Export/Import als JSON (referenziert Skins über Waffe+Paint-Index, nicht über DB-IDs).

## Anwendung auf dem Server

`GET /server/v1/loadouts/:steamId` liefert den aktiven Loadout, **beim Abruf erneut nach aktuellem Level gefiltert** (`resolveLoadoutForApplication`). Ist `skinsEnabled` am Server aus, kommt nichts zurück. Das Plugin-Skin-Modul (`SkinsEnabled` in der Plugin-Config, Standard `false`) setzt Paint Kit, Seed, Wear und StatTrak per Fallback-Attributen. **Dieses Modul ist ungetestet** – vor produktivem Einsatz auf einem Testserver prüfen; Fehler lassen die Standard-Skins unberührt.
