#!/usr/bin/env node
/**
 * Fix plan prices in system_config table
 */

const db = require('../db');

const CORRECT_PRICES = {
  pro: 9.99,
  enterprise: 59
};

async function fixPrices() {
  console.log('🔧 Actualizando precios de planes...\n');
  
  try {
    // Update plans.pro
    const proPlan = await db.query('SELECT value FROM system_config WHERE key = $1', ['plans.pro']);
    if (proPlan.rows.length > 0) {
      const proData = JSON.parse(proPlan.rows[0].value);
      console.log(`Pro actual: $${proData.price}`);
      proData.price = CORRECT_PRICES.pro;
      await db.query('UPDATE system_config SET value = $1 WHERE key = $2', [JSON.stringify(proData), 'plans.pro']);
      console.log(`✅ Pro actualizado: $${CORRECT_PRICES.pro}`);
    }
    
    // Update plans.enterprise
    const entPlan = await db.query('SELECT value FROM system_config WHERE key = $1', ['plans.enterprise']);
    if (entPlan.rows.length > 0) {
      const entData = JSON.parse(entPlan.rows[0].value);
      console.log(`Enterprise actual: $${entData.price}`);
      entData.price = CORRECT_PRICES.enterprise;
      await db.query('UPDATE system_config SET value = $1 WHERE key = $2', [JSON.stringify(entData), 'plans.enterprise']);
      console.log(`✅ Enterprise actualizado: $${CORRECT_PRICES.enterprise}`);
    }
    
    // Update consolidated plans object
    const allPlans = await db.query('SELECT value FROM system_config WHERE key = $1', ['plans']);
    if (allPlans.rows.length > 0) {
      const plansData = JSON.parse(allPlans.rows[0].value);
      plansData.pro.price = CORRECT_PRICES.pro;
      plansData.enterprise.price = CORRECT_PRICES.enterprise;
      await db.query('UPDATE system_config SET value = $1 WHERE key = $2', [JSON.stringify(plansData), 'plans']);
      console.log('✅ Objeto consolidado actualizado');
    }
    
    console.log('\n✅ Todos los precios corregidos exitosamente!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

fixPrices();
