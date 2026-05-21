#!/bin/bash
# Script para probar los niveles de Analytics (Basic vs Full)

set -e

echo "🧪 Testing Analytics Tiers Implementation"
echo "=========================================="
echo ""

# Colores
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Variables (ajusta según tu entorno)
API_BASE="${API_BASE:-http://localhost:3000}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
VIDEO_ID="${VIDEO_ID:-}"

if [ -z "$ADMIN_TOKEN" ]; then
  echo -e "${RED}❌ Error: Debes configurar ADMIN_TOKEN${NC}"
  echo "Ejecuta: export ADMIN_TOKEN=\$(node scripts/gen-admin-token.js)"
  exit 1
fi

if [ -z "$VIDEO_ID" ]; then
  echo -e "${YELLOW}⚠️  Warning: VIDEO_ID no configurado. Usando video de ejemplo${NC}"
  VIDEO_ID="test-video-id"
fi

echo "📊 Test 1: Verificar tier en respuesta de analytics"
echo "---------------------------------------------------"
RESPONSE=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$API_BASE/api/videos/$VIDEO_ID/analytics")

if echo "$RESPONSE" | grep -q '"tier"'; then
  TIER=$(echo "$RESPONSE" | grep -o '"tier":"[^"]*"' | cut -d'"' -f4)
  echo -e "${GREEN}✅ Campo 'tier' presente en respuesta: $TIER${NC}"
else
  echo -e "${RED}❌ Campo 'tier' NO encontrado en respuesta${NC}"
  echo "Respuesta: $RESPONSE"
fi

echo ""
echo "📊 Test 2: Verificar datos filtrados según tier"
echo "---------------------------------------------------"

# Verificar que tenga datos básicos
if echo "$RESPONSE" | grep -q '"uniqueViewers"'; then
  echo -e "${GREEN}✅ Datos básicos presentes (uniqueViewers, totalPlays, etc)${NC}"
else
  echo -e "${RED}❌ Datos básicos no encontrados${NC}"
fi

# Verificar datos avanzados según tier
if [ "$TIER" = "full" ]; then
  if echo "$RESPONSE" | grep -q '"retention"'; then
    echo -e "${GREEN}✅ FULL tier: Datos avanzados presentes (retention, heatmaps, etc)${NC}"
  else
    echo -e "${RED}❌ FULL tier: Datos avanzados NO encontrados${NC}"
  fi
elif [ "$TIER" = "basic" ]; then
  if echo "$RESPONSE" | grep -q '"retention"'; then
    echo -e "${RED}❌ BASIC tier: Datos avanzados NO deberían estar presentes${NC}"
  else
    echo -e "${GREEN}✅ BASIC tier: Datos avanzados correctamente filtrados${NC}"
  fi
fi

echo ""
echo "📊 Test 3: Probar CSV export (solo Full Analytics)"
echo "---------------------------------------------------"

CSV_RESPONSE=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$API_BASE/api/videos/$VIDEO_ID/analytics/export.csv")

HTTP_CODE=$(echo "$CSV_RESPONSE" | tail -n1)
BODY=$(echo "$CSV_RESPONSE" | sed '$d')

if [ "$TIER" = "full" ]; then
  if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✅ FULL tier: CSV export permitido (HTTP 200)${NC}"
  else
    echo -e "${RED}❌ FULL tier: CSV export debería estar permitido${NC}"
    echo "HTTP Code: $HTTP_CODE"
  fi
elif [ "$TIER" = "basic" ]; then
  if [ "$HTTP_CODE" = "403" ]; then
    echo -e "${GREEN}✅ BASIC tier: CSV export correctamente bloqueado (HTTP 403)${NC}"
    if echo "$BODY" | grep -q "ANALYTICS_FULL_REQUIRED"; then
      echo -e "${GREEN}✅ Código de error correcto: ANALYTICS_FULL_REQUIRED${NC}"
    fi
  else
    echo -e "${RED}❌ BASIC tier: CSV export debería estar bloqueado${NC}"
    echo "HTTP Code: $HTTP_CODE"
  fi
fi

echo ""
echo "📊 Test 4: Verificar configuración de plan"
echo "---------------------------------------------------"

PLANS_RESPONSE=$(curl -s "$API_BASE/api/plans")

# Verificar que los planes tengan configuración de analytics
if echo "$PLANS_RESPONSE" | grep -q '"analytics"'; then
  echo -e "${GREEN}✅ Planes tienen configuración de analytics${NC}"
  
  # Mostrar configuración de cada plan
  for PLAN in starter pro enterprise; do
    ANALYTICS=$(echo "$PLANS_RESPONSE" | grep -A 20 "\"$PLAN\"" | grep -o '"analytics":"[^"]*"' | cut -d'"' -f4 || echo "no configurado")
    echo "  • $PLAN: analytics = $ANALYTICS"
  done
else
  echo -e "${YELLOW}⚠️  Los planes no tienen configuración de analytics (puede ser legacy)${NC}"
fi

echo ""
echo "=========================================="
echo "✅ Tests completados"
echo ""
echo "📝 Notas:"
echo "  • Para testing completo, crea un video y ejecuta:"
echo "    export VIDEO_ID=<tu-video-id>"
echo "  • Para probar diferentes tiers, modifica la configuración del plan en /admin/#plans"
echo "  • Revisa la documentación completa en docs/ANALYTICS-EMBED-TIERS.md"
