# 🛡️ Guía de Configuración de WAF (Web Application Firewall)

## Índice
1. [Introducción](#introducción)
2. [Opciones de WAF](#opciones-de-waf)
3. [Cloudflare WAF](#cloudflare-waf)
4. [AWS WAF](#aws-waf)
5. [ModSecurity (Nginx)](#modsecurity-nginx)
6. [Fail2ban](#fail2ban)
7. [Reglas Recomendadas](#reglas-recomendadas)

---

## Introducción

Un WAF (Web Application Firewall) protege tu aplicación web filtrando y monitoreando el tráfico HTTP entre la aplicación y el internet. Es la **primera línea de defensa** contra ataques comunes.

### ¿Por qué necesitas un WAF?

- ✅ Protección contra OWASP Top 10
- ✅ Mitigación de DDoS
- ✅ Prevención de bots maliciosos
- ✅ Rate limiting a nivel de red
- ✅ Filtrado geográfico
- ✅ Logs y analytics de seguridad

---

## Opciones de WAF

### Comparativa Rápida

| Solución | Complejidad | Costo | Mejor Para |
|----------|-------------|-------|------------|
| **Cloudflare** | Baja | $20-200/mes | Startups, fácil setup |
| **AWS WAF** | Media | Pay-per-use | Apps en AWS |
| **ModSecurity** | Alta | Gratis | Auto-hospedado |
| **Fail2ban** | Media | Gratis | Protección básica |

---

## Cloudflare WAF

### 🚀 Setup Rápido (Recomendado)

#### Paso 1: Agregar Sitio a Cloudflare

```bash
# 1. Crear cuenta en cloudflare.com
# 2. Agregar tu dominio (ej: streamvault.link)
# 3. Actualizar nameservers en tu proveedor de dominio:
#    - NAMESERVER 1: ada.ns.cloudflare.com
#    - NAMESERVER 2: bert.ns.cloudflare.com
```

#### Paso 2: Configuración DNS

```
Tipo   Nombre    Contenido           Proxy
A      @         YOUR_SERVER_IP      ✅ Proxied (naranja)
A      www       YOUR_SERVER_IP      ✅ Proxied
CNAME  api       streamvault.link     ✅ Proxied
```

**IMPORTANTE:** El icono naranja (Proxied) activa el WAF de Cloudflare.

#### Paso 3: Configurar WAF

**Navegar a:** Security > WAF

##### Managed Rules (Reglas Administradas)

```yaml
Cloudflare Managed Ruleset: ON
  - OWASP Core Ruleset: ON
  - Cloudflare Specials: ON

OWASP ModSecurity Core Rule Set: ON
  - Paranoia Level: PL2 (Recomendado)
  - Score Threshold: 40
```

##### Rate Limiting Rules

```javascript
// Regla 1: Proteger Login
Rule name: Login Protection
If: URI Path equals "/api/auth/login"
Then: Block for 1 hour
Rate: 5 requests per 1 minute per IP

// Regla 2: Proteger API
Rule name: API Rate Limit
If: URI Path starts with "/api/"
Then: Challenge (CAPTCHA) for 10 minutes
Rate: 100 requests per 1 minute per IP

// Regla 3: Upload Protection
Rule name: Upload Limit
If: URI Path equals "/api/videos/upload"
Then: Block for 1 hour
Rate: 3 requests per 5 minutes per IP
```

##### Custom Rules

```javascript
// Bloquear países específicos (opcional)
Rule name: Block High-Risk Countries
If: Country in {CN, RU, KP}
And: URI Path starts with "/api/"
Then: Block

// Permitir solo IPs conocidas para admin
Rule name: Admin IP Whitelist
If: URI Path starts with "/api/admin"
And: IP Address not in {YOUR_OFFICE_IP, YOUR_HOME_IP}
Then: Block

// Detectar bots maliciosos
Rule name: Bot Protection
If: User Agent contains {"curl", "wget", "python-requests"}
And: URI Path starts with "/api/"
Then: Challenge (JS Challenge)
```

#### Paso 4: SSL/TLS

**Navegar a:** SSL/TLS > Overview

```yaml
Encryption Mode: Full (strict)

SSL/TLS > Edge Certificates:
  - Always Use HTTPS: ON
  - Minimum TLS Version: TLS 1.2
  - Opportunistic Encryption: ON
  - TLS 1.3: ON
  - Automatic HTTPS Rewrites: ON
  - Certificate Transparency Monitoring: ON
```

#### Paso 5: Security Settings

```yaml
Security > Settings:
  - Security Level: High
  - Challenge Passage: 30 minutes
  - Browser Integrity Check: ON

Security > Bots:
  - Bot Fight Mode: ON
  - Super Bot Fight Mode: ON (Pro plan)
```

#### Paso 6: Page Rules (Opcional)

```javascript
// Caché agresivo para assets
URL: streamvault.link/public/*
Settings:
  - Cache Level: Standard
  - Browser Cache TTL: 1 month
  - Security Level: Medium

// No caché para API
URL: streamvault.link/api/*
Settings:
  - Cache Level: Bypass
  - Security Level: High
```

### 📊 Monitoreo

**Security > Events** - Ver ataques bloqueados en tiempo real

**Analytics > Security** - Estadísticas de amenazas

---

## AWS WAF

### Para aplicaciones hospedadas en AWS

#### Paso 1: Crear Web ACL

```bash
aws wafv2 create-web-acl \
  --name streamvault-waf \
  --scope REGIONAL \
  --region us-east-1 \
  --default-action Block={} \
  --rules file://waf-rules.json
```

#### Paso 2: Reglas (waf-rules.json)

```json
[
  {
    "Name": "RateLimitRule",
    "Priority": 1,
    "Statement": {
      "RateBasedStatement": {
        "Limit": 2000,
        "AggregateKeyType": "IP"
      }
    },
    "Action": {
      "Block": {}
    }
  },
  {
    "Name": "AWSManagedRulesCommonRuleSet",
    "Priority": 2,
    "Statement": {
      "ManagedRuleGroupStatement": {
        "VendorName": "AWS",
        "Name": "AWSManagedRulesCommonRuleSet"
      }
    },
    "OverrideAction": {
      "None": {}
    }
  },
  {
    "Name": "AWSManagedRulesKnownBadInputsRuleSet",
    "Priority": 3,
    "Statement": {
      "ManagedRuleGroupStatement": {
        "VendorName": "AWS",
        "Name": "AWSManagedRulesKnownBadInputsRuleSet"
      }
    },
    "OverrideAction": {
      "None": {}
    }
  }
]
```

#### Paso 3: Asociar con ALB/CloudFront

```bash
aws wafv2 associate-web-acl \
  --web-acl-arn arn:aws:wafv2:us-east-1:ACCOUNT:regional/webacl/streamvault-waf/ID \
  --resource-arn arn:aws:elasticloadbalancing:us-east-1:ACCOUNT:loadbalancer/app/streamvault-alb/ID
```

---

## ModSecurity (Nginx)

### Instalación en Ubuntu/Debian

```bash
# Instalar ModSecurity
sudo apt update
sudo apt install -y libmodsecurity3 nginx

# Clonar reglas OWASP
cd /etc/nginx
sudo git clone https://github.com/coreruleset/coreruleset.git modsecurity-crs

# Configurar ModSecurity
sudo cp /etc/nginx/modsecurity-crs/crs-setup.conf.example \
     /etc/nginx/modsecurity-crs/crs-setup.conf
```

### Configuración Nginx

```nginx
# /etc/nginx/nginx.conf
load_module modules/ngx_http_modsecurity_module.so;

http {
    modsecurity on;
    modsecurity_rules_file /etc/nginx/modsecurity-crs/crs-setup.conf;
    
    # ... resto de configuración
}
```

### Archivo de Reglas

```nginx
# /etc/nginx/modsecurity-crs/crs-setup.conf

# Nivel de paranoia (1-4, más alto = más estricto)
SecAction \
  "id:900000,\
   phase:1,\
   nolog,\
   pass,\
   t:none,\
   setvar:tx.paranoia_level=2"

# Modo: DetectionOnly o On
SecRuleEngine On

# Incluir reglas OWASP
Include /etc/nginx/modsecurity-crs/rules/*.conf

# Reglas personalizadas para StreamVault
SecRule REQUEST_URI "@contains /api/auth/login" \
  "id:1001,\
   phase:1,\
   deny,\
   status:429,\
   msg:'Login rate limit exceeded',\
   setvar:ip.login_count=+1,\
   expirevar:ip.login_count=60"

SecRule IP:LOGIN_COUNT "@gt 5" \
  "id:1002,\
   phase:1,\
   deny,\
   status:429,\
   msg:'Too many login attempts'"
```

### Reiniciar Nginx

```bash
sudo nginx -t
sudo systemctl restart nginx
```

---

## Fail2ban

### Instalación

```bash
sudo apt install -y fail2ban
```

### Configuración para StreamVault

```ini
# /etc/fail2ban/jail.local

[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5
banaction = iptables-multiport

[streamvault-auth]
enabled = true
port = http,https
filter = streamvault-auth
logpath = /var/log/streamvault/combined.log
maxretry = 5

[streamvault-404]
enabled = true
port = http,https
filter = streamvault-404
logpath = /var/log/streamvault/combined.log
maxretry = 20

[nginx-http-auth]
enabled = true
```

### Filtros

```ini
# /etc/fail2ban/filter.d/streamvault-auth.conf
[Definition]
failregex = ^.*"event":"login_failed".*"ip":"<HOST>".*$
            ^.*"event":"invalid_token".*"ip":"<HOST>".*$
ignoreregex =

# /etc/fail2ban/filter.d/streamvault-404.conf
[Definition]
failregex = ^.*"status":404.*"ip":"<HOST>".*$
ignoreregex =
```

### Activar y Monitorear

```bash
sudo systemctl enable fail2ban
sudo systemctl start fail2ban

# Ver bans activos
sudo fail2ban-client status streamvault-auth

# Desbanear IP
sudo fail2ban-client unban 192.168.1.100
```

---

## Reglas Recomendadas

### Protección OWASP Top 10

```yaml
✅ Injection (SQL, NoSQL, Command):
   - Validación de entrada
   - Prepared statements
   - WAF rules: SQLi, CMDi

✅ Broken Authentication:
   - Rate limiting en login
   - 2FA obligatorio
   - Session timeout

✅ Sensitive Data Exposure:
   - HTTPS obligatorio
   - HSTS headers
   - Encriptación de datos

✅ XML External Entities (XXE):
   - Deshabilitar external entities
   - WAF XML inspection

✅ Broken Access Control:
   - Middleware de autorización
   - RBAC implementado

✅ Security Misconfiguration:
   - Security headers (CSP, etc.)
   - Disabled directory listing
   - Error handling apropiado

✅ Cross-Site Scripting (XSS):
   - Sanitización de entrada
   - CSP strict
   - Output encoding

✅ Insecure Deserialization:
   - Validación de objetos
   - Firma de tokens

✅ Using Components with Known Vulnerabilities:
   - npm audit
   - Dependencias actualizadas

✅ Insufficient Logging:
   - Winston logger
   - Audit trail
   - SIEM integration
```

### Rate Limits por Endpoint

```javascript
// Configuración recomendada
const rateLimits = {
  '/api/auth/login': '5 req/min',
  '/api/auth/register': '3 req/hour',
  '/api/auth/forgot-password': '3 req/hour',
  '/api/videos/upload': '10 req/hour',
  '/api/videos': '100 req/min',
  '/api/admin/*': '50 req/min',
  '/api/*': '200 req/min',
};
```

---

## Testing de WAF

### Herramientas de Testing

```bash
# 1. SQLMap (SQL Injection)
sqlmap -u "https://streamvault.link/api/videos?id=1" --batch

# 2. Nikto (Vulnerability Scanner)
nikto -h https://streamvault.link

# 3. OWASP ZAP (Automated Scanner)
docker run -t owasp/zap2docker-stable zap-baseline.py \
  -t https://streamvault.link

# 4. wfuzz (Fuzzing)
wfuzz -c -z file,/usr/share/wordlists/dirb/common.txt \
  --hc 404 https://streamvault.link/FUZZ

# 5. curl tests
# XSS attempt
curl -X POST https://streamvault.link/api/videos \
  -d '{"title":"<script>alert(1)</script>"}'

# SQL Injection attempt
curl "https://streamvault.link/api/videos?id=1' OR '1'='1"
```

### Verificar Protecciones

```bash
# Headers de seguridad
curl -I https://streamvault.link

# Rate limiting
for i in {1..10}; do 
  curl -X POST https://streamvault.link/api/auth/login \
    -d '{"email":"test@test.com","password":"wrong"}'; 
done

# Bot protection
curl -A "BadBot/1.0" https://streamvault.link/api/videos
```

---

## Monitoreo y Alertas

### Métricas Clave

1. **Requests bloqueados por WAF**
2. **Rate limits alcanzados**
3. **IPs baneadas**
4. **Intentos de exploit**
5. **Latencia añadida por WAF**

### Alertas Recomendadas

```yaml
Críticas:
  - > 100 requests bloqueados/min desde misma IP
  - Exploit detectado (SQLi, XSS)
  - Admin panel access attempts

Advertencias:
  - Rate limit alcanzado frecuentemente
  - Patterns de scraping detectados
  - Geolocalización inusual
```

---

## Costos Estimados

### Cloudflare

- **Free:** $0/mes - WAF básico, DDoS básico
- **Pro:** $20/mes - WAF avanzado, Image optimization
- **Business:** $200/mes - Custom rules, 24/7 support
- **Enterprise:** Custom - Advanced DDoS, SLA 100%

### AWS WAF

- **Web ACL:** $5/mes
- **Rules:** $1/mes por regla
- **Requests:** $0.60 por millón de requests
- **Estimado:** ~$50-200/mes para tráfico medio

### ModSecurity + Fail2ban

- **Costo:** $0 (open source)
- **Requerimientos:** Conocimiento técnico alto
- **Mantenimiento:** Manual

---

## Recomendación Final

### Para StreamVault - Setup Ideal:

```
Capa 1: Cloudflare (Pro)
├─ DDoS protection
├─ WAF con reglas OWASP
├─ Rate limiting global
└─ CDN para assets

Capa 2: Application Level (Node.js)
├─ advancedRateLimit.js
├─ Input sanitization
├─ Authentication/Authorization
└─ Logging

Capa 3: Servidor (Nginx + Fail2ban)
├─ Nginx rate limiting
├─ Fail2ban para ban automático
└─ ModSecurity (opcional)

Capa 4: Infraestructura
├─ Firewall de red (UFW/iptables)
├─ VPC/Security Groups
└─ IDS/IPS (opcional)
```

### Inversión Recomendada

**Mínimo:** Cloudflare Free + Fail2ban = $0/mes
**Recomendado:** Cloudflare Pro + Monitoring = $20-50/mes
**Óptimo:** Cloudflare Business + AWS WAF + SIEM = $250-500/mes

---

## Checklist de Implementación

- [ ] Registrar dominio en Cloudflare
- [ ] Configurar DNS en modo Proxied
- [ ] Activar WAF con OWASP rules
- [ ] Configurar rate limiting por endpoint
- [ ] Habilitar SSL/TLS Full Strict
- [ ] Crear custom rules para tu app
- [ ] Instalar y configurar Fail2ban
- [ ] Configurar alertas de seguridad
- [ ] Testing completo con OWASP ZAP
- [ ] Documentar configuración
- [ ] Entrenar equipo en respuesta a incidentes
- [ ] Plan de respaldo si WAF falla

---

## Soporte

- 📚 Cloudflare Docs: https://developers.cloudflare.com/waf/
- 📚 AWS WAF Docs: https://docs.aws.amazon.com/waf/
- 📚 ModSecurity: https://github.com/SpiderLabs/ModSecurity
- 📚 OWASP CRS: https://coreruleset.org/

---

**Última actualización:** 2026-02-05
**Versión:** 1.0
**Autor:** StreamVault Security Team
