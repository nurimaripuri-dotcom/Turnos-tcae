// Sincroniza la agenda de la app TCE (Alberto y Yoli) con Google Calendar EN LOS DOS SENTIDOS
// (los turnos, en cambio, van solo app -> Google).
//   tcaes_agenda                -> calendario compartido   (GCAL_SHARED_ID)
//   tcaes_agenda_priv/alberto   -> calendario de Alberto   (GCAL_ALBERTO_ID)
//   tcaes_agenda_priv/yoli      -> calendario de Yoli      (GCAL_YOLI_ID)
// Cada evento guarda su clave de la app en extendedProperties.private.appKey; así se actualiza o borra sin duplicar.
// Doble sentido: lo último sincronizado se guarda en Firebase (tcaes_gcal_sync/{cal}/{appKey} = {gid, gu}) para saber
// qué se ha borrado o editado en cada lado desde la vez anterior. Los eventos creados a mano en Google se importan a la app.
process.on("uncaughtException", e => { console.log("::error::" + (e.code ? e.code + ": " : "") + String(e.message || e).slice(0, 600)); process.exit(1); });
process.on("unhandledRejection", e => { console.log("::error::" + (e && e.code ? e.code + ": " : "") + String((e && e.message) || e).slice(0, 600)); process.exit(1); });
const { initializeApp, cert, getApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { JWT } = require("google-auth-library");
const crypto = require("crypto");

const TZ = "Europe/Madrid";
const DRY = process.env.DRY_RUN === "1";
const API = "https://www.googleapis.com/calendar/v3/calendars/";

// Apuntes repetidos: rep = "w" (cada semana) | "m" (cada mes) | "y" (cada año)
const REP_RRULE = { w: "RRULE:FREQ=WEEKLY", m: "RRULE:FREQ=MONTHLY", y: "RRULE:FREQ=YEARLY" };
// Regla de Google -> rep ("" si no se repite; null si es una repetición compleja que no se importa)
function repFromRecurrence(rec) {
  if (!rec || !rec.length) return "";
  if (rec.length !== 1 || !/^RRULE:/.test(rec[0])) return null;
  const parts = Object.fromEntries(rec[0].slice(6).split(";").map(x => x.split("=")));
  for (const k of Object.keys(parts)) {
    if (k === "FREQ" || k === "WKST" || (k === "INTERVAL" && parts[k] === "1")) continue;
    if (k === "BYDAY" && parts.FREQ === "WEEKLY" && !parts.BYDAY.includes(",")) continue;
    if ((k === "BYMONTHDAY" && parts.FREQ !== "WEEKLY") || (k === "BYMONTH" && parts.FREQ === "YEARLY")) continue;
    return null;
  }
  return { WEEKLY: "w", MONTHLY: "m", YEARLY: "y" }[parts.FREQ] || null;
}
const itemHash = (a) => crypto.createHash("sha1").update(JSON.stringify([a.d || "", a.time || "", a.text || "", a.rep || ""])).digest("hex").slice(0, 16);

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
  if (REP_RRULE[e.rep]) ev.recurrence = [REP_RRULE[e.rep]];
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

async function listAppEvents(client, calId, range, tz) {
  const out = []; let pageToken;
  do {
    // Se listan todos los eventos y plan() se queda solo con los que llevan appKey
    const params = new URLSearchParams({ maxResults: "2500", showDeleted: "false", singleEvents: range === "masters" ? "false" : "true" });
    if (range === "masters") range = null;   // agenda: eventos "madre" (los repetidos vienen una sola vez, con su regla)
    if (range) { params.set("timeMin", range.min); params.set("timeMax", range.max); }
    if (tz) params.set("timeZone", tz);
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


// ===== Turnos de Alberto (fila 4) -> GCAL_TURNOS_ID (calendario "Turnos Alberto") =====
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
  } else if (["V", "LD", "LDA", "L", "/"].includes(x.t)) {
    const next = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8) + 1));
    const names = { V: "🏖 Vacaciones", LD: "📋 LD", LDA: "📋 LD año pasado", L: "L · Libre", "/": "/ · Saliente" };
    ev = { summary: names[x.t], start: { date }, end: { date: next.toISOString().slice(0, 10) } };
  } else return null;
  ev.description = "Turno TCE 3ºC";
  ev.extendedProperties = { private: { appKey: key } };
  ev.extendedProperties.private.appHash = crypto.createHash("sha1")
    .update(JSON.stringify([ev.summary, ev.start, ev.end])).digest("hex").slice(0, 16);
  return ev;
}

