#!/usr/bin/env bash
# DH Trails on a server that already runs Caddy (the LAIN server). Run as root.
#   First install:  DH_ORGANIZERS=organizer@example.com bash /opt/dhtrails/deploy/vps/setup.sh
#   Update:         dhtrails-update            (runs this again; data and secrets are kept)
#   Other branch:   DH_BRANCH=feature/x dhtrails-update   (remembered in /etc/dhtrails/branch)
set -euo pipefail

REPO=https://github.com/webtilians/dhtrailslocal.git
APP=/opt/dhtrails
VENV=/opt/dhtrails-venv
DATA=/var/lib/dhtrails
CONF=/etc/dhtrails
ENV_FILE=$CONF/dhtrails.env

step() { printf '\n== %s\n' "$*"; }

main() {
  [ "$(id -u)" -eq 0 ] || { echo "Ejecuta este script como root." >&2; exit 1; }
  cd /
  install -d -o root -g root -m 700 "$CONF"
  local branch host ip
  branch=${DH_BRANCH:-$(cat "$CONF/branch" 2>/dev/null || echo master)}
  host=${DH_HOST:-$(cat "$CONF/host" 2>/dev/null || true)}
  if [ -z "$host" ]; then
    # Free HTTPS name next to LAIN's: 1.2.3.4 -> dh.1-2-3-4.sslip.io resolves back to this IP.
    ip=$(ip -4 route get 1.1.1.1 | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}')
    host=dh.${ip//./-}.sslip.io
  fi
  echo "$branch" > "$CONF/branch"
  echo "$host" > "$CONF/host"

  step "Paquetes del sistema"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q --no-upgrade postgresql python3-venv git curl

  step "Usuario y carpetas"
  id dhtrails >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin dhtrails
  install -d -o dhtrails -g dhtrails -m 700 "$DATA" "$DATA/activities"
  install -d -o root -g root -m 700 /var/backups/dhtrails

  step "Código ($branch)"
  [ -d "$APP/.git" ] || git clone -q "$REPO" "$APP"
  git -C "$APP" fetch -q origin "+refs/heads/$branch:refs/remotes/origin/$branch"
  git -C "$APP" checkout -q -B "$branch" "origin/$branch"
  git -C "$APP" reset -q --hard "origin/$branch"
  [ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q --disable-pip-version-check -r "$APP/backend/requirements.txt"

  step "PostgreSQL"
  # The service logs in as the system user dhtrails through the local socket: no password exists.
  systemctl enable -q --now postgresql
  runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='dhtrails'" | grep -q 1 \
    || runuser -u postgres -- createuser dhtrails
  runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='dhtrails'" | grep -q 1 \
    || runuser -u postgres -- createdb -O dhtrails dhtrails

  step "Configuración"
  if [ ! -f "$ENV_FILE" ]; then
    [ -n "${DH_ORGANIZERS:-}" ] || { echo "Primera instalación: indica DH_ORGANIZERS=correo-del-organizador" >&2; exit 1; }
    install -m 600 /dev/null "$ENV_FILE"
    cat > "$ENV_FILE" <<EOF
# DH Trails, written once by setup.sh. After editing: systemctl restart dhtrails
DATABASE_URL=postgresql+psycopg://dhtrails@/dhtrails?host=/var/run/postgresql
SECRET_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')
CORS_ORIGINS=https://$host,https://webtilians.github.io
GPS_STORAGE_DIR=$DATA/activities
LOCAL_SINGLE_USER=false
ORGANIZER_EMAILS=$DH_ORGANIZERS
INVITE_CODE=
COMPETITION_TIMEZONE=Europe/Madrid
PYTHONDONTWRITEBYTECODE=1
EOF
  else
    echo "Se conserva $ENV_FILE"
  fi

  step "Servicio"
  install -m 755 "$APP"/deploy/vps/bin/* /usr/local/sbin/
  install -m 644 "$APP"/deploy/vps/systemd/* /etc/systemd/system/
  systemctl daemon-reload
  # Keep a copy of the data from before this update.
  if systemctl is-active -q dhtrails; then dhtrails-backup; fi
  systemctl enable -q dhtrails.service dhtrails-backup.timer
  systemctl restart dhtrails.service
  systemctl start dhtrails-backup.timer

  step "Caddy ($host)"
  install -d -m 755 /etc/caddy/sites.d
  sed "s/__HOST__/$host/" "$APP/deploy/vps/dhtrails.caddy" > /etc/caddy/sites.d/dhtrails.caddy
  # LAIN's Caddyfile template imports sites.d; add the line meanwhile so this site works right away.
  grep -qxF 'import /etc/caddy/sites.d/*.caddy' /etc/caddy/Caddyfile \
    || printf '\n# Other sites on this server, one file each.\nimport /etc/caddy/sites.d/*.caddy\n' >> /etc/caddy/Caddyfile
  local check
  if ! check=$(caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1); then
    echo "$check" >&2
    rm -f /etc/caddy/sites.d/dhtrails.caddy
    echo "Caddy no acepta la configuración: se ha retirado el sitio de DH Trails y LAIN sigue igual." >&2
    exit 1
  fi
  systemctl reload caddy

  step "Comprobación"
  local ok=""
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 5 "https://$host/api/health" >/dev/null 2>&1; then ok=1; break; fi
    sleep 3
  done
  echo
  if [ -n "$ok" ]; then
    echo "LISTO: https://$host/competicion.html"
  else
    echo "DH Trails arrancó, pero https://$host aún no responde."
    echo "Revisa: systemctl status dhtrails caddy; journalctl -u dhtrails -n 50  (el certificado puede tardar un minuto)"
  fi
  git -C "$APP" log -1 --format='Versión: %h %s'
  echo "Código de invitación para los pilotos: dhtrails-invite"
}

main "$@"
