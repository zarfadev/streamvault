#!/bin/bash
# StreamVault - Reset completo y limpio
# Limpia la base de datos y reinicia con datos de ejemplo

set -e

echo "🧹 StreamVault - Limpieza completa"
echo "=================================="

# Colores
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 1. Detener servicios existentes
echo -e "\n${BLUE}1. Deteniendo servicios...${NC}"
pm2 stop all 2>/dev/null || true
pm2 delete all 2>/dev/null || true
echo -e "${GREEN}✓ Servicios detenidos${NC}"

# 2. Limpiar base de datos
echo -e "\n${BLUE}2. Limpiando base de datos...${NC}"
rm -f streamvault.db
echo -e "${GREEN}✓ Base de datos eliminada${NC}"

# 3. Crear nueva base de datos y usuario
echo -e "\n${BLUE}3. Inicializando base de datos y usuario...${NC}"
node seed.js
echo -e "${GREEN}✓ Base de datos creada y usuario configurado${NC}"

# 5. Limpiar directorios de archivos
echo -e "\n${BLUE}5. Limpiando archivos subidos...${NC}"
rm -rf public/uploads/videos/* 2>/dev/null || true
rm -rf public/uploads/thumbnails/* 2>/dev/null || true
rm -rf public/uploads/logos/* 2>/dev/null || true
mkdir -p public/uploads/videos
mkdir -p public/uploads/thumbnails
mkdir -p public/uploads/logos
echo -e "${GREEN}✓ Directorios limpiados${NC}"

# 6. Reiniciar servicios
echo -e "\n${BLUE}6. Reiniciando servicios...${NC}"
pm2 start ecosystem.config.js
pm2 save --force
echo -e "${GREEN}✓ Servicios iniciados${NC}"

# Resumen
echo -e "\n${GREEN}=================================="
echo "✅ StreamVault reiniciado correctamente"
echo "==================================${NC}"
echo ""
echo -e "${YELLOW}📝 Credenciales de acceso:${NC}"
echo "   URL: http://localhost:3000"
echo "   Email: admin@streamvault.local"
echo "   Password: Admin1234!"
echo ""
echo -e "${YELLOW}💡 Comandos útiles:${NC}"
echo "   pm2 logs          - Ver logs en tiempo real"
echo "   pm2 status        - Estado de los servicios"
echo "   pm2 restart all   - Reiniciar todo"
echo ""
