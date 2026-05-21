# StreamVault — Sistema de Streaming HLS

Sistema completo de streaming de video self-hosted. Sube MP4 y el sistema genera automáticamente streams HLS en múltiples calidades (360p → 4K).

## Características

- ✅ Subida de MP4/MKV/AVI/MOV (hasta 10GB)
- ✅ Transcodificación automática a HLS en background
- ✅ Múltiples calidades: 360p, 480p, 720p, 1080p, 1440p, 4K (según resolución original)
- ✅ Master playlist `.m3u8` compatible con VLC, Infuse, todos los players
- ✅ Player web con selector de calidad, controles completos, teclado shortcuts
- ✅ Compatible con todos los navegadores (Chrome, Firefox, Safari, Edge, iOS, Android)
- ✅ Thumbnails automáticos
- ✅ Dashboard de administración oscuro
- ✅ Base de datos SQLite (sin configuración)
- ✅ API REST completa

## Requisitos

- **Node.js** 18+
- **FFmpeg** instalado en el sistema

### Instalar FFmpeg

**Ubuntu/Debian:**
```bash
sudo apt update && sudo apt install -y ffmpeg
```

**macOS:**
```bash
brew install ffmpeg
```

**Windows:**
Descargar desde https://ffmpeg.org/download.html y agregar al PATH.

## Instalación

```bash
# 1. Instalar dependencias
npm install

# 2. Crear carpetas necesarias
mkdir -p uploads videos

# 3. Iniciar servidor
npm start
```

El servidor corre en: `http://localhost:3000`

## URLs

| URL | Descripción |
|-----|-------------|
| `http://localhost:3000/dashboard` | Panel de administración |
| `http://localhost:3000/watch/:id` | Player público del video |
| `http://localhost:3000/videos/:id/master.m3u8` | Stream HLS directo |
| `http://localhost:3000/videos/:id/thumb.jpg` | Thumbnail |

## API REST

```
POST /api/upload              - Subir video (multipart/form-data, campo: video)
GET  /api/videos              - Listar todos los videos
GET  /api/videos/:id          - Info de video (incrementa vistas)
PATCH /api/videos/:id         - Editar título/descripción
DELETE /api/videos/:id        - Eliminar video y archivos
GET  /api/admin/stats         - Estadísticas
```

## Usar en terceros

El `.m3u8` funciona directamente en:
- **VLC**: Archivo → Abrir URL → pegar .m3u8
- **Infuse (Apple TV/iOS)**: Agregar URL directa
- **mpv**: `mpv http://tuserver/videos/ID/master.m3u8`
- **OBS**: Source → VLC Video Source → agregar URL
- **HTML5**: Con `<video>` + hls.js

## Producción

Para producción, usa un reverse proxy (Nginx/Caddy) con HTTPS:

```nginx
server {
    listen 443 ssl;
    server_name tudominio.com;

    # Servir segmentos .ts con cache
    location /videos/ {
        root /ruta/a/streamvault;
        add_header Cache-Control "public, max-age=86400";
        add_header Access-Control-Allow-Origin "*";
    }

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        client_max_body_size 10G;
    }
}
```

## Variables de entorno

```env
PORT=3000                  # Puerto (default: 3000)
```

## Estructura de archivos

```
streamvault/
├── server.js          # Servidor Express principal
├── db.js              # Base de datos SQLite
├── transcoder.js      # Motor FFmpeg → HLS
├── routes/
│   ├── upload.js      # Endpoint de subida
│   ├── videos.js      # CRUD videos
│   └── admin.js       # Estadísticas
├── public/
│   ├── dashboard/     # Panel admin
│   └── player/        # Player público
├── uploads/           # Archivos temporales (se eliminan tras transcodificar)
└── videos/            # Videos transcodificados
    └── {uuid}/
        ├── master.m3u8
        ├── thumb.jpg
        ├── 360p/
        │   ├── index.m3u8
        │   └── seg001.ts ...
        ├── 720p/
        └── 1080p/
```
