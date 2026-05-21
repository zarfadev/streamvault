# 📱 Sistema de Diseño Responsive — StreamVault

## 🎯 Filosofía: Mobile-First

StreamVault utiliza un enfoque **mobile-first** con breakpoints granulares que se adaptan progresivamente desde dispositivos pequeños hasta pantallas grandes.

---

## 📐 Breakpoints del Sistema

### 🖥️ **Large Desktop** — 1440px+
- **Sidebar**: 240px (más ancho)
- **Main padding**: 32px → 60px (máximo)
- **Stats grid**: 4 columnas con gap de 16px
- **Stat cards**: padding 24px
- **Page title**: 1.6rem

**Uso ideal**: Monitores 4K, pantallas ultra wide

---

### 🖥️ **Desktop** — 1200px → 1439px
- **Sidebar**: 220px
- Configuración estándar mantenida
- Espaciado óptimo para escritorio

**Uso ideal**: Monitores Full HD, laptops grandes

---

### 💻 **Laptop/Tablet Landscape** — 1024px → 1199px
- **Sidebar**: 200px (reducido)
- **Stats grid**: 4 columnas, gap 12px
- **Main padding**: 24px → 20px → 48px
- Tables con padding reducido

**Uso ideal**: Laptops 13"-15", tablets en landscape

---

### 📱 **Tablet Portrait** — 768px → 1023px
- **Sidebar**: 200px
- **Stats grid**: 3 columnas
- **Card padding**: 18px
- **Grid3**: se convierte en 2 columnas
- Menu toggle visible
- Tables con columnas reducidas

**Uso ideal**: iPad, tablets Android en portrait

---

### 📱 **Mobile Large** — 640px → 767px
- **Sidebar**: 240px (drawer overlay)
- **Stats grid**: 2 columnas
- **Main**: full width, sidebar como drawer
- Profile text oculto en header
- Tables: ocultar columnas menos importantes
- Modals: bottom sheet style
- Grids: 1 columna

**Uso ideal**: iPhones Pro Max, Android grandes

---

### 📱 **Mobile Medium** — 480px → 639px
- **Sidebar**: 260px drawer
- **Stats grid**: 2 columnas, gap 8px
- **Stat values**: 24px
- Header center oculto
- Typography reducida
- Buttons: 42px min height (tap targets)
- Tab bars con scroll horizontal
- Toast: max-width adaptativo

**Uso ideal**: iPhones estándar, Android medianos

---

### 📱 **Mobile Small** — 320px → 479px
- **Sidebar**: 85vw, max 300px
- **Stats grid**: 1 columna (vertical)
- **Header**: 52px height (compacto)
- **Stat values**: 22px
- Typography ultra-compacta
- Buttons: 44px min height (accesibilidad)
- Modals: 90vh fullscreen
- Tables: columnas mínimas
- Toast: full width con margins
- Toolbar: vertical stack

**Uso ideal**: iPhones SE, Android compactos

---

## 🌐 Breakpoints Especiales

### 📏 **Landscape Phones** — height < 500px
```css
@media (max-height: 500px) and (orientation: landscape)
```
- Modal body: max-height 40vh
- Stats grid: 2 columnas
- Optimizado para scroll vertical reducido

### 👆 **Touch Devices**
```css
@media (hover: none) and (pointer: coarse)
```
- Tap targets aumentados (44px mínimo)
- Hover effects deshabilitados
- Nav items: 12px padding vertical
- Accesibilidad táctil mejorada

---

## 🎨 Componentes Responsive

### 📊 Stats Grid
```
Desktop:     4 columnas → gap 14-16px
Tablet:      3 columnas → gap 12px
Mobile L:    2 columnas → gap 10px
Mobile M:    2 columnas → gap 8px
Mobile S:    1 columna  → gap 8px
```

### 🗂️ Sidebar Behavior
```
Desktop (1024px+):     Fixed sidebar, always visible
Tablet (768-1023px):   Fixed but narrower, toggle visible
Mobile (<768px):       Drawer overlay, transform -100%
```

### 📋 Tables
**Columnas ocultas progresivamente:**
```
Mobile L:    .vt-col-size, .vt-col-slug, .vt-col-created
Mobile S:    + .vt-col-owner
```

### 🪟 Modals
```
Desktop:     Center overlay, max-width 560px-720px
Tablet:      Similar, max-width 100%
Mobile:      Bottom sheet, border-radius top only
Mobile S:    90vh fullscreen, minimal chrome
```

### 📦 Grids & Forms
```
.grid3:
  Desktop:   3 columnas
  Tablet:    2 columnas
  Mobile:    1 columna

.grid2, .form-row:
  Desktop:   2 columnas
  Mobile:    1 columna
```

---

## 🎯 Targets de Accesibilidad (WCAG 2.1)

### Touch Targets (Level AAA)
- **Mínimo**: 44px × 44px en mobile
- Buttons: min-height 44px en <480px
- Icon buttons: 40px × 40px
- Nav items: padding aumentado (12px)

### Typography Legibility
```
Desktop:       13-14px base
Mobile Large:  13px base
Mobile Medium: 12-13px base
Mobile Small:  11-14px (inputs más grandes)
```

