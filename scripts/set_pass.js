// scripts/set_pass.js
require("dotenv").config();
const bcrypt = require("bcryptjs");
const pool = require("../config/db");

(async () => {
  try {
    const usuario = process.argv[2];
    const pass = process.argv[3];

    if (!usuario || !pass) {
      console.log("Uso: node scripts/set_pass.js admin pepito0818");
      process.exit(1);
    }

    const hash = await bcrypt.hash(pass, 10);

    const r = await pool.query(
      "UPDATE public.usuarios SET password_hash=$1 WHERE lower(usuario)=lower($2) RETURNING id, usuario, rol",
      [hash, usuario]
    );

    if (!r.rows.length) {
      console.log("No existe el usuario:", usuario);
      process.exit(2);
    }

    console.log("OK password actualizado:", r.rows[0]);
    await pool.end();
  } catch (e) {
    console.error("ERROR:", e.message);
    process.exit(3);
  }
})();