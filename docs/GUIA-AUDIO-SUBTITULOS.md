# 🎵 Guía de Audio y Subtítulos en StreamVault

## ✅ Estado de la Funcionalidad

**La funcionalidad de gestión de pistas de audio y subtítulos YA ESTÁ COMPLETAMENTE IMPLEMENTADA** en StreamVault.

## 📍 ¿Dónde encontrarla?

### En el Dashboard (Vista de Lista o Grid)

1. **Accede al Dashboard** → `/dashboard`
2. **Busca el video** que deseas editar
3. **Haz clic en el menú de tres puntos (⋮)** en la tarjeta del video
4. **Selecciona "Pistas y subtítulos"** en el menú desplegable

### Ubicación del Botón

El botón **"Pistas y subtítulos"** aparece en el menú contextual de cada video, junto con:
- Editar
- Ver
- Copiar link
- Copiar embed
- Página descarga
- **← Mover a carpeta**
- **← Añadir a playlist**
- **← Pistas y subtítulos** 👈 **AQUÍ ESTÁ**

## 🎬 Funcionalidades Disponibles

### 1. **Subtítulos**
- Subir archivos `.srt` o `.vtt`
- Seleccionar idioma (Español, English, Português, Français, etc.)
- Personalizar etiqueta visible
- Marcar como subtítulo predeterminado
- Ver lista de todos los subtítulos disponibles
- Eliminar subtítulos existentes

### 2. **Pistas de Audio**
- Subir archivos de audio (MP3, AAC, M4A, WAV, FLAC, OGG, OPUS)
- Seleccionar idioma de la pista
- Personalizar etiqueta (ej: "Español", "English", "Commentary")
- Marcar como audio predeterminado
- Ver lista de todas las pistas de audio
- Eliminar pistas existentes

### 3. **Reconstruir Playlist**
- Botón para regenerar el archivo `master.m3u8`
- Útil cuando agregas o eliminas múltiples pistas

## 🔧 Endpoints de API Disponibles

```javascript
// Listar todas las pistas de un video
GET /api/videos/:videoId/tracks

// Subir un subtítulo
POST /api/videos/:videoId/tracks/subtitle
FormData: { file, language, label, isDefault }

// Subir una pista de audio
POST /api/videos/:videoId/tracks/audio
FormData: { file, language, label, isDefault }

// Eliminar una pista
DELETE /api/videos/:videoId/tracks/:trackId

// Reconstruir playlist master.m3u8
POST /api/videos/:videoId/tracks/rebuild
```

## 📂 Archivos Relacionados

### Frontend
- **HTML:** `public/dashboard/index.html` (líneas 4052-4213) - Modal de Tracks
- **JavaScript:** `public/js/app-dashboard.js`
  - `openTracksModal()` - Abre el modal
  - `uploadSubtitle()` - Sube subtítulos
  - `uploadAudio()` - Sube pistas de audio
  - `loadTracks()` - Carga la lista de pistas
  - `deleteTrack()` - Elimina una pista
  - `rebuildTracksPlaylist()` - Regenera master.m3u8

### Backend
- **Rutas:** `routes/tracks.js` - Todos los endpoints
- **Base de datos:** Tabla `tracks` en `db/schema.js`

## 🎨 Interfaz del Modal

El modal tiene **dos pestañas**:

### Pestaña "Subtítulos"
```
┌─────────────────────────────────────────┐
│ 🎬 Pistas — Nombre del Video           │
│ Gestiona subtítulos y pistas de audio  │
├─────────────────────────────────────────┤
│                                         │
│ [Lista de pistas existentes]            │
│                                         │
│ ─────────────────────────────────────── │
│ AGREGAR NUEVA PISTA                     │
│                                         │
│ [Subtítulos] [Audio] ← Pestañas        │
│                                         │
│ Idioma: [Español ▼]                     │
│ Etiqueta: [Español, English...]         │
│                                         │
│ ┌─────────────────────────────────┐   │
│ │ 📤 Arrastra aquí o haz click     │   │
│ │    Formatos: .srt, .vtt          │   │
│ └─────────────────────────────────┘   │
│                                         │
│ ☑ Subtítulo predeterminado              │
│                                         │
│ [Subir subtítulo]                       │
└─────────────────────────────────────────┘
```

