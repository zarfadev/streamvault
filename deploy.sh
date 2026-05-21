#!/usr/bin/env bash
# =============================================================================
#  StreamVault — Instalador de Producción
#  Corre este script en un servidor Ubuntu 22.04/24.04 limpio (como root o
#  con sudo). Tarda ~10 min en un servidor nuevo.
#
#  Uso:
#    curl -fsSL https://raw.githubusercontent.com/TU_REPO/streamvault/main/deploy.sh | bash
#    — o —
#    bash deploy.sh
# =============================================================================
set -euo pipefail

# ─── Colores ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

ok()   { echo -e "${GREEN}  ✔  $*${NC}"; }
info() { echo -e "${CYAN}  ➜  $*${NC}"; }
warn() { echo -e "${YELLOW}  ⚠  $*${NC}"; }
die()  { echo -e "${RED}  ✘  $*${NC}"; exit 1; }
hdr()  { echo -e "\n${BOLD}${BLUE}══════════════════════════════════════════════${NC}"; \
         echo -e "${BOLD}${BLUE}  $*${NC}"; \
         echo -e "${BOLD}${BLUE}══════════════════════════════════════════════${NC}\n"; }

ask() {
  # ask "Pregunta" VAR_NAME [default]
  local prompt="$1" var="$2" default="${3:-}"
  if [[ -n "$default" ]]; then
    echo -ne "${BOLD}  ${prompt}${NC} ${YELLOW}[${default}]${NC}: "
  else
    echo -ne "${BOLD}  ${prompt}${NC}: "
  fi
  read -r input
  if [[ -z "$input" && -n "$default" ]]; then
    eval "$var=\"\$default\""
  else
    eval "$var=\"\$input\""
  fi
}

ask_secret() {
  local prompt="$1" var="$2"
  echo -ne "${BOLD}  ${prompt}${NC} ${YELLOW}(oculto)${NC}: "
  read -rs input
  echo
  eval "$var=\"\$input\""
}

ask_yn() {
  local prompt="$1" var="$2" default="${3:-s}"
  echo -ne "${BOLD}  ${prompt}${NC} ${YELLOW}[s/n, default: ${default}]${NC}: "
  read -r input
  input="${input:-$default}"
  if [[ "$input" =~ ^[sySY]$ ]]; then
    eval "$var=true"
  else
    eval "$var=false"
  fi
}

# ─── Banner ───────────────────────────────────────────────────────────────────
clear
echo -e "${BOLD}"
cat << 'BANNER'
  ┌─────────────────────────────────────────────────┐
  │                                                 │
  │          StreamVault  ·  Deploy Script          │
  │          Instalador de Producción — AWS         │
  │                                                 │
  └─────────────────────────────────────────────────┘
BANNER
echo -e "${NC}"
echo -e "  Este script instala y configura StreamVault completo en producción."
echo -e "  Necesitas: servidor Ubuntu 22.04/24.04 + credenciales AWS + dominio.\n"

# ─── Verificaciones previas ───────────────────────────────────────────────────
hdr "VERIFICACIONES PREVIAS"

[[ "$(uname -s)" == "Linux" ]] || die "Este script solo funciona en Linux (Ubuntu/Debian)."

if [[ $EUID -ne 0 ]]; then
  # Reintentar con sudo
  warn "No eres root. Relanzando con sudo..."
  exec sudo -E bash "$0" "$@"
fi

# Detectar distribución
if ! grep -qiE "ubuntu|debian" /etc/os-release 2>/dev/null; then
  warn "Distribución no verificada. Continúa bajo tu responsabilidad."
fi

ok "Sistema operativo OK"

# ─── Configuración interactiva ────────────────────────────────────────────────
hdr "CONFIGURACIÓN"

echo -e "  Responde las preguntas. Pulsa ENTER para aceptar el valor por defecto.\n"

