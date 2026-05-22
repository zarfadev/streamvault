#!/usr/bin/env bash
# =============================================================================
#  StreamVault — Script de Optimización para Producción
#  Corre en el servidor: bash /opt/streamvault/optimize.sh
# =============================================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "${GREEN}  ✔  $*${NC}"; }
info() { echo -e "${CYAN}  ➜  $*${NC}"; }
warn() { echo -e "${YELLOW}  ⚠  $*${NC}"; }
hdr()  { echo -e "\n${BOLD}══════════════════════════════════════════════${NC}"; \
         echo -e "${BOLD}  $*${NC}"; \
         echo -e "${BOLD}══════════════════════════════════════════════${NC}\n"; }

APP_DIR="/opt/streamvault"
COMPOSE="docker compose -f ${APP_DIR}/docker-compose.prod.yml"

# ─── 1. Actualizar yt-dlp ────────────────────────────────────────────────────
hdr "1/7 — ACTUALIZAR YT-DLP"
curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o /usr/local/bin/yt-dlp
chmod a+rx /usr/local/bin/yt-dlp
ok "yt-dlp $(yt-dlp --version)"

# ─── 2. Actualizar código desde GitHub ──────────────────────────────────────
hdr "2/7 — GIT PULL (últimos cambios)"

cd "$APP_DIR"
git fetch origin main
git reset --hard origin/main
ok "Código actualizado desde GitHub (import.js con anti-bot yt-dlp incluido)"

# ─── 3. Optimizar .env para alta carga ───────────────────────────────────────
hdr "3/7 — OPTIMIZAR CONFIGURACIÓN"

NCPUS=$(nproc)
WORKERS=$(( NCPUS > 2 ? NCPUS - 2 : 1 ))

# Actualizar pool de DB — más conexiones para más usuarios
grep -q "^DB_POOL_MAX=" "${APP_DIR}/.env" && \
  sed -i "s/^DB_POOL_MAX=.*/DB_POOL_MAX=20/" "${APP_DIR}/.env" || \
  echo "DB_POOL_MAX=20" >> "${APP_DIR}/.env"

# Workers según CPUs disponibles
sed -i "s/^WORKER_CONCURRENCY=.*/WORKER_CONCURRENCY=${WORKERS}/" "${APP_DIR}/.env"

ok "DB_POOL_MAX=20, WORKER_CONCURRENCY=${WORKERS} (${NCPUS} vCPU detectados)"

# ─── 4. Optimizar Nginx para alta concurrencia ───────────────────────────────
hdr "4/7 — OPTIMIZAR NGINX"

cat > /etc/nginx/conf.d/streamvault-perf.conf << 'NGINXPERF'
# Optimizaciones de rendimiento para StreamVault
worker_processes auto;
worker_rlimit_nofile 65535;

events {
    worker_connections 4096;
    multi_accept on;
    use epoll;
}
NGINXPERF

# Ajustar worker_processes y worker_connections en nginx.conf principal
sed -i 's/worker_processes.*/worker_processes auto;/' /etc/nginx/nginx.conf
sed -i 's/worker_connections.*/worker_connections 4096;/' /etc/nginx/nginx.conf

# Optimizaciones TCP en nginx.conf
if ! grep -q "tcp_nopush" /etc/nginx/nginx.conf; then
cat >> /etc/nginx/nginx.conf << 'NGINXTCP'

# Optimizaciones TCP
tcp_nopush on;
tcp_nodelay on;
keepalive_timeout 65;
keepalive_requests 1000;
reset_timedout_connection on;
client_body_timeout 60s;
send_timeout 60s;
NGINXTCP
fi

# Aumentar límite de archivos abiertos
if ! grep -q "worker_rlimit_nofile" /etc/nginx/nginx.conf; then
  sed -i '1s/^/worker_rlimit_nofile 65535;\n/' /etc/nginx/nginx.conf
fi

nginx -t 2>/dev/null && systemctl reload nginx
ok "Nginx optimizado para alta concurrencia"

# ─── 5. Optimizar sistema operativo ──────────────────────────────────────────
hdr "5/7 — OPTIMIZAR SISTEMA OPERATIVO"

