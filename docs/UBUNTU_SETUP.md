# Ubuntu-Server einrichten (22.04 / 24.04)

> Nicht auf einem echten Server getestet.

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install ca-certificates curl git ufw
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # danach neu einloggen
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
git clone https://github.com/milianmarek195-dotcom/counterstrike.git celtist && cd celtist
cp .env.example .env && node scripts/generate-secrets.mjs   # Node 22+ nötig, sonst Secrets manuell erzeugen (openssl rand -base64 48)
nano .env
docker compose -f docker-compose.prod.yml --env-file .env up -d --build
```

Nur 22, 80 und 443 sind von außen offen; Datenbank und Redis veröffentlichen keine Ports. Weiter: `DEPLOYMENT.md` (Backups, Updates) und `CS2_SERVER.md` (Spieleserver).
