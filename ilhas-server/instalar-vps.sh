#!/usr/bin/env bash
# =====================================================================
#  Ilhas do Portal — instalação completa numa VPS (Ubuntu 22.04 ou 24.04)
#
#  Como usar (no terminal da VPS, logado como root):
#    curl -fsSL https://raw.githubusercontent.com/edsonsantospronft-ship-it/Idle-NFT/main/ilhas-server/instalar-vps.sh | bash
#  Com um domínio seu (opcional):
#    curl -fsSL https://raw.githubusercontent.com/edsonsantospronft-ship-it/Idle-NFT/main/ilhas-server/instalar-vps.sh | bash -s -- meujogo.com.br
#
#  O que ele faz, em ordem:
#   1. Atualiza o Ubuntu e instala o básico (git, firewall).
#   2. Instala o Node.js 20 (o "motor" que roda o server.js).
#   3. Baixa o jogo do seu GitHub para /opt/ilhas.
#   4. Cria a pasta de dados /var/lib/ilhas (contas, saves, rankings — NUNCA é apagada).
#   5. Cria o arquivo de configuração /etc/ilhas.env (onde ficam chaves e tokens).
#   6. Cria o serviço "ilhas" no systemd: o jogo liga sozinho e reinicia se cair.
#   7. Instala o Caddy: coloca HTTPS (cadeado) automático na frente do jogo.
#   8. Liga o firewall (só portas 22, 80 e 443 abertas).
#   9. Faz backup diário da pasta de dados (guarda 14 dias).
#  10. Cria o comando "ilhas-atualizar" para puxar a versão nova do GitHub.
# =====================================================================
set -euo pipefail

REPO="https://github.com/edsonsantospronft-ship-it/Idle-NFT.git"
APP_DIR="/opt/ilhas"
DATA_DIR="/var/lib/ilhas"
ENV_FILE="/etc/ilhas.env"
PORT=3000

if [ "$(id -u)" -ne 0 ]; then echo "Rode como root (use: sudo -i)"; exit 1; fi

# Domínio: se você não passar um, usamos <IP>.sslip.io, que já funciona com HTTPS.
IP="$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')"
DOMAIN="${1:-${IP//./-}.sslip.io}"
echo "==> Instalando Ilhas do Portal em https://$DOMAIN"

echo "==> 1/10 Atualizando o sistema"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y curl git ufw ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

echo "==> 2/10 Instalando Node.js 20"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "==> 3/10 Baixando o jogo do GitHub"
id ilhas >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin ilhas
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull --ff-only; else git clone "$REPO" "$APP_DIR"; fi
cd "$APP_DIR/ilhas-server"
if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
chown -R ilhas:ilhas "$APP_DIR"

echo "==> 4/10 Pasta de dados permanente"
mkdir -p "$DATA_DIR"
chown -R ilhas:ilhas "$DATA_DIR"
chmod 700 "$DATA_DIR"

echo "==> 5/10 Arquivo de configuração"
if [ ! -f "$ENV_FILE" ]; then
  ADMIN_KEY_GERADA="$(openssl rand -hex 16)"
  cat > "$ENV_FILE" <<EOF
# Configuração do Ilhas do Portal.
# Depois de editar este arquivo, rode:  systemctl restart ilhas
PORT=$PORT
DATA_DIR=$DATA_DIR
PUBLIC_URL=https://$DOMAIN

# Senha do painel /admin (gerada agora; pode trocar)
ADMIN_KEY=$ADMIN_KEY_GERADA

# ---- Preencha você mesmo (copie os valores do Render > Environment) ----
GOOGLE_CLIENT_ID=
MP_ACCESS_TOKEN=
PIX_KEY=
PIX_NAME=
PIX_CITY=

# ---- Opcionais ----
# BLOCK_CAP=100
# PASS_PRICE=29.90
EOF
  chmod 600 "$ENV_FILE"
fi

echo "==> 6/10 Serviço do jogo (systemd)"
cat > /etc/systemd/system/ilhas.service <<EOF
[Unit]
Description=Ilhas do Portal (servidor do jogo)
After=network-online.target
Wants=network-online.target

[Service]
User=ilhas
WorkingDirectory=$APP_DIR/ilhas-server
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now ilhas
systemctl restart ilhas

echo "==> 7/10 Caddy (HTTPS automático)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    encode gzip
    reverse_proxy localhost:$PORT
}
EOF
systemctl reload caddy || systemctl restart caddy

echo "==> 8/10 Firewall"
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "==> 9/10 Backup diário dos dados (03:30, guarda 14 dias)"
mkdir -p /var/backups/ilhas
cat > /etc/cron.d/ilhas-backup <<'EOF'
30 3 * * * root tar -czf /var/backups/ilhas/dados-$(date +\%F).tar.gz -C /var/lib ilhas && find /var/backups/ilhas -name 'dados-*.tar.gz' -mtime +14 -delete
EOF

echo "==> 10/10 Comando de atualização"
cat > /usr/local/bin/ilhas-atualizar <<EOF
#!/usr/bin/env bash
set -e
cd $APP_DIR && git pull --ff-only
cd $APP_DIR/ilhas-server && (npm ci --omit=dev || npm install --omit=dev)
chown -R ilhas:ilhas $APP_DIR
systemctl restart ilhas
echo "Jogo atualizado e reiniciado."
EOF
chmod +x /usr/local/bin/ilhas-atualizar

sleep 3
echo
echo "=============================================================="
echo " PRONTO! O jogo está no ar em:  https://$DOMAIN"
echo "   (o cadeado HTTPS pode levar 1 minuto na primeira vez)"
echo
echo " Próximos passos:"
echo "  1. Coloque as chaves:   nano $ENV_FILE   (salvar: Ctrl+O, Enter, Ctrl+X)"
echo "  2. Reinicie o jogo:     systemctl restart ilhas"
echo "  3. No Google Cloud, adicione https://$DOMAIN nas origens do login."
echo
echo " Comandos úteis:"
echo "  ver se está rodando:    systemctl status ilhas"
echo "  ver os logs ao vivo:    journalctl -u ilhas -f"
echo "  atualizar do GitHub:    ilhas-atualizar"
echo "  senha do /admin:        grep ADMIN_KEY $ENV_FILE"
echo "=============================================================="
