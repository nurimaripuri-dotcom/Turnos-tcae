// Tarea puntual (14-nov-2026): deshace el cambio de prueba Alberto (fila 4) ↔ Pepa (fila 9) del 17/11/2026,
// aceptado sin querer. Solo actúa si las casillas están exactamente como las dejó la aceptación.
// No imprime nombres ni comentarios (el registro de Actions es público).
const { initializeApp, cert } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(sa), databaseURL: "https://rotatorio-tcaes-default-rtdb.europe-west1.firebasedatabase.app" });
const db = getDatabase();
const DAY = "20261117", A = 4, P = 9;
const letter = v => v == null ? null : (typeof v === "string" ? v : (Array.isArray(v) ? v[0] : (v[0] ?? Object.values(v)[0])));
(async () => {
  const props = (await db.ref("tcaes_proposals").once("value")).val() || {};
  const cand = Object.entries(props).filter(([k, p]) => p && p.status === "accepted" &&
    ((+p.from === A && +p.to === P) || (+p.from === P && +p.to === A)) &&
    (String(p.fromDay).endsWith("_" + DAY) || String(p.toDay).endsWith("_" + DAY)));
  console.log("Propuestas aceptadas entre las dos filas que tocan el 17/11:", cand.length);
  if (cand.length !== 1) { console.log("::warning::No hay exactamente una; no se toca nada."); return; }
  const [key, p] = cand[0];
  const fromPi = +p.from - 1, toPi = +p.to - 1;
  const X = String(p.fromDay).split("_")[1], Y = String(p.toDay).split("_")[1];
  const keys = [...new Set([fromPi + "_" + X, fromPi + "_" + Y, toPi + "_" + Y, toPi + "_" + X])];
  const cur = {};
  for (const k of keys) cur[k] = (await db.ref("rota_changes/" + k).once("value")).val();
  // Lo que dejó la aceptación
  const expect = {};
  expect[fromPi + "_" + X] = "L"; expect[fromPi + "_" + Y] = p.toTurn;
  expect[toPi + "_" + Y] = "L"; expect[toPi + "_" + X] = p.kind === "doble" ? null : p.fromTurn;
  if (X === Y) { expect[fromPi + "_" + X] = p.toTurn; expect[toPi + "_" + X] = p.kind === "doble" ? null : p.fromTurn; }
  console.log("Mismo día:", X === Y, "· turnos", p.fromTurn, "↔", p.toTurn);
  let ok = true;
  for (const k of keys) {
    const got = letter(cur[k]);
    const want = expect[k];
    const match = want === null ? true : got === want;
    console.log(" casilla", k.replace(/^\d+_/, "fila?_"), "ahora:", got, "· esperado:", want, match ? "✓" : "✗");
    if (!match) ok = false;
  }
  if (!ok) { console.log("::warning::Las casillas no coinciden con el cambio aceptado (¿se han tocado después?). No se toca nada."); return; }
  const upd = {};
  for (const k of keys) upd["rota_changes/" + k] = null;   // vuelven al rotatorio
  upd["tcaes_proposals/" + key + "/status"] = "cancelled";
  upd["tcaes_proposals/" + key + "/undoneAt"] = new Date().toLocaleString("es-ES", { timeZone: "Europe/Madrid" });
  upd["tcaes_proposals/" + key + "/undoneNote"] = "Deshecho a petición de Alberto (prueba aceptada sin querer)";
  await db.ref().update(upd);
  console.log("::notice::Hecho: " + keys.length + " casillas vuelven al rotatorio y la propuesta queda anulada.");
})().then(() => process.exit(0)).catch(e => { console.log("::error::" + (e.message || e)); process.exit(1); });
