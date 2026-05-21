# 🚀 StreamVault — Guía Completa de Despliegue en AWS

## Requisitos Previos

- Cuenta AWS con permisos de administrador
- Dominio registrado: streamvault.link
- AWS CLI configurado: `aws configure`

---

## PASO 1: Crear VPC y Networking

En la consola AWS → VPC → Crear VPC:

```
Nombre: streamvault-vpc
IPv4 CIDR: 10.0.0.0/16
Subnets:
  - streamvault-public-a  → 10.0.1.0/24 (us-east-1a)
  - streamvault-public-b  → 10.0.2.0/24 (us-east-1b)
  - streamvault-private-a → 10.0.10.0/24 (us-east-1a)
  - streamvault-private-b → 10.0.11.0/24 (us-east-1b)
Internet Gateway: streamvault-igw (attached to VPC)
NAT Gateway: en public-a (para que las privadas tengan internet)
```

**O más fácil**: Usa "VPC and more" wizard que crea todo automáticamente.

---

## PASO 2: Crear Security Groups

### SG: streamvault-alb-sg
```
Inbound:
  - HTTP  (80)  desde 0.0.0.0/0
  - HTTPS (443) desde 0.0.0.0/0
```

### SG: streamvault-ec2-sg
```
Inbound:
  - TCP 3000 desde streamvault-alb-sg (solo el ALB puede hablar con la API)
  - SSH (22) desde TU IP (para mantenimiento)
```

### SG: streamvault-rds-sg
```
Inbound:
  - PostgreSQL (5432) desde streamvault-ec2-sg
```

### SG: streamvault-redis-sg
```
Inbound:
  - Redis (6379) desde streamvault-ec2-sg
```

---

## PASO 3: Crear RDS PostgreSQL (Multi-AZ)

Consola → RDS → Create database:

```
Engine: PostgreSQL 16
Template: Production
DB instance class: db.t3.medium
Multi-AZ: YES ✓ (failover automático)
Storage: 20 GB gp3, autoscaling habilitado hasta 100GB
DB identifier: streamvault-db
Master username: streamvault_admin
Master password: [GENERAR CONTRASEÑA SEGURA - guardar en Secrets Manager]
VPC: streamvault-vpc
Subnet group: streamvault-private (crear con private-a + private-b)
Security group: streamvault-rds-sg
Database name: streamvault
Backup retention: 7 días
Encryption: YES
```

**Anota el endpoint**: `streamvault-db.xxxxx.us-east-1.rds.amazonaws.com`

---

## PASO 4: Crear ElastiCache Redis

Consola → ElastiCache → Create cluster:

```
Engine: Redis OSS
Cluster mode: Disabled
Node type: cache.t3.small
Number of replicas: 1 (para failover)
Subnet group: crear con private-a + private-b
Security group: streamvault-redis-sg
Encryption at-rest: YES
Encryption in-transit: YES
Auto-failover: YES
```

**Anota el endpoint**: `streamvault-redis.xxxxx.cache.amazonaws.com:6379`

---

## PASO 5: Crear S3 Bucket

Consola → S3 → Create bucket:

```
Nombre: streamvault-media-prod (debe ser único global)
Region: us-east-1
Block all public access: YES (CloudFront accede vía OAI)
Versioning: Enabled
Encryption: SSE-S3
Lifecycle rules:
  - Move to Glacier after 90 days (opcional, para ahorro)
Transfer Acceleration: ENABLED ✓ (uploads rápidos)
```

### Crear IAM Policy para S3:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::streamvault-media-prod",
        "arn:aws:s3:::streamvault-media-prod/*"
      ]
    }
  ]
}
```

### Crear IAM Role para EC2:
- Nombre: `streamvault-ec2-role`
- Attach policy: la de arriba + `AmazonSSMManagedInstanceCore` (para Session Manager)

---

## PASO 6: Crear CloudFront Distribution

Consola → CloudFront → Create distribution:

```
Origin:
  - Origin domain: streamvault-media-prod.s3.us-east-1.amazonaws.com
  - Origin access: Origin Access Control (OAC) → Create new
  - Origin path: (vacío)

Default cache behavior:
  - Viewer protocol policy: Redirect HTTP to HTTPS
  - Allowed HTTP methods: GET, HEAD
  - Cache policy: CachingOptimized
  - Origin request policy: CORS-S3Origin

