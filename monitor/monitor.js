// Vigilancia de la base de datos (Realtime Database, proyecto rotatorio-tcaes).
// Busca señales de que alguien ha escrito en la base de datos sin pasar por la app.
// Si encuentra algo, termina con error, y GitHub manda un email a quien lanzó la tarea.
//
// IMPORTANTE: el repo es público, así que el registro de la tarea también.
// Este script NUNCA imprime valores de la base de datos: solo el tipo de aviso,
// el nodo y cuántos casos hay.
"use strict";
const crypto = require("crypto");
const { initializeApp, cert } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");

const STATE_PATH = "_monitor/state";

// Nodos raíz que usan las apps (index.html de TCE y Enfermeras, calendar-sync, push-sender)
const KNOWN_ROOTS = [
  "rota_changes", "change_icons", "change_log", "legal_acceptances", "app_suggestions",
  "tcaes_pins", "tcaes_proposals", "tcaes_partner", "tcaes_prefs", "tcaes_agenda",
  "tcaes_agenda_priv", "tcaes_gcal_sync", "tcaes_push_tokens", "tcaes_push_sent",
  "enf_changes", "enf_icons", "enf_log", "enf_pins", "enf_proposals",
  "enf_legal_acceptances", "enf_push_tokens", "enf_push_sent",
  "_monitor",
];

// Filas válidas de PIN: TCE 1..15, Enfermeras 0..18 (0 = acceso de administrador)
const PIN_ROWS = { tcaes_pins: [1, 15], enf_pins: [0, 18] };