### Pestaña "Audio"
```
┌─────────────────────────────────────────┐
│ Idioma: [Español ▼]                     │
│ Etiqueta: [Español, Commentary...]      │
│                                         │
│ ┌─────────────────────────────────┐   │
│ │ 🎵 Arrastra aquí o haz click     │   │
│ │    Formatos: MP3, AAC, M4A...    │   │
│ └─────────────────────────────────┘   │
│                                         │
│ ☑ Audio predeterminado                  │
│                                         │
│ [Subir audio]                           │
└─────────────────────────────────────────┘
```

## 🐛 Solución de Problemas

### "No veo el botón Pistas y subtítulos"

**Solución:**
1. Limpia la caché del navegador (Ctrl+Shift+R o Cmd+Shift+R)
2. Verifica que estés en el Dashboard
3. Asegúrate de hacer clic en el menú **⋮** (tres puntos verticales)
4. El botón aparece con un ícono de música 🎵

### "El modal no se abre"

**Solución:**
1. Abre la consola del navegador (F12)
2. Busca errores en JavaScript
3. Verifica que `public/js/app-dashboard.js` se cargue correctamente

### "Los archivos no se suben"

**Solución:**
1. Verifica que el archivo cumpla con los formatos permitidos:
   - Subtítulos: `.srt`, `.vtt`
   - Audio: `.mp3`, `.aac`, `.m4a`, `.wav`, `.flac`, `.ogg`, `.opus`
2. Revisa los logs del servidor para errores
3. Verifica que la ruta `/api/videos/:id/tracks/subtitle` o `/audio` responda

## 🎯 Casos de Uso

### 1. Agregar subtítulos en español
```
1. Click en ⋮ del video
2. "Pistas y subtítulos"
3. Pestaña "Subtítulos"
4. Idioma: Español
5. Etiqueta: "Español"
6. Arrastrar archivo .srt
7. ☑ Marcar como predeterminado
8. Click "Subir subtítulo"
```

### 2. Agregar audio alternativo
```
1. Click en ⋮ del video
2. "Pistas y subtítulos"
3. Pestaña "Audio"
4. Idioma: English
5. Etiqueta: "English Audio"
6. Arrastrar archivo .mp3
7. Click "Subir audio"
```

### 3. Agregar múltiples idiomas
```
1. Sube el primer subtítulo (ej: Español)
2. Aparecerá en la lista superior
3. Sube el segundo subtítulo (ej: English)
4. Sube el tercer subtítulo (ej: Português)
5. Click "Reconstruir playlist" si es necesario
```

## ✨ Características Adicionales

- **Drag & Drop:** Arrastra archivos directamente al área de carga
- **Vista previa:** Los archivos seleccionados se muestran como chips
- **Idiomas personalizados:** Opción "Otro" para códigos ISO personalizados
- **Gestión visual:** Lista con miniaturas y botones de acción
- **Eliminación segura:** Confirmación antes de eliminar pistas

## 📝 Notas Importantes

1. **Solo videos en estado "ready"** pueden tener pistas adicionales
2. **Los archivos se procesan en el servidor** y se integran al HLS
3. **El reproductor automáticamente detecta** las pistas disponibles
4. **Marcar como predeterminado** hace que se seleccione automáticamente
5. **Reconstruir playlist** regenera el `master.m3u8` con todas las pistas

---

**¿Sigues sin ver la opción?** 
Por favor, limpia la caché del navegador o abre en modo incógnito.
La funcionalidad está 100% operativa. 🎉