// ===== Agenda en doble sentido =====
const WIN_PAST_DAYS = 60, WIN_FUTURE_DAYS = 400, MAX_APP_DELETES = 15;
const ymdOf = (iso) => iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10);
function inWindow(d, minD, maxD) { return d >= minD && d <= maxD; }
// Evento de Google -> apunte de la app (solo el día de inicio; hora de inicio si la tiene)
function appItemFromGoogle(g, prev) {
  const st = g.start || {};
  let d, time = "";
  if (st.date) d = ymdOf(st.date);
  else if (st.dateTime) { d = ymdOf(st.dateTime); time = st.dateTime.slice(11, 16); }
  else return null;
  const rep = repFromRecurrence(g.recurrence);
  if (rep === null) return null;                                   // repetición compleja: no se importa
  const item = Object.assign({}, prev || {}, { d, time, text: String(g.summary || "(sin texto)").slice(0, 300) });
  if (rep) item.rep = rep; else delete item.rep;
  if (!prev) { item.ts = Date.now(); item.src = "google"; }
  return item;
}
const gKey = (gid) => "g_" + crypto.createHash("sha1").update(gid).digest("hex").slice(0, 16);

// Decide qué hacer en cada lado. Puro (sin red) para poder probarlo.
//   app: {key: item}   gEvents: eventos de Google (ya filtrados a la ventana)   state: {key: {gid, gu}}
function planTwoWay(app, gEvents, state, minD, maxD) {
  const out = { gCreate: [], gUpdate: [], gDelete: [], gAdopt: [], appSet: {}, appDel: [], stateSet: {}, stateDel: [] };
  const gByKey = new Map(), unmanaged = [];
  for (const g of gEvents) {
    if (g.recurringEventId) continue;                              // excepciones sueltas de una serie: no se tocan
    const k = g.extendedProperties && g.extendedProperties.private && g.extendedProperties.private.appKey;
    if (!k) { unmanaged.push(g); continue; }
    if (gByKey.has(k)) out.gDelete.push(g.id); else gByKey.set(k, g);
  }
  // 1) Eventos nuevos creados a mano en Google -> a la app
  for (const g of unmanaged) {
    const item = appItemFromGoogle(g, null);
    if (!item) continue;
    if (!item.rep && !inWindow(item.d, minD, maxD)) continue;     // antiguos o muy lejanos: no se importan
    const key = gKey(g.id);
    out.appSet[key] = item;
    out.gAdopt.push([g.id, key, itemHash(item)]);                                  // se le pone appKey para reconocerlo en adelante
  }
  // 2) Emparejados por clave
  const keys = new Set([...Object.keys(app || {}), ...gByKey.keys(), ...Object.keys(state || {})]);
  for (const key of keys) {
    const a = app[key], g = gByKey.get(key), s = state[key];
    const aIn = a && (a.rep ? String(a.d || "") <= maxD : inWindow(String(a.d || ""), minD, maxD));
    if (a && !aIn) continue;                                       // fuera de la ventana: no se toca
    if (aIn && !g) {
      if (s) { out.appDel.push(key); out.stateDel.push(key); }     // se borró en Google
      else out.gCreate.push(key);                                  // nuevo en la app
    } else if (!a && g) {
      out.gDelete.push(g.id);                                      // se borró en la app (o resto antiguo)
      if (s) out.stateDel.push(key);
    } else if (aIn && g) {
      const gChanged = s && s.gu !== g.updated;
      const aChanged = s && s.ah && s.ah !== itemHash(a);
      if (!s) out.gUpdate.push(key);                               // primera vez: manda la app (como antes)
      else if (aChanged && (!gChanged || (a.upd || 0) >= Date.parse(g.updated || 0))) {
        out.gUpdate.push(key);                                     // editado en la app (o en los dos y la app es más reciente)
      } else if (gChanged) {                                       // editado en Google -> a la app
        const item = appItemFromGoogle(g, a);
        if (item) { out.appSet[key] = item; out.stateSet[key] = { gid: g.id, gu: g.updated, ah: itemHash(item) }; }
        else out.stateSet[key] = { gid: g.id, gu: g.updated, ah: s.ah || itemHash(a) };
      } else if (!s.ah) out.stateSet[key] = { gid: g.id, gu: g.updated, ah: itemHash(a) };   // estado antiguo: se completa
    } else if (!a && !g && s) {
      // Desapareció de los dos lados, o el apunte está fuera de la ventana: solo se limpia si ya no existe en la app
      if (!app[key]) out.stateDel.push(key);
    }
  }
  return out;
}

