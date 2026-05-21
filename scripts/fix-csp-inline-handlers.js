#!/usr/bin/env node
/**
 * Script para eliminar event handlers inline y convertirlos a event listeners
 * Esto soluciona violaciones de CSP (Content Security Policy)
 */

const fs = require('fs');
const path = require('path');

// Mapeo de eventos inline a addEventListener
const eventMap = {
  'onclick': 'click',
  'onchange': 'change',
  'oninput': 'input',
  'onsubmit': 'submit',
  'onkeydown': 'keydown',
  'onkeyup': 'keyup',
  'onload': 'load',
  'onfocus': 'focus',
  'onblur': 'blur',
  'onmouseover': 'mouseover',
  'onmouseout': 'mouseout',
  'ondrop': 'drop',
  'ondragover': 'dragover',
};

function generateEventListeners(handlers) {
  if (handlers.length === 0) return '';
  
  let code = '\n// Event listeners (converted from inline handlers)\n';
  code += 'document.addEventListener(\'DOMContentLoaded\', function() {\n';
  
  for (const handler of handlers) {
    const { id, event, code: handlerCode } = handler;
    code += `  const el_${id.replace(/[^a-zA-Z0-9]/g, '_')} = document.getElementById('${id}');\n`;
    code += `  if (el_${id.replace(/[^a-zA-Z0-9]/g, '_')}) {\n`;
    code += `    el_${id.replace(/[^a-zA-Z0-9]/g, '_')}.addEventListener('${event}', function(event) {\n`;
    code += `      ${handlerCode}\n`;
    code += `    });\n`;
    code += `  }\n\n`;
  }
  
  code += '});\n';
  return code;
}

function processHtmlFile(filePath) {
  console.log(`\n📄 Procesando: ${filePath}`);
  
  let content = fs.readFileSync(filePath, 'utf8');
  const handlers = [];
  let idCounter = 1;
  
  // Buscar todos los event handlers inline
  for (const [inlineEvent, eventType] of Object.entries(eventMap)) {
    const regex = new RegExp(`(\\s+${inlineEvent}=["']([^"']+)["'])`, 'g');
    let match;
    
    while ((match = regex.exec(content)) !== null) {
      const fullMatch = match[1];
      const handlerCode = match[2];
      
      // Generar un ID único si el elemento no tiene uno
      const beforeMatch = content.substring(0, match.index);
      const tagStart = beforeMatch.lastIndexOf('<');
      const tagContent = content.substring(tagStart, match.index + fullMatch.length);
      
      let elementId;
      const idMatch = tagContent.match(/id=["']([^"']+)["']/);
      
      if (idMatch) {
        elementId = idMatch[1];
      } else {
        elementId = `auto_${eventType}_${idCounter++}`;
        // Agregar ID al elemento
        content = content.substring(0, match.index) +
                  ` id="${elementId}"` +
                  content.substring(match.index);
        regex.lastIndex = match.index + elementId.length + 6; // Ajustar índice
      }
      
      handlers.push({
        id: elementId,
        event: eventType,
        code: handlerCode
      });
      
      // Remover el handler inline
      content = content.replace(fullMatch, '');
    }
  }
  
  if (handlers.length > 0) {
    console.log(`  ✓ Encontrados ${handlers.length} event handlers inline`);
    
    // Generar código de event listeners
    const listenerCode = generateEventListeners(handlers);
    
    // Buscar el último <script> tag o agregarlo antes de </body>
    const lastScriptMatch = content.lastIndexOf('</script>');
    const bodyEndMatch = content.lastIndexOf('</body>');
    
    if (lastScriptMatch !== -1 && lastScriptMatch < bodyEndMatch) {
      // Agregar después del último script
      content = content.substring(0, lastScriptMatch + 9) +
                `\n<script>\n${listenerCode}\n</script>` +
                content.substring(lastScriptMatch + 9);
    } else if (bodyEndMatch !== -1) {
      // Agregar antes de </body>
      content = content.substring(0, bodyEndMatch) +
                `<script>\n${listenerCode}\n</script>\n` +
                content.substring(bodyEndMatch);
    }
    
    // Guardar archivo
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`  ✅ Archivo actualizado`);
    
    return handlers.length;
  } else {
    console.log(`  ℹ️  No se encontraron handlers inline`);
    return 0;
  }
}

function scanDirectory(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  let totalFixed = 0;
  
  for (const file of files) {
    const fullPath = path.join(dir, file.name);
    
    if (file.isDirectory() && !file.name.startsWith('.')) {
      totalFixed += scanDirectory(fullPath);
    } else if (file.isFile() && file.name.endsWith('.html')) {
      totalFixed += processHtmlFile(fullPath);
    }
  }
  
  return totalFixed;
}

// Ejecutar
console.log('🚀 Iniciando corrección de event handlers inline...\n');
console.log('📂 Directorio: public/\n');

const publicDir = path.join(__dirname, '..', 'public');
const totalFixed = scanDirectory(publicDir);

console.log(`\n✅ Proceso completado`);
console.log(`📊 Total de handlers corregidos: ${totalFixed}`);
console.log('\n⚠️  IMPORTANTE: Revisa los archivos y prueba la funcionalidad');
