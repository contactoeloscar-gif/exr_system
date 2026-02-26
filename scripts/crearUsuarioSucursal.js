require("dotenv").config();
const pool = require("../config/db");
const bcrypt = require("bcrypt");

async function main() {
  // Uso:
  // node scripts/crearUsuarioSucursal.js <usuario> <password> <sucursal_id> <nombre> [email] [rol]
  const usuario = process.argv[2];
  const password = process.argv[3];
  const sucursal_id = Number(process.argv[4]);
  const nombre = process.argv[5];
  const email = process.argv[6] || null;
  const rol = (process.argv[7] || "OPERADOR").trim().toUpperCase();

  if (!usuario || !password || !Number.isInteger(sucursal_id) || !nombre) {
    console.log(
      "Uso: node scripts/crearUsuarioSucursal.js <usuario> <password> <sucursal_id> <nombre> [email] [rol]"
    );
    console.log(
      "Ej:  node scripts/crearUsuarioSucursal.js once_admin Clave123 1 \"Operador Once\" once@exr.com.ar OPERADOR"
    );
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);

  await pool.query(
    `INSERT INTO usuarios (usuario, nombre, email, rol, password_hash, sucursal_id, activo)
     VALUES ($1,$2,$3,$4,$5,$6,true)
     ON CONFLICT (usuario) DO UPDATE
     SET nombre = EXCLUDED.nombre,
         email = EXCLUDED.email,
         rol = EXCLUDED.rol,
         password_hash = EXCLUDED.password_hash,
         sucursal_id = EXCLUDED.sucursal_id,
         activo = true`,
    [usuario, nombre, email, rol, hash, sucursal_id]
  );

  console.log("OK usuario creado/actualizado:", usuario, "(", nombre, ")");
  process.exit(0);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