// Código HTML o JavaScript dentro de un texto
const INJECTION = /<\/?(script|img|iframe|svg|object|embed|link|style|meta|base|form|input|body|video|audio|math|details|a)\b|javascript\s*:|data\s*:\s*text\/html/i;
const HANDLER = /<[a-z][^>]*[\s\/]on[a-z]+\s*=/i;
// Caracteres que la app nunca usa en las claves
const BAD_KEY = /[<>"'`&;(){}\\\s]/;
const MAX_STRING = 5000;      // un apunte o comentario normal es mucho más corto
const MASS_DELETE_MIN = 20;   // se avisa si desaparecen al menos 20 datos...
const MASS_DELETE_PCT = 0.3;  // ...y además son más del 30 % del nodo
const MASS_GROWTH = 500;      // o si aparecen más de 500 datos de golpe en un nodo

function short(path) {
  // Muestra como mucho 2 niveles de la ruta (sin valores)
  return path.split("/").slice(0, 2).join("/");
}

function walk(node, path, visit) {
  if (node !== null && typeof node === "object") {
    for (const k of Object.keys(node)) {
      visit.key(k, path ? path + "/" + k : k);
      walk(node[k], path ? path + "/" + k : k, visit);
    }
  } else {
    visit.leaf(node, path);
  }
}

function countLeaves(node) {
  if (node === null || typeof node !== "object") return 1;
  let n = 0;
  for (const k of Object.keys(node)) n += countLeaves(node[k]);
  return n;
}

async function main() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({
    credential: cert(sa),
    databaseURL: "https://rotatorio-tcaes-default-rtdb.europe-west1.firebasedatabase.app",
  });
  const db = getDatabase();
  const hmac = (s) => crypto.createHmac("sha256", sa.private_key).update(String(s)).digest("hex").slice(0, 16);

  const root = (await db.ref("/").once("value")).val() || {};
  const prev = root._monitor && root._monitor.state ? root._monitor.state : null;
  delete root._monitor;

  const alerts = {};   // categoría -> Set(rutas cortas)
  const add = (cat, path) => { (alerts[cat] = alerts[cat] || new Map()).set(short(path), ((alerts[cat] && alerts[cat].get(short(path))) || 0) + 1); };

  // 1) Texto con código o claves con caracteres raros
  walk(root, "", {
    key(k, path) { if (BAD_KEY.test(k) || INJECTION.test(k)) add("Clave con caracteres raros", path); },
    leaf(v, path) {
      if (typeof v !== "string") return;
      if (INJECTION.test(v) || HANDLER.test(v)) add("Texto con código HTML/JS", path);
      if (v.length > MAX_STRING) add("Texto anormalmente largo", path);
    },
  });

  // 2) Nodos raíz que la app no conoce (o que no estaban la vez anterior)
  const roots = Object.keys(root).sort();
  const knownBefore = new Set([...(prev && prev.roots ? prev.roots : []), ...KNOWN_ROOTS]);
  for (const r of roots) if (!knownBefore.has(r)) add("Nodo raíz desconocido", r);

  // 3) PINs con formato o fila imposibles; cambios de PIN (solo informativo)
  const pinHashes = {};
  for (const [node, [lo, hi]] of Object.entries(PIN_ROWS)) {
    const pins = root[node] || {};
    for (const [row, pin] of Object.entries(pins)) {
      const r = Number(row);
      if (!Number.isInteger(r) || r < lo || r > hi) add("PIN en una fila que no existe", node + "/" + row);
      if (pin !== null && !/^\d{4}$/.test(String(pin))) add("PIN con formato no válido", node + "/" + row);
      pinHashes[node + ":" + row] = hmac(pin);
    }
  }
  const partnerPin = root.tcaes_partner && root.tcaes_partner.pin;
  if (partnerPin != null) {
    if (!/^\d{4}$/.test(String(partnerPin))) add("PIN con formato no válido", "tcaes_partner/pin");
    pinHashes["tcaes_partner:pin"] = hmac(partnerPin);
  }
  let pinChanges = 0;
  if (prev && prev.pins) {
    for (const k of new Set([...Object.keys(prev.pins), ...Object.keys(pinHashes)])) {
      if (prev.pins[k] !== pinHashes[k]) pinChanges++;
    }
  }

  // 4) Borrados o altas masivas por nodo
  const counts = {};
  for (const r of roots) counts[r] = countLeaves(root[r]);
  if (prev && prev.counts) {
    for (const r of new Set([...Object.keys(prev.counts), ...roots])) {
      const before = prev.counts[r] || 0, now = counts[r] || 0;
      if (before - now >= MASS_DELETE_MIN && (before - now) / before >= MASS_DELETE_PCT) add("Borrado masivo", r);
      if (now - before >= MASS_GROWTH) add("Alta masiva de datos", r);
    }
  }

  // Guardar el estado para la próxima vez (sin datos personales: recuentos y huellas de PIN)
  const bytes = Buffer.byteLength(JSON.stringify(root));
  await db.ref(STATE_PATH).set({
    at: new Date().toISOString(),
    roots: [...new Set([...roots, ...(prev && prev.roots ? prev.roots : [])])].sort(),
    counts, pins: pinHashes,
  });

  // Resumen público (sin valores)
  console.log(`Nodos raíz: ${roots.length} · datos: ${Object.values(counts).reduce((a, b) => a + b, 0)} · tamaño: ${(bytes / 1024).toFixed(0)} KB`);
  if (!prev) console.log("Primera ejecución: se guarda el estado de referencia. Nodos raíz: " + roots.join(", "));
  if (pinChanges) console.log(`ℹ️ PINs cambiados desde la última revisión: ${pinChanges}`);

  const cats = Object.keys(alerts);
  if (!cats.length) { console.log("✅ Sin señales raras."); return; }
  for (const c of cats) {
    const list = [...alerts[c].entries()].map(([p, n]) => n > 1 ? `${p} (×${n})` : p);
    console.log(`::error title=${c}::${list.slice(0, 15).join(", ")}${list.length > 15 ? " …" : ""}`);
  }
  process.exitCode = 1;
}

main().catch((e) => { console.log("::error title=Fallo de la vigilancia::" + (e && e.message ? e.message.split("\n")[0] : e)); process.exitCode = 1; })
  .finally(() => setTimeout(() => process.exit(), 500));
