#!/bin/bash
#
# StreamVault - Inicio Automático con 100% Uptime
# 
# Este script inicia TODOS los servicios necesarios:
#   1. Verifica que Redis esté corriendo
#   2. Inicia el API server con PM2
#   3. Inicia el Worker con PM2
#   4. Configura auto-restart en caso de crash
#   5. Configura inicio automático al reiniciar el servidor
#
# Uso:
#   chmod +x start-all.sh
#   ./start-all.sh
#

set -e  # Exit on error

echo "═══════════════════════════════════════════════════════════"
echo "  StreamVault - Inicio con 100% Uptime"
echo "═══════════════════════════════════════════════════════════"
echo ""

# ─── 1. Verificar que estamos en el directorio correcto ───────────
if [ ! -f "package.json" ] || [ ! -f "server.js" ]; then
    echo "❌ ERROR: Ejecuta este script desde el directorio raíz de StreamVault"
    exit 1
fi

# ─── 2. Verificar Node.js ─────────────────────────────────────────
if ! command -v node &> /dev/null; then
    echo "❌ ERROR: Node.js no está instalado"
    exit 1
fi
echo "✅ Node.js $(node -v) detectado"

# ─── 3. Verificar Redis ──────────────────────────────────────────
echo ""
echo "🔍 Verificando Redis..."
if ! command -v redis-cli &> /dev/null; then
    echo "⚠️  WARNING: redis-cli no encontrado en PATH"
    echo "   Intentando conectar a redis://localhost:6379..."
fi

# Intentar ping a Redis (compatible macOS y Linux)
REDIS_RESPONSE=$(redis-cli -h localhost -p 6379 ping 2>&1 || echo "FAILED")
if [ "$REDIS_RESPONSE" = "PONG" ]; then
    echo "✅ Redis está corriendo en localhost:6379"
else
    echo ""
    echo "❌ ERROR: Redis NO está corriendo (respuesta: $REDIS_RESPONSE)"
    echo ""
    echo "   Para iniciar Redis:"
    echo "   • macOS:   brew services start redis"
    echo "   • Linux:   sudo systemctl start redis"
    echo "   • Docker:  docker run -d -p 6379:6379 redis:alpine"
    echo ""
    echo "   O edita REDIS_URL en .env si Redis está en otro host"
    echo ""
    exit 1
fi

# ─── 4. Verificar PostgreSQL ─────────────────────────────────────
echo ""
echo "🔍 Verificando PostgreSQL..."
if ! command -v psql &> /dev/null; then
    echo "⚠️  WARNING: psql no encontrado - asumiendo que PostgreSQL está corriendo"
else
    # Extraer credenciales del .env
    DB_URL=$(grep "^DATABASE_URL=" .env | cut -d'=' -f2-)
    if [ -z "$DB_URL" ]; then
        echo "⚠️  WARNING: DATABASE_URL no encontrado en .env"
    else
        echo "✅ PostgreSQL configurado: ${DB_URL##*@}"
    fi
fi

# ─── 5. Crear directorio de logs ─────────────────────────────────
mkdir -p logs
echo ""
echo "📁 Directorio de logs: ./logs/"

# ─── 6. Verificar/Instalar PM2 ───────────────────────────────────
echo ""
echo "🔍 Verificando PM2..."
if ! command -v pm2 &> /dev/null; then
    echo "⚠️  PM2 no está instalado. Instalando globalmente..."
    npm install -g pm2
    if [ $? -ne 0 ]; then
        echo "❌ ERROR: No se pudo instalar PM2"
        echo "   Intenta manualmente: sudo npm install -g pm2"
        exit 1
    fi
    echo "✅ PM2 instalado correctamente"
else
    echo "✅ PM2 $(pm2 -v) detectado"
fi

# ─── 7. Detener procesos previos (si existen) ────────────────────
echo ""
echo "🛑 Deteniendo procesos previos (si existen)..."
pm2 delete streamvault-api 2>/dev/null || true
pm2 delete streamvault-worker 2>/dev/null || true
pm2 delete all 2>/dev/null || true

# ─── 8. Iniciar con PM2 ──────────────────────────────────────────
echo ""
echo "🚀 Iniciando StreamVault con PM2..."
pm2 start ecosystem.config.js

if [ $? -ne 0 ]; then
    echo "❌ ERROR: No se pudo iniciar con PM2"
    echo "   Revisa los logs con: pm2 logs"
    exit 1
fi

# ─── 9. Guardar configuración PM2 ────────────────────────────────
echo ""
echo "💾 Guardando configuración PM2..."
pm2 save

# ─── 10. Configurar auto-start en boot ───────────────────────────
echo ""
echo "🔄 Configurando auto-start en boot del sistema..."
pm2 startup 2>/dev/null || true

# ─── 11. Mostrar estado ──────────────────────────────────────────
sleep 2
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ✅ StreamVault iniciado correctamente"
echo "═══════════════════════════════════════════════════════════"
echo ""
pm2 status
echo ""
echo "📊 Comandos útiles:"
echo "   pm2 status          - Ver estado de procesos"
echo "   pm2 logs            - Ver logs en tiempo real"
echo "   pm2 logs api        - Ver logs del API server"
echo "   pm2 logs worker     - Ver logs del Worker"
echo "   pm2 restart all     - Reiniciar todo"
echo "   pm2 stop all        - Detener todo"
echo "   pm2 monit           - Monitoreo en tiempo real"
echo ""
echo "🌐 Accede a:"
echo "   • Dashboard: http://localhost:3000/"
echo "   • Admin:     http://localhost:3000/admin"
echo "   • API Docs:  http://localhost:3000/api/docs"
echo ""
echo "✅ WORKER PROCESANDO VIDEOS 24/7 CON AUTO-RESTART"
echo ""
