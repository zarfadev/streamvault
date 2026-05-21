#!/bin/bash
# ─── StreamVault Cloudflare Tunnel ─────────────────────────────────────────
# Expone el servidor local a internet con HTTPS vía Cloudflare Quick Tunnel.
# Incluye configuración optimizada para uploads de archivos grandes (hasta 10GB).
#
# Uso:
#   ./start-tunnel.sh
#
# Requisitos:
#   brew install cloudflared
#
# NOTA: El túnel gratuito de Cloudflare (trycloudflare.com) tiene un límite
# de ~100MB por request body. Para archivos mayores, usa un túnel con cuenta
# de Cloudflare (cloudflared tunnel create ...) o despliega con IP pública.

# Kill any existing tunnel
pkill -f "cloudflared tunnel" 2>/dev/null
sleep 1

echo "🚇 Iniciando túnel Cloudflare hacia localhost:3000..."
echo ""

# --no-chunked-encoding: CRITICAL para uploads — sin esto, Cloudflare resetea
#   la conexión durante uploads multipart porque intenta re-chunk el body.
# --proxy-keepalive-timeout: Mantiene la conexión viva durante uploads lentos.
# --proxy-connect-timeout: Timeout de conexión al backend (60s generoso).
cloudflared tunnel \
  --url http://localhost:3000 \
  --no-autoupdate \
  --no-chunked-encoding \
  --proxy-keepalive-timeout 120s \
  --proxy-connect-timeout 60s \
  2>&1 | tee /tmp/cloudflared.log &

TUNNEL_PID=$!

# Wait for tunnel URL to appear
echo "⏳ Esperando URL del túnel..."
for i in $(seq 1 15); do
  URL=$(grep -o 'https://[a-zA-Z0-9-]*.trycloudflare.com' /tmp/cloudflared.log 2>/dev/null | head -1)
  if [ -n "$URL" ]; then
    echo ""
    echo "✅ Túnel activo:"
    echo ""
    echo "   🌐 $URL"
    echo ""
    echo "   📺 Dashboard:  $URL/dashboard"
    echo "   🎬 Player:     $URL/watch/<video-id>"
    echo "   📡 Chromecast: Funcional vía HTTPS"
    echo ""
    echo "   PID: $TUNNEL_PID (kill $TUNNEL_PID para detener)"
    echo ""
    echo "⚠️  Límite uploads: ~100MB vía túnel gratuito."
    echo "    Para archivos más grandes, usa localhost:3000 directamente."
    echo ""
    exit 0
  fi
  sleep 1
done

echo "❌ No se pudo obtener la URL del túnel. Revisa /tmp/cloudflared.log"
cat /tmp/cloudflared.log | tail -10