### Focus Indicators
- `--focus-ring` visible en todos los breakpoints
- Keyboard navigation optimizada
- Skip links disponibles

---

## 🛠️ Técnicas de Implementación

### 1. **Sidebar Drawer Pattern**
```javascript
// Implementado en app-admin.js, app-dashboard.js
menuToggle.addEventListener('click', () => {
  document.body.classList.toggle('nav-open');
});
navBackdrop.addEventListener('click', () => {
  document.body.classList.remove('nav-open');
});
```

### 2. **Responsive Images**
```html
<!-- Usar srcset cuando aplique -->
<img src="thumb.jpg" 
     srcset="thumb-320.jpg 320w, thumb-640.jpg 640w"
     sizes="(max-width: 480px) 100vw, (max-width: 768px) 50vw, 320px">
```

### 3. **Viewport Meta Tag**
```html
<!-- Ya implementado en todas las páginas -->
<meta name="viewport" content="width=device-width, initial-scale=1.0">
```

---

## 📊 Testing Checklist

### ✅ Desktop
- [ ] Layout en 1920×1080
- [ ] Layout en 1440×900
- [ ] Sidebar visible y funcional
- [ ] 4 columnas en stats

### ✅ Tablet
- [ ] Layout en iPad (1024×768)
- [ ] 3 columnas en portrait
- [ ] Menu toggle funcional
- [ ] Sidebar narrower pero visible

### ✅ Mobile
- [ ] iPhone 14 Pro Max (430×932)
- [ ] iPhone 14 (390×844)
- [ ] iPhone SE (375×667)
- [ ] Android (360×640)
- [ ] Sidebar drawer funcionando
- [ ] 2/1 columna en stats
- [ ] Tap targets ≥44px
- [ ] Modals fullscreen

### ✅ Landscape
- [ ] Phones en landscape
- [ ] Modal height reducido
- [ ] Stats grid adaptado

### ✅ Touch
- [ ] Hover effects deshabilitados
- [ ] Tap targets aumentados
- [ ] Smooth scrolling

---

## 🚀 Comandos de Testing

### Chrome DevTools
```bash
# Responsive Mode: Cmd+Shift+M (Mac) / Ctrl+Shift+M (Windows)

# Presets recomendados:
- iPhone SE (375×667)
- iPhone 14 Pro (393×852)
- iPad (768×1024)
- iPad Pro (1024×1366)
- Desktop HD (1920×1080)
```

### Firefox Responsive Design Mode
```bash
# Cmd+Option+M (Mac) / Ctrl+Shift+M (Windows)
```

### Safari Responsive Design Mode
```bash
# Develop → Enter Responsive Design Mode
```

---

## 📱 Dispositivos Objetivo

### 🎯 Tier 1 (Soporte prioritario)
- **Desktop**: 1920×1080 → 1440×900
- **Laptop**: 1440×900 → 1280×720
- **Tablet**: iPad (1024×768), iPad Pro (1024×1366)
- **Mobile**: iPhone 14/15 (393×852), Galaxy S21+ (384×854)

### ⭐ Tier 2 (Soporte completo)
- **Desktop**: 2560×1440 (2K), 3840×2160 (4K)
- **Mobile**: iPhone SE (375×667), Pixel 5 (393×851)
- **Small**: Android compactos (360×640)

### ✨ Tier 3 (Funcional)
- **Muy pequeño**: 320px width (mínimo)
- **Landscape phones**: height < 500px

---

## 🐛 Problemas Conocidos

### Issue #1: Safari Mobile Viewport Bug
**Síntoma**: 100vh incluye la barra de navegación  
**Solución**: Usar `calc(100vh - 56px)` o JS viewport height

### Issue #2: Flexbox Gap en IE11
**Síntoma**: `gap` no soportado  
**Solución**: Usar margin negativo o grid como fallback

### Issue #3: Backdrop-filter en Firefox
**Síntoma**: Performance en modals  
**Solución**: Ya implementado con prefijos webkit

---

## 📚 Referencias

- [MDN Responsive Design](https://developer.mozilla.org/en-US/docs/Learn/CSS/CSS_layout/Responsive_Design)
- [WCAG Touch Target Guidelines](https://www.w3.org/WAI/WCAG21/Understanding/target-size.html)
- [Chrome DevTools Mobile Emulation](https://developer.chrome.com/docs/devtools/device-mode/)
- [CSS Tricks: Complete Guide to Grid](https://css-tricks.com/snippets/css/complete-guide-grid/)

---

## 🔄 Changelog

### v2.0.0 — 2026-10-05
- ✨ Sistema de breakpoints granular (7 breakpoints)
- 🎯 Touch device optimizations
- 📱 Sidebar drawer pattern mejorado
- 🎨 Stats grid adaptativo (4→3→2→1)
- 📋 Tables responsive con columnas ocultas
- 🪟 Modals bottom sheet en mobile
- 👆 Tap targets WCAG AAA (44px)
- 🌐 Landscape phone optimizations

### v1.0.0 — 2026-09-XX
- 🚀 Sistema responsive inicial
- 📱 Breakpoints básicos (768px, 480px)
- 🎨 Componentes adaptativos

---

**Última actualización**: 5 de octubre, 2026  
**Mantenido por**: StreamVault Team
