// Copia de seguridad de la base de datos (Realtime Database, proyecto rotatorio-tcaes).
// Escribe el JSON completo en el archivo que se le pase. El workflow lo cifra enseguida
// y borra el original. El registro es público: aquí solo se imprimen tamaños.
"use strict";
const fs = require("fs");
const { initializeApp, cert } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error("Falta el archivo de salida");
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({
    credential: cert(sa),
    databaseURL: "https://rotatorio-tcaes-default-rtdb.europe-west1.firebasedatabase.app",
  });
  const data = (await getDatabase().ref("/").once("value")).val();
  if (!data || typeof data !== "object" || Object.keys(data).length < 5) {
    throw new Error("La base de datos ha llegado vacía o casi vacía; no se guarda la copia");
  }
  const json = JSON.stringify({ exportedAt: new Date().toISOString(), data });
  fs.writeFileSync(out, json, { mode: 0o600 });
  console.log(`Copia: ${Object.keys(data).length} nodos raíz, ${(json.length / 1024).toFixed(0)} KB sin cifrar`);
}

main().catch((e) => { console.log("::error title=Fallo de la copia::" + (e && e.message ? e.message.split("\n")[0] : e)); process.exitCode = 1; })
  .finally(() => setTimeout(() => process.exit(), 500));
