#!/usr/bin/env node
/**
 * Script para generar hashes SRI (Subresource Integrity)
 * Uso: node scripts/generate-sri.js [archivo]
 * 
 * Genera hashes SHA-384 para archivos JavaScript y CSS
 * que pueden ser usados en atributos integrity=""
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Archivos a generar SRI
const FILES_TO_HASH = [
  'public/js/sanitize.js',
  'public/css/sv-theme.css',
  'public/css/player-ott.css',
];

/**
 * Genera hash SRI para un archivo
 * @param {string} filePath - Ruta al archivo
 * @returns {string} Hash en formato sha384-xxx
 */
function generateSRI(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    const hash = crypto.createHash('sha384').update(content).digest('base64');
    return `sha384-${hash}`;
  } catch (error) {
    console.error(`❌ Error generando SRI para ${filePath}:`, error.message);
    return null;
  }
}

/**
 * Genera SRI para todos los archivos configurados
 */
function generateAllSRI() {
  console.log('🔐 Generando hashes SRI...\n');
  
  const results = [];
  
  for (const file of FILES_TO_HASH) {
    const fullPath = path.join(process.cwd(), file);
    
    if (!fs.existsSync(fullPath)) {
      console.log(`⚠️  Archivo no encontrado: ${file}`);
      continue;
    }
    
    const sri = generateSRI(fullPath);
    if (sri) {
      const stats = fs.statSync(fullPath);
      results.push({
        file,
        sri,
        size: (stats.size / 1024).toFixed(2) + ' KB',
      });
      
      console.log(`✅ ${file}`);
      console.log(`   Hash: ${sri}`);
      console.log(`   Tamaño: ${(stats.size / 1024).toFixed(2)} KB\n`);
    }
  }
  
  // Generar código HTML de ejemplo
  console.log('\n📝 Ejemplos de uso:\n');
  console.log('<!-- Para archivos JavaScript -->');
  for (const result of results.filter(r => r.file.endsWith('.js'))) {
    const fileName = path.basename(result.file);
    const filePath = '/' + result.file.replace(/^public\//, '');
    console.log(`<script src="${filePath}"`);
    console.log(`  integrity="${result.sri}"`);
    console.log(`  crossorigin="anonymous"></script>`);
    console.log();
  }
  
  console.log('<!-- Para archivos CSS -->');
  for (const result of results.filter(r => r.file.endsWith('.css'))) {
    const filePath = '/' + result.file.replace(/^public\//, '');
    console.log(`<link rel="stylesheet" href="${filePath}"`);
    console.log(`  integrity="${result.sri}"`);
    console.log(`  crossorigin="anonymous">`);
    console.log();
  }
  
  // Guardar en archivo JSON
  const outputFile = path.join(process.cwd(), 'sri-hashes.json');
  const output = {
    generated: new Date().toISOString(),
    hashes: results.reduce((acc, r) => {
      acc[r.file] = {
        sri: r.sri,
        size: r.size,
      };
      return acc;
    }, {}),
  };
  
  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
  console.log(`\n💾 Hashes guardados en: sri-hashes.json`);
}

/**
 * Verifica los hashes SRI en archivos HTML
 */
function verifySRIInHTML() {
  console.log('\n🔍 Verificando implementación de SRI en archivos HTML...\n');
  
  const htmlFiles = [
    'public/dashboard/index.html',
    'public/admin/index.html',
    'public/player/index.html',
    'public/embed/index.html',
    'public/login/index.html',
  ];
  
  let hasIntegrity = 0;
  let missingIntegrity = 0;
  
  for (const htmlFile of htmlFiles) {
    const fullPath = path.join(process.cwd(), htmlFile);
    
    if (!fs.existsSync(fullPath)) continue;
    
    const content = fs.readFileSync(fullPath, 'utf8');
    
    // Buscar tags script con src
    const scriptTags = content.match(/<script[^>]+src=[^>]+>/gi) || [];
    
    for (const tag of scriptTags) {
      // Verificar si tiene integrity
      const hasIntegritySRI = tag.includes('integrity="sha');
      const src = tag.match(/src=["']([^"']+)["']/)?.[1] || '';
      
      // Solo verificar archivos locales
      if (src.startsWith('/js/') || src.startsWith('/public/')) {
        if (hasIntegritySRI) {
          hasIntegrity++;
        } else {
          missingIntegrity++;
          console.log(`⚠️  ${htmlFile}: falta SRI en ${src}`);
        }
      }
    }
  }
  
  console.log(`\n📊 Resumen:`);
  console.log(`   ✅ Con SRI: ${hasIntegrity}`);
  console.log(`   ⚠️  Sin SRI: ${missingIntegrity}`);
  
  if (missingIntegrity === 0) {
    console.log('\n✨ Todos los scripts locales tienen SRI implementado!');
  } else {
    console.log('\n⚠️  Algunos scripts requieren SRI. Ejecuta este script y actualiza los HTML.');
  }
}

// CLI
const args = process.argv.slice(2);

if (args.includes('--verify')) {
  verifySRIInHTML();
} else if (args.includes('--help') || args.includes('-h')) {
  console.log(`
🔐 Generador de hashes SRI (Subresource Integrity)

Uso:
  node scripts/generate-sri.js              Genera hashes SRI
  node scripts/generate-sri.js --verify     Verifica implementación en HTML
  node scripts/generate-sri.js --help       Muestra esta ayuda

Los hashes se guardan en sri-hashes.json y se muestran en consola.
  `);
} else {
  generateAllSRI();
  verifySRIInHTML();
}
