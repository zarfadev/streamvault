#!/usr/bin/env node
/**
 * Fix plan prices to match payment gateway configurations
 */

const db = require('../db');

const CORRECT_PRICES = {
  pro: 9.99,
  enterprise: 59
};

async function fixPrices() {
  console.log('🔧 Actualizando precios de planes...\n');
  
  try {
    // Get current prices
    const plans = await db.prepare('SELECT key, name, price FROM plans WHERE key IN (?, ?)').all('pro', 'enterprise');
    
    console.log('Precios actuales:');
    plans.forEach(p => {
      console.log(`  ${p.name} (${p.key}): $${p.price}`);
    });
    
    // Update prices
    const stmt = db.prepare('UPDATE plans SET price = ? WHERE key = ?');
    
    for (const [key, price] of Object.entries(CORRECT_PRICES)) {
      await stmt.run(price, key);
      console.log(`\n✅ ${key.toUpperCase()}: $${price}`);
    }
    
    // Verify
    console.log('\n📊 Precios actualizados:');
    const updated = await db.prepare('SELECT key, name, price FROM plans WHERE key IN (?, ?)').all('pro', 'enterprise');
    updated.forEach(p => {
      console.log(`  ${p.name} (${p.key}): $${p.price}`);
    });
    
    console.log('\n✅ Precios corregidos exitosamente!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

fixPrices();