# Dominio
ask "Dominio de la aplicación (ej: app.miempresa.com)" DOMAIN
[[ -n "$DOMAIN" ]] || die "El dominio es obligatorio."
# Limpiar protocolo si el usuario lo incluyó
DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN%%/*}"
ok "Dominio: $DOMAIN"

# Email super-admin
ask "Email del super-administrador" SUPER_ADMIN_EMAIL "hola@myscreators.com"
[[ "$SUPER_ADMIN_EMAIL" =~ @ ]] || die "Email inválido."
ok "Super-admin: $SUPER_ADMIN_EMAIL"

echo
# ─── AWS ──────────────────────────────────────────────────────────────────────
hdr "AWS — CREDENCIALES Y RECURSOS"

echo -e "  StreamVault usa S3 para almacenar los videos transcodificados y"
echo -e "  CloudFront como CDN. Las credenciales deben tener permisos S3 + CloudFront.\n"

ask "AWS Access Key ID" AWS_ACCESS_KEY_ID
ask_secret "AWS Secret Access Key" AWS_SECRET_ACCESS_KEY
ask "Región AWS (ej: us-east-1, eu-west-1)" AWS_REGION "us-east-1"
ask "Nombre del bucket S3 (se crea si no existe)" S3_BUCKET "streamvault-media-prod"

[[ -n "$AWS_ACCESS_KEY_ID" ]]     || die "AWS_ACCESS_KEY_ID es obligatorio."
[[ -n "$AWS_SECRET_ACCESS_KEY" ]] || die "AWS_SECRET_ACCESS_KEY es obligatorio."

echo
ask_yn "¿Crear el bucket S3 y la distribución CloudFront automáticamente?" CREATE_AWS_INFRA "s"

echo
# ─── Base de datos ────────────────────────────────────────────────────────────
hdr "BASE DE DATOS — PostgreSQL"

echo -e "  Necesitas una URL de conexión PostgreSQL gestionada."
echo -e "  Recomendamos Neon (neon.tech — gratuito para empezar).\n"
echo -e "  Formato: ${CYAN}postgres://user:pass@host:5432/dbname?sslmode=require${NC}\n"

ask "DATABASE_URL" DATABASE_URL
[[ "$DATABASE_URL" =~ ^postgres ]] || die "DATABASE_URL debe empezar con postgres://"
ok "DATABASE_URL configurada"

echo
# ─── Redis ────────────────────────────────────────────────────────────────────
hdr "REDIS"

echo -e "  Necesitas una URL Redis con TLS. Recomendamos Upstash (upstash.com — gratuito)."
echo -e "  Formato: ${CYAN}rediss://default:TOKEN@host.upstash.io:6379${NC}\n"

ask "REDIS_URL" REDIS_URL
[[ "$REDIS_URL" =~ ^redis ]] || die "REDIS_URL debe empezar con redis:// o rediss://"
ok "REDIS_URL configurada"

echo
# ─── Email ────────────────────────────────────────────────────────────────────
hdr "EMAIL — SMTP"

echo -e "  Usado para enviar emails de bienvenida, recuperación de contraseña, etc."
echo -e "  Recomendamos SendGrid (smtp.sendgrid.net / puerto 587).\n"

ask_yn "¿Configurar SMTP ahora?" SETUP_SMTP "s"

if [[ "$SETUP_SMTP" == true ]]; then
  ask "SMTP_HOST" SMTP_HOST "smtp.sendgrid.net"
  ask "SMTP_PORT" SMTP_PORT "587"
  ask "SMTP_USER (para SendGrid es literalmente 'apikey')" SMTP_USER "apikey"
  ask_secret "SMTP_PASS (API key de SendGrid o contraseña SMTP)" SMTP_PASS
  ask "SMTP_FROM (dirección remitente)" SMTP_FROM "no-reply@${DOMAIN}"
else
  SMTP_HOST=""; SMTP_PORT="587"; SMTP_USER=""; SMTP_PASS=""; SMTP_FROM=""
  warn "Email no configurado — los emails se mostrarán en los logs del servidor."
fi

echo
# ─── dLocal Go ────────────────────────────────────────────────────────────────
hdr "PAGOS — DLOCAL GO (LATAM: tarjetas, transferencias, vouchers)"

echo -e "  Crea tu cuenta en ${CYAN}https://dlocalgo.com${NC}"
echo -e "  Credenciales: Dashboard → Integrations → API Integration"
echo -e "  Planes: Dashboard → Integrations → Subscriptions → Plans\n"

ask_yn "¿Configurar dLocal Go ahora?" SETUP_DLOCAL "s"

if [[ "$SETUP_DLOCAL" == true ]]; then
  ask_secret "DLOCALGO_API_KEY" DLOCALGO_API_KEY
  ask_secret "DLOCALGO_SECRET_KEY" DLOCALGO_SECRET_KEY
  echo -e "\n  ${YELLOW}Crea 3 planes en el dashboard dLocal Go (Starter/Pro/Enterprise)${NC}"
  echo -e "  y pega aquí los tokens de cada plan:\n"
  ask "Token del plan Starter" DLOCALGO_PLAN_STARTER ""
  ask "Token del plan Pro" DLOCALGO_PLAN_PRO ""
  ask "Token del plan Enterprise" DLOCALGO_PLAN_ENTERPRISE ""
  DLOCALGO_MODE="production"
  ok "dLocal Go configurado"
else
  DLOCALGO_API_KEY=""; DLOCALGO_SECRET_KEY=""
  DLOCALGO_PLAN_STARTER=""; DLOCALGO_PLAN_PRO=""; DLOCALGO_PLAN_ENTERPRISE=""
  DLOCALGO_MODE="sandbox"
  warn "dLocal Go omitido — puedes añadirlo después en .env"
fi

echo
# ─── Binance Pay ──────────────────────────────────────────────────────────────
hdr "PAGOS — BINANCE PAY (crypto: USDT/BTC, renovación automática 30 días)"

echo -e "  Crea tu cuenta merchant en ${CYAN}https://merchant.binance.com${NC}"
echo -e "  Obtén API Key y Secret en: Merchant Center → API Management\n"

ask_yn "¿Configurar Binance Pay ahora?" SETUP_BINANCE "s"

if [[ "$SETUP_BINANCE" == true ]]; then
  ask_secret "BINANCE_API_KEY (Certificate SN del merchant)" BINANCE_API_KEY
  ask_secret "BINANCE_SECRET_KEY" BINANCE_SECRET_KEY
  ask "BINANCE_MERCHANT_ID" BINANCE_MERCHANT_ID ""
  echo -e "\n  ${YELLOW}Precios en USDT para cada plan:${NC}\n"
  ask "Precio Starter (USDT/mes)" BINANCE_PRICE_STARTER "9.99"
  ask "Precio Pro (USDT/mes)" BINANCE_PRICE_PRO "29.99"
  ask "Precio Enterprise (USDT/mes)" BINANCE_PRICE_ENTERPRISE "99.99"
  BINANCE_MODE="live"
  ok "Binance Pay configurado"
else
  BINANCE_API_KEY=""; BINANCE_SECRET_KEY=""; BINANCE_MERCHANT_ID=""
  BINANCE_PRICE_STARTER="9.99"; BINANCE_PRICE_PRO="29.99"; BINANCE_PRICE_ENTERPRISE="99.99"
  BINANCE_MODE="sandbox"
  warn "Binance Pay omitido — puedes añadirlo después en .env"
fi

echo
# ─── Workers ──────────────────────────────────────────────────────────────────
hdr "WORKERS — CAPACIDAD DE TRANSCODIFICACIÓN"

NCPUS=$(nproc 2>/dev/null || echo 2)
DEFAULT_WORKERS=$(( NCPUS > 1 ? NCPUS - 1 : 1 ))
ask "Número de jobs FFmpeg en paralelo (tienes ${NCPUS} vCPU)" WORKER_CONCURRENCY "$DEFAULT_WORKERS"
ask "Número de jobs Whisper (subtítulos) en paralelo" TRANSCRIPTION_CONCURRENCY "1"

echo
# ─── Confirmación ─────────────────────────────────────────────────────────────
hdr "RESUMEN — CONFIRMAR INSTALACIÓN"

echo -e "  ${BOLD}Dominio:${NC}         https://${DOMAIN}"
echo -e "  ${BOLD}Super-admin:${NC}     ${SUPER_ADMIN_EMAIL}"
echo -e "  ${BOLD}AWS región:${NC}      ${AWS_REGION}"
echo -e "  ${BOLD}S3 bucket:${NC}       ${S3_BUCKET}"
echo -e "  ${BOLD}Crear infra AWS:${NC} ${CREATE_AWS_INFRA}"
echo -e "  ${BOLD}Workers FFmpeg:${NC}  ${WORKER_CONCURRENCY}"
echo -e "  ${BOLD}Workers Whisper:${NC} ${TRANSCRIPTION_CONCURRENCY}"
echo -e "  ${BOLD}SMTP:${NC}            $([ "$SETUP_SMTP" == true ] && echo "${SMTP_HOST}" || echo "deshabilitado")"
echo -e "  ${BOLD}dLocal Go:${NC}       $([ "$SETUP_DLOCAL" == true ] && echo "configurado" || echo "deshabilitado")"
echo -e "  ${BOLD}Binance Pay:${NC}     $([ "$SETUP_BINANCE" == true ] && echo "configurado" || echo "deshabilitado")"
echo

ask_yn "¿Proceder con la instalación?" PROCEED "s"
[[ "$PROCEED" == true ]] || { echo "Instalación cancelada."; exit 0; }

# =============================================================================
#  A PARTIR DE AQUÍ — INSTALACIÓN AUTOMÁTICA (sin más preguntas)
# =============================================================================

APP_DIR="/opt/streamvault"
LOG_FILE="/var/log/streamvault-deploy.log"

exec > >(tee -a "$LOG_FILE") 2>&1
echo -e "\n$(date '+%Y-%m-%d %H:%M:%S') — Inicio de instalación"

# ─── 1. Dependencias del sistema ──────────────────────────────────────────────
hdr "PASO 1/8 — DEPENDENCIAS DEL SISTEMA"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  curl wget git unzip gnupg2 ca-certificates lsb-release \
  software-properties-common apt-transport-https \
  nginx certbot python3-certbot-nginx \
  ufw htop
ok "Dependencias base instaladas"

# Docker
if ! command -v docker &>/dev/null; then
  info "Instalando Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
  ok "Docker instalado"
else
  ok "Docker ya está instalado ($(docker --version | cut -d' ' -f3 | tr -d ','))"
fi

# AWS CLI v2
if ! command -v aws &>/dev/null; then
  info "Instalando AWS CLI v2..."
  ARCH=$(uname -m)
  if [[ "$ARCH" == "aarch64" ]]; then
    AWS_ZIP_URL="https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip"
  else
    AWS_ZIP_URL="https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip"
  fi
  curl -fsSL "$AWS_ZIP_URL" -o /tmp/awscliv2.zip
  unzip -q /tmp/awscliv2.zip -d /tmp/
  /tmp/aws/install
  rm -rf /tmp/aws /tmp/awscliv2.zip
  ok "AWS CLI instalado"
else
  ok "AWS CLI ya instalado"
fi

# Configurar credenciales AWS
mkdir -p /root/.aws
cat > /root/.aws/credentials << AWSCREDS
[default]
aws_access_key_id = ${AWS_ACCESS_KEY_ID}
aws_secret_access_key = ${AWS_SECRET_ACCESS_KEY}
AWSCREDS
cat > /root/.aws/config << AWSCFG
[default]
region = ${AWS_REGION}
output = json
AWSCFG
chmod 600 /root/.aws/credentials
ok "Credenciales AWS configuradas"

# Firewall
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ok "Firewall configurado (22, 80, 443)"

# ─── 2. Infraestructura AWS (S3 + CloudFront) ────────────────────────────────
hdr "PASO 2/8 — INFRAESTRUCTURA AWS"

CLOUDFRONT_BASE_URL=""
CLOUDFRONT_DISTRIBUTION_ID=""

if [[ "$CREATE_AWS_INFRA" == true ]]; then
  # Verificar conectividad AWS
  info "Verificando credenciales AWS..."
  if ! aws sts get-caller-identity --query Account --output text &>/dev/null; then
    die "Las credenciales AWS no son válidas o no tienen permisos suficientes."
  fi
  AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
  ok "AWS Account: ${AWS_ACCOUNT_ID}"

  # Crear bucket S3 si no existe
  info "Verificando bucket S3: ${S3_BUCKET}..."
  if aws s3api head-bucket --bucket "$S3_BUCKET" 2>/dev/null; then
    ok "Bucket S3 ya existe: ${S3_BUCKET}"
  else
    info "Creando bucket S3: ${S3_BUCKET} en ${AWS_REGION}..."
    if [[ "$AWS_REGION" == "us-east-1" ]]; then
      aws s3api create-bucket \
        --bucket "$S3_BUCKET" \
        --region "$AWS_REGION" \
        --output text > /dev/null
    else
      aws s3api create-bucket \
        --bucket "$S3_BUCKET" \
        --region "$AWS_REGION" \
        --create-bucket-configuration LocationConstraint="$AWS_REGION" \
        --output text > /dev/null
    fi
    ok "Bucket S3 creado: ${S3_BUCKET}"
  fi

  # Bloquear acceso público (los videos se sirven por CloudFront, no directamente)
  aws s3api put-public-access-block \
    --bucket "$S3_BUCKET" \
    --public-access-block-configuration \
      "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" \
    > /dev/null
  ok "Acceso público al bucket bloqueado"

  # Crear CloudFront OAC (Origin Access Control) para acceso privado a S3
  info "Creando distribución CloudFront..."

  # OAC para S3
  OAC_ID=$(aws cloudfront create-origin-access-control \
    --origin-access-control-config \
      "Name=streamvault-oac-${S3_BUCKET},SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3" \
    --query 'OriginAccessControl.Id' --output text 2>/dev/null || echo "")

  if [[ -z "$OAC_ID" ]]; then
    # OAC ya existe, buscar el ID
    OAC_ID=$(aws cloudfront list-origin-access-controls \
      --query "OriginAccessControlList.Items[?Name=='streamvault-oac-${S3_BUCKET}'].Id" \
      --output text 2>/dev/null || echo "")
  fi

  if [[ -n "$OAC_ID" ]]; then
    ok "Origin Access Control: ${OAC_ID}"
  else
    warn "No se pudo crear OAC — CloudFront usará acceso público al bucket"
    OAC_ID=""
  fi

  # Distribución CloudFront
  S3_DOMAIN="${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com"

  CF_CONFIG=$(cat << CFCONFIG
{
  "Origins": {
    "Quantity": 1,
    "Items": [{
      "Id": "S3-${S3_BUCKET}",
      "DomainName": "${S3_DOMAIN}",
      "S3OriginConfig": { "OriginAccessIdentity": "" }
      $([ -n "$OAC_ID" ] && echo ",\"OriginAccessControlId\": \"${OAC_ID}\"" || echo "")
    }]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "S3-${S3_BUCKET}",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": { "Quantity": 2, "Items": ["GET","HEAD"] },
    "CachedMethods": { "Quantity": 2, "Items": ["GET","HEAD"] },
    "Compress": true,
    "CachePolicyId": "658327ea-f89d-4fab-a63d-7e88639e58f6",
    "ForwardedValues": {
      "QueryString": false,
      "Cookies": { "Forward": "none" }
    },
    "MinTTL": 0
  },
  "Comment": "StreamVault media CDN",
  "Enabled": true,
  "PriceClass": "PriceClass_100",
  "CallerReference": "streamvault-$(date +%s)"
}
CFCONFIG
)

  CF_OUTPUT=$(aws cloudfront create-distribution \
    --distribution-config "$CF_CONFIG" \
    --output json 2>/dev/null || echo "")

  if [[ -n "$CF_OUTPUT" ]]; then
    CLOUDFRONT_DISTRIBUTION_ID=$(echo "$CF_OUTPUT" | grep -o '"Id": "[^"]*"' | head -1 | cut -d'"' -f4)
    CLOUDFRONT_BASE_URL="https://$(echo "$CF_OUTPUT" | grep -o '"DomainName": "[^"]*cloudfront\.net"' | head -1 | cut -d'"' -f4)"
    ok "CloudFront creado: ${CLOUDFRONT_BASE_URL}"
    ok "Distribution ID: ${CLOUDFRONT_DISTRIBUTION_ID}"

    # Política de bucket para CloudFront OAC
    if [[ -n "$OAC_ID" ]]; then
      BUCKET_POLICY=$(cat << BPOLICY
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowCloudFrontOAC",
    "Effect": "Allow",
    "Principal": { "Service": "cloudfront.amazonaws.com" },
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::${S3_BUCKET}/*",
    "Condition": {
      "StringEquals": {
        "AWS:SourceArn": "arn:aws:cloudfront::${AWS_ACCOUNT_ID}:distribution/${CLOUDFRONT_DISTRIBUTION_ID}"
      }
    }
  }]
}
BPOLICY
)
      aws s3api put-bucket-policy --bucket "$S3_BUCKET" --policy "$BUCKET_POLICY" > /dev/null
      ok "Política de bucket configurada para CloudFront OAC"
    fi
  else
    warn "No se pudo crear CloudFront automáticamente."
    warn "Crea la distribución manualmente y añade CLOUDFRONT_BASE_URL al .env"
  fi
else
  info "Saltando creación de infraestructura AWS (configuración manual)."
  warn "Recuerda añadir CLOUDFRONT_BASE_URL y CLOUDFRONT_DISTRIBUTION_ID al .env"
fi

# ─── 3. Código de la aplicación ───────────────────────────────────────────────
hdr "PASO 3/8 — CÓDIGO DE LA APLICACIÓN"

mkdir -p "$APP_DIR"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Si el script está dentro del repo, copiar desde ahí
if [[ -f "${SCRIPT_DIR}/server.js" ]]; then
  info "Copiando código desde ${SCRIPT_DIR}..."
  rsync -a --exclude='.git' --exclude='node_modules' --exclude='uploads' \
    --exclude='videos' --exclude='*.db' --exclude='.env' \
    "${SCRIPT_DIR}/" "${APP_DIR}/"
  ok "Código copiado a ${APP_DIR}"
else
  # Solicitar origen del repo
  echo -e "\n  ${YELLOW}No se encontró el código en el directorio del script.${NC}"
  ask "URL del repositorio Git (o deja vacío para cancelar)" REPO_URL ""
  if [[ -n "$REPO_URL" ]]; then
    if [[ -d "${APP_DIR}/.git" ]]; then
      info "Actualizando repo existente..."
      git -C "$APP_DIR" pull origin main
    else
      info "Clonando repositorio..."
      git clone "$REPO_URL" "$APP_DIR"
    fi
    ok "Repositorio listo"
  else
    die "No hay código fuente. Sube el código a ${APP_DIR} manualmente y vuelve a correr el script."
  fi
fi

mkdir -p "${APP_DIR}/uploads" "${APP_DIR}/videos" "${APP_DIR}/logs"

# ─── 4. Generar secrets y escribir .env ───────────────────────────────────────
hdr "PASO 4/8 — GENERANDO SECRETS Y .ENV"

JWT_SECRET=$(openssl rand -hex 32)
JWT_REFRESH_SECRET=$(openssl rand -hex 32)
ok "JWT secrets generados (64 chars cada uno)"

ENV_FILE="${APP_DIR}/.env"

# Respaldar .env anterior si existe
[[ -f "$ENV_FILE" ]] && cp "$ENV_FILE" "${ENV_FILE}.backup.$(date +%Y%m%d%H%M%S)"

cat > "$ENV_FILE" << ENVFILE
# =============================================================
# StreamVault — Variables de Entorno Producción
# Generado automáticamente por deploy.sh el $(date '+%Y-%m-%d %H:%M:%S')
# =============================================================

NODE_ENV=production
PORT=3000

# ── App ───────────────────────────────────────────────────────
APP_URL=https://${DOMAIN}
ALLOWED_ORIGINS=https://${DOMAIN}
TRUST_PROXY=1

# ── Base de datos ─────────────────────────────────────────────
DATABASE_URL=${DATABASE_URL}

# ── Redis ─────────────────────────────────────────────────────
REDIS_URL=${REDIS_URL}

# ── JWT ───────────────────────────────────────────────────────
JWT_SECRET=${JWT_SECRET}
JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET}

# ── AWS S3 + CloudFront ───────────────────────────────────────
AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}
AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}
AWS_REGION=${AWS_REGION}
S3_BUCKET=${S3_BUCKET}
CLOUDFRONT_BASE_URL=${CLOUDFRONT_BASE_URL}
CLOUDFRONT_DISTRIBUTION_ID=${CLOUDFRONT_DISTRIBUTION_ID}
DELETE_LOCAL_AFTER_S3=1

# ── Super admin ───────────────────────────────────────────────
SUPER_ADMIN_EMAIL=${SUPER_ADMIN_EMAIL}

# ── Workers ───────────────────────────────────────────────────
WORKER_CONCURRENCY=${WORKER_CONCURRENCY}
TRANSCRIPTION_CONCURRENCY=${TRANSCRIPTION_CONCURRENCY}
DB_POOL_MAX=10

# ── Email SMTP ────────────────────────────────────────────────
SMTP_HOST=${SMTP_HOST}
SMTP_PORT=${SMTP_PORT}
SMTP_USER=${SMTP_USER}
SMTP_PASS=${SMTP_PASS}
SMTP_FROM=${SMTP_FROM}

# ── dLocal Go (LATAM) ─────────────────────────────────────────
DLOCALGO_API_KEY=${DLOCALGO_API_KEY}
DLOCALGO_SECRET_KEY=${DLOCALGO_SECRET_KEY}
DLOCALGO_MODE=${DLOCALGO_MODE}
DLOCALGO_PLAN_STARTER=${DLOCALGO_PLAN_STARTER}
DLOCALGO_PLAN_PRO=${DLOCALGO_PLAN_PRO}
DLOCALGO_PLAN_ENTERPRISE=${DLOCALGO_PLAN_ENTERPRISE}

# ── Binance Pay (crypto) ───────────────────────────────────────
BINANCE_API_KEY=${BINANCE_API_KEY}
BINANCE_SECRET_KEY=${BINANCE_SECRET_KEY}
BINANCE_MERCHANT_ID=${BINANCE_MERCHANT_ID}
BINANCE_MODE=${BINANCE_MODE}
BINANCE_PRICE_STARTER=${BINANCE_PRICE_STARTER}
BINANCE_PRICE_PRO=${BINANCE_PRICE_PRO}
BINANCE_PRICE_ENTERPRISE=${BINANCE_PRICE_ENTERPRISE}
ENVFILE

chmod 600 "$ENV_FILE"
ok ".env escrito en ${ENV_FILE} (permisos 600)"

# ─── 5. Build y arranque Docker ───────────────────────────────────────────────
hdr "PASO 5/8 — DOCKER BUILD & ARRANQUE"

cd "$APP_DIR"

info "Construyendo imagen Docker (esto tarda ~3 min la primera vez)..."
docker compose -f docker-compose.prod.yml build --no-cache
ok "Imagen construida"

info "Arrancando contenedores..."
docker compose -f docker-compose.prod.yml up -d
ok "Contenedores arrancados"

# Esperar a que la API esté healthy
info "Esperando a que la API arranque (máx. 120s)..."
ATTEMPTS=0
MAX_ATTEMPTS=24
until curl -sf http://localhost:3000/api/health > /dev/null 2>&1; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [[ $ATTEMPTS -ge $MAX_ATTEMPTS ]]; then
    warn "La API no respondió en 120s. Revisa los logs:"
    warn "  docker compose -f ${APP_DIR}/docker-compose.prod.yml logs api"
    break
  fi
  sleep 5
done

if curl -sf http://localhost:3000/api/health > /dev/null 2>&1; then
  ok "API respondiendo en http://localhost:3000/api/health"
fi

# ─── 6. Nginx + SSL ───────────────────────────────────────────────────────────
hdr "PASO 6/8 — NGINX + SSL"

# Sustituir dominio en nginx.conf
NGINX_CONF="/etc/nginx/sites-available/streamvault"
sed "s/tu-dominio\.com/${DOMAIN}/g" "${APP_DIR}/nginx.conf" > "$NGINX_CONF"

# Asegurarse de que el bloque SSL no rompa antes de tener el certificado
# Comentar las líneas ssl_certificate hasta que certbot las ponga
sed -i 's|ssl_certificate |#PRECERT# ssl_certificate |g' "$NGINX_CONF"

# Config temporal HTTP-only para que certbot pueda validar el dominio
cat > /etc/nginx/sites-available/streamvault-temp << NGINXTMP
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} www.${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        client_max_body_size 10g;
    }
}
NGINXTMP

# Activar config temporal
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/streamvault-temp /etc/nginx/sites-enabled/streamvault
nginx -t && systemctl reload nginx
ok "Nginx HTTP arrancado (temporal)"

mkdir -p /var/www/certbot

# Verificar que el dominio resuelve a este servidor
info "Verificando que ${DOMAIN} apunta a este servidor..."
SERVER_IP=$(curl -sf https://api.ipify.org 2>/dev/null || curl -sf https://ifconfig.me 2>/dev/null || echo "desconocida")
DOMAIN_IP=$(dig +short "$DOMAIN" 2>/dev/null | tail -1 || host "$DOMAIN" 2>/dev/null | grep 'has address' | awk '{print $NF}' || echo "")

echo -e "  IP de este servidor: ${CYAN}${SERVER_IP}${NC}"
echo -e "  IP del dominio:      ${CYAN}${DOMAIN_IP:-no resuelto}${NC}"

SSL_OK=false
if [[ -n "$DOMAIN_IP" && "$DOMAIN_IP" == "$SERVER_IP" ]]; then
  ok "El dominio apunta correctamente a este servidor"

  info "Obteniendo certificado SSL Let's Encrypt..."
  if certbot --nginx -d "$DOMAIN" -d "www.${DOMAIN}" \
      --non-interactive --agree-tos -m "$SUPER_ADMIN_EMAIL" \
      --redirect 2>/dev/null; then
    SSL_OK=true
    ok "Certificado SSL obtenido"
  else
    # Intentar sin www (por si el subdominio no tiene CNAME)
    if certbot --nginx -d "$DOMAIN" \
        --non-interactive --agree-tos -m "$SUPER_ADMIN_EMAIL" \
        --redirect 2>/dev/null; then
      SSL_OK=true
      ok "Certificado SSL obtenido (solo dominio principal, sin www)"
    else
      warn "No se pudo obtener el certificado SSL automáticamente."
      warn "Corre manualmente: sudo certbot --nginx -d ${DOMAIN}"
    fi
  fi
else
  warn "El dominio ${DOMAIN} no apunta todavía a ${SERVER_IP}."
  warn "Configura el DNS (registro A) y luego corre:"
  warn "  sudo certbot --nginx -d ${DOMAIN}"
fi

# Activar config completa de nginx
if [[ "$SSL_OK" == true ]]; then
  # certbot ya modificó nginx — restaurar la config original con SSL
  sed "s/tu-dominio\.com/${DOMAIN}/g" "${APP_DIR}/nginx.conf" > "$NGINX_CONF"
  rm -f /etc/nginx/sites-enabled/streamvault
  ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/streamvault
  nginx -t && systemctl reload nginx
  ok "Nginx HTTPS activado"
fi

# Renovación automática
systemctl enable certbot.timer 2>/dev/null || true
(crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet && systemctl reload nginx") | sort -u | crontab -
ok "Renovación automática SSL configurada (cron 3am diario)"

# ─── 7. Autoarranque al reiniciar ─────────────────────────────────────────────
hdr "PASO 7/8 — AUTOARRANQUE"

# Crear servicio systemd para docker compose
cat > /etc/systemd/system/streamvault.service << SYSD
[Unit]
Description=StreamVault Application
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/docker compose -f docker-compose.prod.yml up -d
ExecStop=/usr/bin/docker compose -f docker-compose.prod.yml down
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
SYSD

systemctl daemon-reload
systemctl enable streamvault.service
ok "Servicio systemd 'streamvault' configurado (arranca en boot)"

# ─── 8. Verificación final ────────────────────────────────────────────────────
hdr "PASO 8/8 — VERIFICACIÓN FINAL"

sleep 3  # dar tiempo a nginx para recargar

HEALTH_URL="http://localhost:3000/api/health"
PUBLIC_HEALTH="https://${DOMAIN}/api/health"

# Health local
if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
  HEALTH_RESPONSE=$(curl -sf "$HEALTH_URL")
  ok "API local OK: ${HEALTH_RESPONSE}"
else
  warn "API local no responde en ${HEALTH_URL}"
fi

# Health público
if curl -sf --max-time 10 "$PUBLIC_HEALTH" > /dev/null 2>&1; then
  ok "API pública OK: ${PUBLIC_HEALTH}"
elif [[ "$SSL_OK" == true ]]; then
  warn "La API no responde en ${PUBLIC_HEALTH} — espera 1-2 min y vuelve a verificar"
fi

# Estado de contenedores
echo
info "Estado de los contenedores:"
docker compose -f "${APP_DIR}/docker-compose.prod.yml" ps
echo

# =============================================================================
#  RESUMEN FINAL
# =============================================================================

hdr "INSTALACIÓN COMPLETADA"

echo -e "  ${BOLD}${GREEN}StreamVault está corriendo en producción.${NC}\n"

echo -e "  ${BOLD}URL de la app:${NC}     https://${DOMAIN}"
echo -e "  ${BOLD}Panel admin:${NC}       https://${DOMAIN}/admin"
echo -e "  ${BOLD}Health check:${NC}      https://${DOMAIN}/api/health"
echo -e "  ${BOLD}Super-admin email:${NC} ${SUPER_ADMIN_EMAIL}"
echo -e "  ${BOLD}S3 Bucket:${NC}         ${S3_BUCKET}"

if [[ -n "$CLOUDFRONT_BASE_URL" ]]; then
  echo -e "  ${BOLD}CloudFront CDN:${NC}    ${CLOUDFRONT_BASE_URL}"
fi

echo
echo -e "  ${BOLD}${YELLOW}PRÓXIMOS PASOS:${NC}"
echo -e "  1. Ve a ${CYAN}https://${DOMAIN}/login${NC} y regístrate con ${SUPER_ADMIN_EMAIL}"
echo -e "     → Ese email obtiene automáticamente el rol super-admin."

if [[ "$SSL_OK" != true ]]; then
  echo -e "  2. ${YELLOW}Configura el DNS:${NC} añade un registro A que apunte ${DOMAIN} a ${SERVER_IP}"
  echo -e "     Luego corre: ${CYAN}sudo certbot --nginx -d ${DOMAIN}${NC}"
fi

if [[ -n "$CLOUDFRONT_BASE_URL" && -z "$CLOUDFRONT_DISTRIBUTION_ID" ]]; then
  echo -e "  ${YELLOW}→ La distribución CloudFront puede tardar 15 min en propagarse.${NC}"
fi

if [[ "$SETUP_DLOCAL" != true ]]; then
  echo -e "  ${YELLOW}→ dLocal Go no configurado.${NC} Añade DLOCALGO_* en ${APP_DIR}/.env y reinicia."
fi
if [[ "$SETUP_BINANCE" != true ]]; then
  echo -e "  ${YELLOW}→ Binance Pay no configurado.${NC} Añade BINANCE_* en ${APP_DIR}/.env y reinicia."
fi

echo
echo -e "  ${BOLD}COMANDOS ÚTILES:${NC}"
echo -e "  ${CYAN}# Ver logs en vivo${NC}"
echo -e "  docker compose -f ${APP_DIR}/docker-compose.prod.yml logs -f"
echo
echo -e "  ${CYAN}# Ver estado de contenedores${NC}"
echo -e "  docker compose -f ${APP_DIR}/docker-compose.prod.yml ps"
echo
echo -e "  ${CYAN}# Actualizar la app (zero-downtime)${NC}"
echo -e "  cd ${APP_DIR} && git pull && docker compose -f docker-compose.prod.yml build api && docker compose -f docker-compose.prod.yml up -d --no-deps api"
echo
echo -e "  ${CYAN}# Escalar workers FFmpeg${NC}"
echo -e "  docker compose -f ${APP_DIR}/docker-compose.prod.yml up -d --scale worker=3"
echo
echo -e "  ${CYAN}# Editar configuración${NC}"
echo -e "  nano ${APP_DIR}/.env && docker compose -f ${APP_DIR}/docker-compose.prod.yml restart"
echo

echo -e "  Log completo de la instalación: ${CYAN}${LOG_FILE}${NC}"
echo -e "\n  $(date '+%Y-%m-%d %H:%M:%S') — Instalación finalizada\n"
