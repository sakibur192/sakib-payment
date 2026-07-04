const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://trxuser:StrongPass123@187.127.145.228:5432/trxdb',
  ssl: false
});

// Structural Test Hook on boot
pool.query('SELECT inet_server_addr()', (err, res) => {
  if (err) {
    console.error("❌ DB CONNECTION ERROR:", err.message);
  } else {
    console.log("🔌 DB SERVER CONNECTED AT:", res.rows[0].inet_server_addr);
  }
});

module.exports = pool;