Additional settings:
  - Price class: Use all edge locations (best performance)
  - Alternate domain name (CNAME): cdn.streamvault.link
  - SSL certificate: Request certificate in ACM → *.streamvault.link
  - HTTP/2: YES
  - HTTP/3: YES
```

**Después de crear**: Copia la policy que te da CloudFront y agrégala al bucket S3.

**Anota**: `d1234abcd.cloudfront.net` → apuntar `cdn.streamvault.link` aquí via Route 53.

---

## PASO 7: Lanzar EC2 (API + Worker)

Consola → EC2 → Launch instance:

```
Nombre: streamvault-api-1
AMI: Amazon Linux 2023 (arm64 para mejor precio/rendimiento)
  O: Ubuntu 22.04 LTS
Instance type: c6g.xlarge (ARM) o c6i.xlarge (Intel)
Key pair: streamvault-key (crear nueva)
VPC: streamvault-vpc
Subnet: streamvault-public-a
Auto-assign public IP: YES
Security group: streamvault-ec2-sg
IAM instance profile: streamvault-ec2-role
Storage: 100 GB gp3 (3000 IOPS, 125 MB/s throughput)
User data (script de inicio):
```

### User Data Script (pegar en Advanced → User data):

```bash
#!/bin/bash
set -e

# ─── Instalar dependencias ───────────────────────────────────
dnf update -y
dnf install -y git nodejs20 npm docker postgresql15

# FFmpeg para transcodificación
dnf install -y ffmpeg

# ─── Instalar PM2 ────────────────────────────────────────────
npm install -g pm2

# ─── Clonar proyecto ─────────────────────────────────────────
cd /opt
git clone https://github.com/TU-USUARIO/streamvault.git
cd streamvault
npm ci --production

# ─── Crear .env ──────────────────────────────────────────────
cat > .env << 'EOF'
NODE_ENV=production
PORT=3000

# Database (RDS)
DATABASE_URL=postgresql://streamvault_admin:TU_PASSWORD@streamvault-db.xxxxx.us-east-1.rds.amazonaws.com:5432/streamvault

# Redis (ElastiCache)
REDIS_URL=redis://streamvault-redis.xxxxx.cache.amazonaws.com:6379

# S3
AWS_REGION=us-east-1
S3_BUCKET=streamvault-media-prod
S3_UPLOAD_AFTER_TRANSCODE=true

# CloudFront CDN
CDN_BASE_URL=https://cdn.streamvault.link

# App
APP_URL=https://app.streamvault.link
JWT_SECRET=GENERAR-64-CARACTERES-ALEATORIOS-AQUI
ALLOWED_ORIGINS=https://app.streamvault.link,https://streamvault.link

# Stripe (billing)
STRIPE_SECRET_KEY=sk_live_xxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxx
EOF

# ─── Crear directorio de logs ────────────────────────────────
mkdir -p logs uploads videos

# ─── Iniciar con PM2 ─────────────────────────────────────────
pm2 start ecosystem.config.js
pm2 save
pm2 startup

echo "✅ StreamVault deployed successfully"
```

---

## PASO 8: Crear Application Load Balancer (ALB)

Consola → EC2 → Load Balancers → Create:

```
Tipo: Application Load Balancer
Nombre: streamvault-alb
Scheme: Internet-facing
IP address type: IPv4
VPC: streamvault-vpc
Subnets: public-a + public-b (ambas AZ)
Security group: streamvault-alb-sg

Listeners:
  - HTTPS:443 → Forward to streamvault-target-group
  - HTTP:80 → Redirect to HTTPS:443

Target Group:
  - Name: streamvault-tg
  - Protocol: HTTP
  - Port: 3000
  - Health check path: /api/health
  - Health check interval: 15s
  - Healthy threshold: 2
  - Unhealthy threshold: 3

SSL Certificate: ACM → *.streamvault.link (o app.streamvault.link)
```

### Registrar EC2 en Target Group:
- Agrega la instancia EC2 creada en el paso 7.

---

## PASO 9: Configurar Auto Scaling Group

Consola → EC2 → Auto Scaling → Create:

```
Launch template:
  - Crear desde la EC2 que ya funciona (Actions → Image → Create template from instance)
  
Auto Scaling Group:
  - Name: streamvault-asg
  - VPC: streamvault-vpc
  - Subnets: public-a + public-b
  - Load balancer: streamvault-alb / streamvault-tg
  - Health check: ELB + EC2
  - Health check grace period: 300s
  
