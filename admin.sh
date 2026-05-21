#!/bin/bash

# StreamVault Admin Panel - Acceso Rápido
# Versión 2.0 - Header Authentication
# Autor: Sistema de Seguridad StreamVault
# Fecha: 5 de julio de 2026

set -e

# Colores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Banner
echo ""
echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  StreamVault Admin Panel Quick Access ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

# Verificar que estamos en el directorio correcto
if [ ! -f ".env" ]; then
  echo -e "${RED}❌ Error: archivo .env no encontrado${NC}"
  echo "   Ejecuta este script desde el directorio raíz de StreamVault"
  exit 1
fi

# Leer el secret del .env
SECRET=$(grep "^ADMIN_SECRET=" .env | cut -d '=' -f2- | tr -d '"' | tr -d "'" | xargs)

if [ -z "$SECRET" ]; then
  echo -e "${RED}❌ ADMIN_SECRET no encontrado en .env${NC}"
  echo ""
  echo -e "${YELLOW}Generando secret automáticamente...${NC}"
  
  # Generar secret aleatorio
  NEW_SECRET=$(openssl rand -base64 32)
  
  # Añadir a .env
  echo "" >> .env
  echo "# Admin Panel Secret (generado automáticamente)" >> .env
  echo "ADMIN_SECRET=$NEW_SECRET" >> .env
  
  echo -e "${GREEN}✅ Secret generado y añadido a .env${NC}"
  echo -e "${YELLOW}⚠️  IMPORTANTE: Reinicia el servidor (npm start)${NC}"
  echo ""
  echo "Tu nuevo secret es:"
  echo -e "${BLUE}$NEW_SECRET${NC}"
  echo ""
  echo "Presiona Enter para continuar después de reiniciar el servidor..."
  read
  
  SECRET=$NEW_SECRET
fi

# Detectar puerto (por defecto 3000)
PORT=$(grep "^PORT=" .env | cut -d '=' -f2 | xargs)
PORT=${PORT:-3000}

# Construir URL
URL="http://localhost:$PORT/admin"

echo -e "${BLUE}🔐 Secret detectado${NC}"
echo -e "${YELLOW}📡 URL: $URL${NC}"
echo ""
echo -e "${GREEN}🚀 Accediendo al admin panel...${NC}"
echo ""

# Hacer request y guardar HTML
TEMP_FILE="/tmp/sv-admin-$(date +%s).html"

HTTP_CODE=$(curl -s -o "$TEMP_FILE" -w "%{http_code}" "$URL" \
  -H "X-Admin-Secret: $SECRET")

# Verificar respuesta
if [ "$HTTP_CODE" -eq 200 ]; then
  echo -e "${GREEN}✅ Acceso exitoso (HTTP $HTTP_CODE)${NC}"
  echo -e "${BLUE}📄 Admin panel guardado en: $TEMP_FILE${NC}"
  echo ""
  
  # Abrir en navegador
  if command -v open &> /dev/null; then
    # macOS
    open "$TEMP_FILE"
    echo -e "${GREEN}🌐 Abriendo en navegador...${NC}"
  elif command -v xdg-open &> /dev/null; then
    # Linux
    xdg-open "$TEMP_FILE"
    echo -e "${GREEN}🌐 Abriendo en navegador...${NC}"
  else
    echo -e "${YELLOW}⚠️  No se pudo detectar comando para abrir navegador${NC}"
    echo "   Abre manualmente: $TEMP_FILE"
  fi
  
  echo ""
  echo -e "${YELLOW}⚠️  NOTA IMPORTANTE:${NC}"
  echo "   El admin panel se abrió como archivo HTML local."
  echo "   Las llamadas API funcionarán si el servidor está corriendo."
  echo ""
  echo -e "${BLUE}💡 Tip: Para usar el admin panel directamente en el navegador:${NC}"
  echo "   1. Instala la extensión ModHeader"
  echo "   2. Añade header: X-Admin-Secret = $SECRET"
  echo "   3. Ve a: $URL"
  
elif [ "$HTTP_CODE" -eq 403 ]; then
  echo -e "${RED}❌ Acceso denegado (HTTP 403)${NC}"
  echo ""
  echo "Posibles causas:"
  echo "  1. Secret incorrecto en .env"
  echo "  2. Servidor no reiniciado después de cambiar ADMIN_SECRET"
  echo ""
  echo "Solución:"
  echo "  1. Verifica el secret en .env"
  echo "  2. Reinicia el servidor: npm start"
  echo "  3. Vuelve a ejecutar este script"
  
elif [ "$HTTP_CODE" -eq 503 ]; then
  echo -e "${RED}❌ Admin panel no configurado (HTTP 503)${NC}"
  echo ""
  echo "El servidor no tiene ADMIN_SECRET configurado."
  echo "Este script ha generado uno, pero necesitas reiniciar el servidor."
  echo ""
  echo -e "${YELLOW}Ejecuta: npm start${NC}"
  
elif [ "$HTTP_CODE" -eq 000 ]; then
  echo -e "${RED}❌ No se pudo conectar al servidor${NC}"
  echo ""
  echo "Verifica que el servidor está corriendo:"
  echo -e "${YELLOW}  npm start${NC}"
  echo ""
  echo "O verifica la URL: $URL"
  
else
  echo -e "${RED}❌ Error HTTP $HTTP_CODE${NC}"
  echo ""
  cat "$TEMP_FILE" 2>/dev/null || echo "Sin contenido de respuesta"
fi

echo ""
echo -e "${BLUE}════════════════════════════════════════${NC}"
echo ""

# Limpiar archivos antiguos (más de 1 hora)
find /tmp -name "sv-admin-*.html" -type f -mmin +60 -delete 2>/dev/null || true

exit 0
