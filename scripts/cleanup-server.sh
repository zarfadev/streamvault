#!/bin/bash
# StreamVault — Limpieza automática de disco
# Ejecutar diariamente via crontab: 0 4 * * * /opt/streamvault/cleanup.sh
# Instalación: scp a /opt/streamvault/cleanup.sh && chmod +x

LOG=/opt/streamvault/cleanup.log
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting cleanup" >> $LOG

# 1. Docker build cache (se acumula con cada deploy)
docker builder prune -af >> $LOG 2>&1

# 2. Docker dangling images
docker image prune -f >> $LOG 2>&1

# 3. Uploads huérfanos (más de 2 horas — ya deberían estar en S3)
find /tmp/sv-uploads -type f -mmin +120 -delete 2>/dev/null

# 4. Worker tmp files huérfanos (sources descargados hace >3h)
docker exec streamvault-worker-1 find /tmp -name 'sv-src-*' -mmin +180 -delete 2>/dev/null

# 5. Truncar logs de Docker si son muy grandes (>100MB)
find /var/lib/docker/containers -name '*-json.log' -size +100M -exec truncate -s 10M {} \; 2>/dev/null

# 6. Verificar espacio en disco
DISK_PCT=$(df / --output=pcent | tail -1 | tr -d ' %')
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Cleanup done. Disk: ${DISK_PCT}%" >> $LOG

# 7. Alerta si disco > 80%
if [ $DISK_PCT -gt 80 ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ALERTA: Disco al ${DISK_PCT}%" >> $LOG
  docker exec streamvault-api-1 node -e "
    const db=require('./db');
    db.init().then(async()=>{
      await db.prepare(\`INSERT INTO notifications (id, user_id, type, title, message, created_at)
        SELECT gen_random_uuid(), id, 'system', 'Disco casi lleno', 'El disco del servidor está al ${DISK_PCT}%. Amplía el volumen EBS.', FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
        FROM users WHERE platform_role='super_admin' LIMIT 1\`).run();
      process.exit(0);
    }).catch(()=>process.exit(0));
  " 2>/dev/null
fi