async function syncTwoWay(client, db, name, calId, appPath, stateKey) {
  if (!calId) { console.log(`[${name}] sin calendario configurado, se omite`); return; }
  const now = new Date();
  const min = new Date(now.getTime() - WIN_PAST_DAYS * 86400000), max = new Date(now.getTime() + WIN_FUTURE_DAYS * 86400000);
  const minD = ymd(min), maxD = ymd(max);
  const [appSnap, stSnap] = await Promise.all([db.ref(appPath).once("value"), db.ref("tcaes_gcal_sync/" + stateKey).once("value")]);
  const app = appSnap.val() || {}, state = stSnap.val() || {};
  const gAll = await listAppEvents(client, calId, "masters", TZ);
  const p = planTwoWay(app, gAll, state, minD, maxD);
  console.log(`::notice::[${name}] app ${Object.keys(app).length} · Google ${gAll.length} → Google: crear ${p.gCreate.length}, actualizar ${p.gUpdate.length}, borrar ${p.gDelete.length} · App: nuevos/cambiados ${Object.keys(p.appSet).length}, borrar ${p.appDel.length}`);
  if (p.appDel.length > MAX_APP_DELETES) {
    throw new Error(`se iban a borrar ${p.appDel.length} apuntes de la app de golpe; se para por seguridad (revisar el calendario)`);
  }
  if (DRY) return;
  const base = API + encodeURIComponent(calId) + "/events";
  const st = {};                                                   // cambios de estado a escribir
  for (const key of p.gCreate) {
    const ev = eventFor(key, app[key]); if (!ev) continue;
    const r = await client.request({ url: base, method: "POST", data: ev });
    st[key] = { gid: r.data.id, gu: r.data.updated, ah: itemHash(app[key]) };
  }
  for (const key of p.gUpdate) {
    const ev = eventFor(key, app[key]); if (!ev) continue;
    const g = gAll.find(x => x.extendedProperties && x.extendedProperties.private && x.extendedProperties.private.appKey === key);
    const r = await client.request({ url: base + "/" + g.id, method: "PUT", data: ev });
    st[key] = { gid: r.data.id, gu: r.data.updated, ah: itemHash(app[key]) };
  }
  for (const [gid, key, ah] of p.gAdopt) {
    const r = await client.request({ url: base + "/" + gid, method: "PATCH",
      data: { extendedProperties: { private: { appKey: key } } } });
    st[key] = { gid, gu: r.data.updated, ah };
  }
  for (const id of p.gDelete) {
    try { await client.request({ url: base + "/" + id, method: "DELETE" }); }
    catch (e) { if (!e.response || ![404, 410].includes(e.response.status)) throw e; }
  }
  const upd = {};
  for (const [k, v] of Object.entries(p.appSet)) upd[appPath + "/" + k] = v;
  for (const k of p.appDel) upd[appPath + "/" + k] = null;
  for (const [k, v] of Object.entries(Object.assign({}, p.stateSet, st))) upd["tcaes_gcal_sync/" + stateKey + "/" + k] = v;
  for (const k of p.stateDel) if (!st[k]) upd["tcaes_gcal_sync/" + stateKey + "/" + k] = null;
  if (Object.keys(upd).length) await db.ref().update(upd);
}

async function main() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(sa),
    databaseURL: "https://rotatorio-tcaes-default-rtdb.europe-west1.firebasedatabase.app" });
  const db = getDatabase();
  const client = new JWT({ email: sa.client_email, key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/calendar.events"] });
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
  for (const [name, id, path, stKey] of [["Compartido", process.env.GCAL_SHARED_ID, "tcaes_agenda", "shared"],
                                         ["Privado Alberto", process.env.GCAL_ALBERTO_ID, "tcaes_agenda_priv/alberto", "alberto"],
                                         ["Privado Yoli", process.env.GCAL_YOLI_ID, "tcaes_agenda_priv/yoli", "yoli"]]) {
    try { await syncTwoWay(client, db, name, id, path, stKey); }
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
module.exports = { eventFor, plan, planTwoWay, appItemFromGoogle, gKey, itemHash, repFromRecurrence, turnosItems, turnoEvent };

