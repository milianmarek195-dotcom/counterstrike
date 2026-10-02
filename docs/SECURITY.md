# Sicherheit

- **Login**: Steam-OpenID mit eigener Verifikation (State-Cookie, einmalige Nonce, `check_authentication`, Endpoint/return_to/claimed_id gepinnt).
- **Sessions**: zufällige Tokens, nur der SHA-256-Hash liegt in der DB; HttpOnly, SameSite=Lax; idle 7 Tage / absolut 30 Tage; max. 10 pro Nutzer; Ban beendet alle Sessions.
- **CSRF**: pro Session ein HMAC-Token (Header `x-csrf-token`) plus Origin-Prüfung bei allen schreibenden Aufrufen.
- **Rechte**: Jede Route muss `@Public`, `@Authenticated`, `@RequirePermission` oder `@ServerOnly` tragen – ein Test bricht sonst. Admin-Routen sind nur per Permission erreichbar. Letzter Owner und Owner-Rolle sind geschützt.
- **Validierung**: alle Eingaben serverseitig mit Zod; einheitliches Fehlerformat; DB-CHECK-Constraints für Pattern, Float, Teamgrößen.
- **Game-Server**: HMAC-SHA256-Signatur je Request, ±30 s, Nonce-Replay-Schutz, Schlüssel pro Server (HKDF), rotierbar. Ergebnisse haben Idempotency-Keys und Plausibilitätsprüfung.
- **Rate-Limits**: Redis-Fixed-Window pro Route-Gruppe.
- **Secrets**: Webhook-URLs AES-256-GCM-verschlüsselt, nie im Klartext ausgeliefert.
- **Uploads**: Team-Logos nur PNG/JPEG/WebP per Magic-Bytes, max. 512 KB, `nosniff`.
- **Realtime**: Origin-Prüfung gegen Cross-Site-WebSocket-Hijacking; Räume liefern nur Änderungs-Signale, Daten holt der Client per REST.
- **Dev-Login** (`/v1/dev/login`) existiert nur im lokalen Dev-Start (`dev-main.ts`), nicht im Produktions-Einstieg.

Sicherheitslücken bitte privat an den Betreiber melden.
