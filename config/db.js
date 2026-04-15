const { Pool } = require("pg");
require("dotenv").config();

function buildPoolConfig() {
  // Preferimos DATABASE_URL si existe
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      // Si más adelante vas a producción con SSL (Render/Railway/etc), activás:
      // ssl: { rejectUnauthorized: false },
    };
  }

  // Fallback por variables sueltas (si las agregás después)
  return {
    user: process.env.DB_USER,
    password: process.env.DB_PASS || process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
  };
}

const pool = new Pool(buildPoolConfig());

module.exports = pool;