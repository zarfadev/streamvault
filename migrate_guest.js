require('dotenv').config();
const db = require('./db');

async function migrate() {
  try {
    await db.prepare('ALTER TABLE videos ADD COLUMN guest_session_id TEXT').run();
    console.log('Migration successful');
  } catch (err) {
    if (err.message.includes('already exists')) {
      console.log('Column already exists');
    } else {
      console.error(err);
    }
  }
}

migrate();
