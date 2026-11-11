// Sincroniza la agenda de la app TCE (Alberto y Yoli) con Google Calendar, en un solo sentido: app -> Google.
//   tcaes_agenda                -> calendario compartido   (GCAL_SHARED_ID)
//   tcaes_agenda_priv/alberto   -> calendario de Alberto   (GCAL_ALBERTO_ID)
//   tcaes_agenda_priv/yoli      -> calendario de Yoli      (GCAL_YOLI_ID)
// Cada evento guarda su clave de la app en extendedProperties.private.appKey; así se actualiza o borra sin duplicar.
process.on("uncaughtException", e => { console.log("::error::" + (e.code ? e.code + ": " : "") + String(e.message || e).slice(0, 600)); process.exit(1); });
process.on("unhandledRejection", e => { console.log("::error::" + (e && e.code ? e.code + ": " : "") + String((e && e.message) || e).slice(0, 600)); process.exit(1); });
const { initializeApp, cert, getApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { JWT } = require("google-auth-library");
const crypto = require("crypto");

const TZ = "Europe/Madrid";
const DRY = process.env.DRY_RUN === "1";
const API = "https://www.googleapis.com/calendar/v3/calendars/";

function eventFor(key, e) {
  const d = String(e.d || "");
  if (!/^\d{8}$/.test(d)) return null;
  const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  const ev = {
    summary: String(e.text || "(sin texto)").slice(0, 300),
    description: (e.by ? `Apuntado por ${e.by} · ` : "") + "App TCE 3ºC",
    extendedProperties: { private: { appKey: key } },
  };
  if (/^\d{2}:\d{2}$/.test(e.time || "")) {
    const [h, m] = e.time.split(":").map(Number);
    const end = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), h + 1, m));
    const endStr = end.toISOString().slice(0, 10) + "T" + end.toISOString().slice(11, 16) + ":00";
    ev.start = { dateTime: `${date}T${e.time}:00`, timeZone: TZ };
    ev.end = { dateTime: endStr, timeZone: TZ };   // 1 hora por defecto
  } else {
    const next = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8) + 1));
    ev.start = { date };
    ev.end = { date: next.toISOString().slice(0, 10) };
  }
  ev.extendedProperties.private.appHash = crypto.createHash("sha1")
    .update(JSON.stringify([ev.summary, ev.description, ev.start, ev.end])).digest("hex").slice(0, 16);
  return ev;
}

// Calcula qué crear, actualizar y borrar. Separado para poder probarlo sin Google.
function plan(appItems, gEvents, build = eventFor) {
  const byKey = new Map();
  const dupes = [];
  for (const g of gEvents) {
    const k = g.extendedProperties && g.extendedProperties.private && g.extendedProperties.private.appKey;
    if (!k) continue;                       // eventos creados a mano en Google: no se tocan
    if (byKey.has(k)) dupes.push(g.id); else byKey.set(k, g);
  }
  const create = [], update = [], del = [...dupes];
  for (const [key, e] of Object.entries(appItems || {})) {
    const ev = build(key, e || {});
    if (!ev) continue;
    const g = byKey.get(key);
    if (!g) create.push(ev);
    else {
      if (g.extendedProperties.private.appHash !== ev.extendedProperties.private.appHash) update.push([g.id, ev]);
      byKey.delete(key);
    }
  }
  for (const g of byKey.values()) del.push(g.id);
  return { create, update, del };
}