cat > /etc/sysctl.d/99-streamvault.conf << 'SYSCTL'
# Optimizaciones de red para alta concurrencia
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.tcp_fin_timeout = 10
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_probes = 5
net.ipv4.tcp_keepalive_intvl = 15
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_tw_reuse = 1
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
fs.file-max = 1000000
SYSCTL

sysctl -p /etc/sysctl.d/99-streamvault.conf > /dev/null 2>&1
ok "Parámetros del kernel optimizados"

# Aumentar límite de archivos para el proceso Docker
if ! grep -q "DefaultLimitNOFILE" /etc/systemd/system.conf 2>/dev/null; then
  echo "DefaultLimitNOFILE=65535" >> /etc/systemd/system.conf
fi
systemctl daemon-reexec 2>/dev/null || true
ok "Límite de archivos del sistema aumentado"

# ─── 6. Optimizar Redis ──────────────────────────────────────────────────────
hdr "6/7 — OPTIMIZAR REDIS"

redis-cli CONFIG SET maxmemory "2gb" > /dev/null
redis-cli CONFIG SET maxmemory-policy "allkeys-lru" > /dev/null
redis-cli CONFIG SET save "" > /dev/null
redis-cli CONFIG SET hz 20 > /dev/null
redis-cli CONFIG SET protected-mode no > /dev/null

# Persistir en redis.conf
sed -i 's/^save.*//g' /etc/redis/redis.conf
sed -i 's/^protected-mode yes/protected-mode no/' /etc/redis/redis.conf

if ! grep -q "^maxmemory " /etc/redis/redis.conf; then
  echo "maxmemory 2gb" >> /etc/redis/redis.conf
  echo "maxmemory-policy allkeys-lru" >> /etc/redis/redis.conf
fi

systemctl restart redis-server
ok "Redis optimizado (maxmemory 2gb, LRU eviction)"

# ─── 7. Rebuild y reiniciar contenedores ─────────────────────────────────────
hdr "7/7 — REBUILD Y REINICIO"

cd "$APP_DIR"

info "Parando contenedores..."
$COMPOSE down

info "Reconstruyendo imagen con los cambios..."
sudo docker compose -f docker-compose.prod.yml build --no-cache api

info "Arrancando todo..."
$COMPOSE up -d

info "Esperando que la API esté lista (30s)..."
sleep 30

HEALTH=$(curl -sf http://localhost:3000/api/health 2>/dev/null || echo '{}')
STATUS=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','?'))" 2>/dev/null || echo "error")

if [[ "$STATUS" == "ok" ]]; then
  ok "Servidor corriendo — status: OK"
else
  warn "Status: ${STATUS} — revisa los logs: docker compose -f ${APP_DIR}/docker-compose.prod.yml logs api --tail=30"
fi

echo "$HEALTH" | python3 -m json.tool 2>/dev/null || true

# ─── Resumen ─────────────────────────────────────────────────────────────────
hdr "OPTIMIZACIÓN COMPLETADA"

echo -e "  ${BOLD}vCPU:${NC}              ${NCPUS}"
echo -e "  ${BOLD}Workers FFmpeg:${NC}    ${WORKERS}"
echo -e "  ${BOLD}DB Pool:${NC}           20 conexiones"
echo -e "  ${BOLD}Redis maxmemory:${NC}   2 GB"
echo -e "  ${BOLD}Nginx workers:${NC}     auto (${NCPUS} procesos)"
echo -e "  ${BOLD}yt-dlp:${NC}            $(yt-dlp --version)"
echo
echo -e "  ${YELLOW}Para importar YouTube sin errores de bot, sube cookies:${NC}"
echo -e "  1. Instala 'Get cookies.txt LOCALLY' en Chrome"
echo -e "  2. Ve a youtube.com logueado → exporta cookies.txt"
echo -e "  3. Copia al servidor:"
echo -e "     ${CYAN}scp cookies.txt ubuntu@IP:/opt/streamvault/cookies.txt${NC}"
echo -e "  4. Monta en docker-compose (ya está configurado si existe el archivo)"
echo