Capacity:
  - Desired: 1
  - Minimum: 1
  - Maximum: 4
  
Scaling policies:
  - Target tracking: Average CPU > 70% → scale out
  - Scale in: CPU < 30%
  - Cooldown: 300s
```

---

## PASO 10: Configurar Route 53 (DNS)

Consola → Route 53 → Hosted zones → Tu dominio:

```
Registros A:
  - app.streamvault.link → Alias → ALB (streamvault-alb)
  - cdn.streamvault.link → Alias → CloudFront distribution

Health check:
  - Nombre: streamvault-health
  - Endpoint: app.streamvault.link
  - Path: /api/health
  - Port: 443
  - Interval: 30s
  - Failure threshold: 3
  - SNI: app.streamvault.link
```

---

## PASO 11: Configurar SSL (ACM)

Consola → ACM → Request certificate:

```
Tipo: Public
Domain: *.streamvault.link, streamvault.link
Validation: DNS (agrega el CNAME que te da en Route 53)
```

Espera validación (~5 min) y luego úsalo en ALB y CloudFront.

---

## PASO 12: Monitoreo (CloudWatch)

### Alarmas automáticas:
```
- CPU > 80% por 5 min → Notificación SNS
- RDS Connections > 80% → Alerta
- 5XX errors > 10 en 5 min → Alerta CRÍTICA
- Disk usage > 80% → Alerta
- Healthy hosts < 1 → CRITICAL (servicio caído)
```

### Dashboard:
Crear CloudWatch Dashboard con widgets para:
- EC2 CPU, Network, Disk
- ALB Request Count, 5XX, Latency
- RDS Connections, Read/Write IOPS
- S3 Requests, Bytes transferred

---

## PASO 13: Backup Strategy

```
RDS: Automated backups (7 días) + snapshots manuales antes de deploys
S3: Cross-region replication a us-west-2 (disaster recovery)
EC2: AMI semanal automática
Secrets: AWS Secrets Manager con rotación automática
```

---

## Verificación Final

```bash
# 1. Verificar API
curl https://app.streamvault.link/api/health

# 2. Verificar CDN
curl -I https://cdn.streamvault.link/videos/test/thumb.jpg

# 3. Verificar SSL
openssl s_client -connect app.streamvault.link:443 -servername app.streamvault.link

# 4. Verificar upload
curl -X POST https://app.streamvault.link/api/upload \
  -H "Authorization: Bearer TOKEN" \
  -F "video=@test.mp4" -F "title=test"

# 5. Load test (opcional)
# npx autocannon -c 100 -d 30 https://app.streamvault.link/api/health
```

---

## Comandos Útiles Post-Deploy

```bash
# SSH a la EC2
ssh -i streamvault-key.pem ec2-user@IP

# Ver logs
pm2 logs

# Reiniciar
pm2 restart all

# Deploy nuevo código
cd /opt/streamvault
git pull origin main
npm ci --production
pm2 restart all

# Ver métricas en tiempo real
pm2 monit
```

---

## Resumen de Costos (Estimado USD/mes)

| Servicio | Config | Costo |
|----------|--------|-------|
| EC2 c6i.xlarge | 1 instancia (mín ASG) | $70 |
| RDS db.t3.medium Multi-AZ | PostgreSQL | $70 |
| ElastiCache cache.t3.small | Redis + replica | $25 |
| S3 Standard | 100GB + requests | $5 |
| CloudFront | 1TB transfer | $85 |
| ALB | + data processing | $22 |
| Route 53 | Hosted zone + health | $2 |
| ACM | Certificados SSL | $0 |
| **TOTAL INICIAL** | | **~$280/mes** |

Con Auto Scaling a 2+ instancias en horas pico: ~$340-400/mes.

---

## ⚡ Tips para Máximo Rendimiento

1. **Uploads**: Usa S3 presigned URLs para upload directo desde el browser → no pasa por EC2
2. **Transcodificación**: Considera AWS MediaConvert para offload FFmpeg del EC2
3. **DB**: Usa Read Replicas en RDS si las lecturas crecen mucho
4. **Cache**: Redis cachea API responses (analytics, video metadata) → reduce DB load 80%
5. **Monitoring**: Configura X-Ray para tracing distribuido y encontrar cuellos de botella