async function listAppEvents(client, calId, range) {
  const out = []; let pageToken;
  do {
    // Se listan todos los eventos y plan() se queda solo con los que llevan appKey
    const params = new URLSearchParams({ maxResults: "2500", showDeleted: "false", singleEvents: "true" });
    if (range) { params.set("timeMin", range.min); params.set("timeMax", range.max); }
    if (pageToken) params.set("pageToken", pageToken);
    const r = await client.request({ url: API + encodeURIComponent(calId) + "/events?" + params });
    out.push(...(r.data.items || []));
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  return out;
}

async function syncOne(client, name, calId, items, build, range) {
  if (!calId) { console.log(`[${name}] sin calendario configurado, se omite`); return; }
  const g = await listAppEvents(client, calId, range);
  const p = plan(items, g, build);
  console.log(`::notice::[${name}] app ${Object.keys(items || {}).length} · Google ${g.length} → crear ${p.create.length}, actualizar ${p.update.length}, borrar ${p.del.length}`);
  if (DRY) return;
  const base = API + encodeURIComponent(calId) + "/events";
  for (const ev of p.create) await client.request({ url: base, method: "POST", data: ev });
  for (const [id, ev] of p.update) await client.request({ url: base + "/" + id, method: "PUT", data: ev });
  for (const id of p.del) {
    try { await client.request({ url: base + "/" + id, method: "DELETE" }); }
    catch (e) { if (!e.response || ![404, 410].includes(e.response.status)) throw e; }
  }
}


// ===== Turnos de Alberto (fila 4) -> GCAL_TURNOS_ID =====
// El cuadrante (ROTA, PEOPLE, REF_MONDAY) se lee del propio index.html del repo, así nunca se desincroniza de la app.
const fs = require("fs"), path = require("path"), vm = require("vm");
const TURNO_ROW = 4;
const UNIT_NAMES = { I: "Ictus", V: "351-353", N2: "354/337-339", A: "340-345" };
const HORAS = { M: ["08:00", "15:00", 0], T: ["15:00", "22:00", 0], N: ["22:00", "08:00", 1],
                MT: ["08:00", "22:00", 0], TN: ["15:00", "08:00", 1] };
function loadRota() {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const grab = (re) => { const m = html.match(re); if (!m) throw new Error("No encuentro " + re + " en index.html"); return m[0]; };
  const code = grab(/const ROTA = \[[\s\S]*?\n\];/) + "\n" + grab(/const PEOPLE = \[[\s\S]*?\n\];/) + "\n" +
               grab(/const REF_MONDAY=new Date\([^)]*\);/) + "\n;({ROTA,PEOPLE,REF_MONDAY})";
  return vm.runInNewContext(code, {});
}
const pad = (n) => String(n).padStart(2, "0");
function ymd(d) { return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()); }
function turnosItems(overridesRaw, from, days) {
  const { ROTA, PEOPLE, REF_MONDAY } = loadRota();
  const me = PEOPLE[TURNO_ROW - 1];
  const items = {};
  for (let i = 0; i < days; i++) {
    const date = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, 12);
    const dow = (date.getDay() + 6) % 7;
    const mon = new Date(date); mon.setDate(date.getDate() - dow); mon.setHours(0, 0, 0, 0);
    const ref = new Date(REF_MONDAY); ref.setHours(0, 0, 0, 0);
    const off = Math.round((mon - ref) / (7 * 86400000));
    const ri = ((me.startRow - 1 + off) % 15 + 15) % 15;
    const ds = ymd(date);
    let ov = overridesRaw[(TURNO_ROW - 1) + "_" + ds];
    if (ov && typeof ov === "object" && !Array.isArray(ov)) ov = Object.values(ov);
    if (typeof ov === "string") ov = [ov, null];
    const cell = ov !== undefined && ov !== null ? ov : ROTA[ri][dow];
    if (cell && cell[0]) items["t_" + ds] = { d: ds, t: cell[0], u: cell[1] || null, u2: cell[2] || null };
  }
  return items;
}
function turnoEvent(key, x) {
  const d = x.d, date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  const units = [x.u, x.u2].filter(Boolean).map(u => UNIT_NAMES[u] || u);
  let ev;
  if (HORAS[x.t]) {
    const [a, b, plus] = HORAS[x.t];
    const end = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8) + plus));
    ev = { summary: x.t + (units.length ? " · " + units.join(" + ") : ""),
      start: { dateTime: `${date}T${a}:00`, timeZone: TZ }, end: { dateTime: `${end.toISOString().slice(0, 10)}T${b}:00`, timeZone: TZ } };
  } else if (x.t === "V" || x.t === "LD" || x.t === "LDA") {
    const next = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8) + 1));
    const names = { V: "🏖 Vacaciones", LD: "📋 LD", LDA: "📋 LD año pasado" };
    ev = { summary: names[x.t], start: { date }, end: { date: next.toISOString().slice(0, 10) } };
  } else return null;   // L, / y libres: sin evento
  ev.description = "Turno TCE 3ºC";
  ev.extendedProperties = { private: { appKey: key } };
  ev.extendedProperties.private.appHash = crypto.createHash("sha1")
    .update(JSON.stringify([ev.summary, ev.start, ev.end])).digest("hex").slice(0, 16);
  return ev;
}

async function main() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(sa),
    databaseURL: "https://rotatorio-tcaes-default-rtdb.europe-west1.firebasedatabase.app" });
  const db = getDatabase();
  const client = new JWT({ email: sa.client_email, key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/calendar.events"] });
  const [shared, alb, yoli] = await Promise.all([
    db.ref("tcaes_agenda").once("value"),
    db.ref("tcaes_agenda_priv/alberto").once("value"),
    db.ref("tcaes_agenda_priv/yoli").once("value"),
  ]);
  let failed = false;
  if (process.env.GCAL_TURNOS_ID) {
    // Desde el día 1 del mes anterior hasta ~6 meses vista
    const now = new Date(); const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const days = 215;
    const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
    try {
      const ovSnap = await db.ref("rota_changes").once("value");
      const items = turnosItems(ovSnap.val() || {}, from, days);
      await syncOne(client, "Turnos", process.env.GCAL_TURNOS_ID, items, turnoEvent,
        { min: from.toISOString(), max: to.toISOString() });
    } catch (e) {
      failed = true;
      console.log(`::error::[Turnos] ${e.response && e.response.data && e.response.data.error ? e.response.data.error.message : e.message}`);
    }
  }
  for (const [name, id, snap] of [["Compartido", process.env.GCAL_SHARED_ID, shared],
                                   ["Privado Alberto", process.env.GCAL_ALBERTO_ID, alb],
                                   ["Privado Yoli", process.env.GCAL_YOLI_ID, yoli]]) {
    try { await syncOne(client, name, id, snap.val() || {}); }
    catch (e) {
      failed = true;
      const st = e.response && e.response.status;
      console.log(`::error::[${name}] ${st || ""} ${e.response && e.response.data && e.response.data.error ? e.response.data.error.message : e.message}` +
        (st === 404 || st === 403 ? " — ¿está compartido el calendario con " + sa.client_email + " con permiso 'Hacer cambios en eventos'? ¿Está activada la API de Google Calendar?" : ""));
    }
  }
  await getApp().delete();
  if (failed) process.exit(1);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { eventFor, plan, turnosItems, turnoEvent };

