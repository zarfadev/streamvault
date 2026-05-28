# CloudFront Signed Cookies — Protección anti-scraper

## Problema
Los scrapers pueden extraer la URL directa del CDN (ej: `https://d3rogjkhg045t5.cloudfront.net/streamvault/.../master.m3u8`) desde DevTools y clonar el video sin pasar por tu servidor.

## Solución
**CloudFront Signed Cookies** — el CDN solo sirve contenido a viewers que tengan una cookie firmada temporal.

## Flujo
```
1. Player carga → GET /api/videos/:id/stream-session
2. Servidor verifica dominio (Origin/Referer vs embedAllowedDomains)
3. Servidor genera cookies firmadas (4h de vida) → Set-Cookie
4. Player carga m3u8 desde CloudFront con las cookies → ✅ CDN sirve
5. Scraper copia URL directa → ❌ Sin cookie = 403 Forbidden
```

## Configuración AWS (una sola vez)

### Paso 1: Crear un Key Group en CloudFront

1. Ve a **AWS Console → CloudFront → Key management → Public keys**
2. Genera un par RSA-2048:
   ```bash
   openssl genrsa -out cf-private-key.pem 2048
   openssl rsa -pubout -in cf-private-key.pem -out cf-public-key.pem
   ```
3. Sube `cf-public-key.pem` → toma nota del **Key Pair ID** (ej: `K2JCJMDEHXQW7F`)
4. Crea un **Key Group** que contenga esa public key

### Paso 2: Restringir la distribución

1. Ve a tu distribución de CloudFront → **Behaviors → Default (*)**
2. En **Restrict viewer access** → selecciona **Yes**
3. En **Trusted key groups** → selecciona el Key Group del paso 1
4. Guarda cambios

### Paso 3: Variables de entorno en tu servidor

Agrega al `.env` de producción:

```env
# CloudFront Signed Cookies
CF_KEY_PAIR_ID=K2JCJMDEHXQW7F
CF_PRIVATE_KEY_PATH=/app/keys/cf-private-key.pem
# O inline (si no puedes montar archivos):
# CF_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"

# Dominio de la cookie (debe incluir el punto para subdomains)
CF_COOKIE_DOMAIN=.cloudfront.net

# Expiración de las cookies en horas (default: 4)
CF_SIGNED_EXPIRY_HOURS=4
```

### Paso 4: Montar la clave privada en Docker

```yaml
# docker-compose.prod.yml
services:
  api:
    volumes:
      - ./keys/cf-private-key.pem:/app/keys/cf-private-key.pem:ro
```

### Paso 5: Reiniciar

```bash
docker restart streamvault_api
```

## Verificación

```bash
# Sin cookie → debe retornar 403
curl -I "https://d3rogjkhg045t5.cloudfront.net/streamvault/.../master.m3u8"

# Con stream-session → debe retornar cookies y luego funcionar
curl "https://tu-servidor.com/api/videos/VIDEO_ID/stream-session"
```

## Uso desde player externo / app nativa

El usuario que quiera usar el m3u8 en un player propio debe:

1. Llamar al endpoint de stream-session con su API key:
   ```
   GET /api/videos/:id/stream-session
   Authorization: Bearer <api_key>
   Origin: https://su-dominio-autorizado.com
   ```

2. Recibir las cookies en el JSON response:
   ```json
   {
     "signed": true,
     "expiresAt": 1716900000,
     "cookies": {
       "CloudFront-Policy": "...",
       "CloudFront-Signature": "...",
       "CloudFront-Key-Pair-Id": "K2JCJMDEHXQW7F"
     }
   }
   ```

3. Enviar esas cookies con cada request al CDN (su player debe soportar cookies HTTP).

## Notas importantes

- La cookie expira en 4 horas por defecto — el player debe renovar llamando a `/stream-session` periódicamente.
- Si `CF_KEY_PAIR_ID` no está configurado, el sistema funciona como antes (CDN público).
- Los dominios permitidos se configuran en **Dashboard → Configuración → Dominios de embed permitidos**.
- El endpoint `/api/videos/:id/stream-session` tiene rate-limit de 30 requests/min por IP.
