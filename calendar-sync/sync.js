// Sincroniza la agenda de la app TCE (Alberto y Yoli) con Google Calendar, en un solo sentido: app -> Google.
//   tcaes_agenda                -> calendario compartido   (GCAL_SHARED_ID)
//   tcaes_agenda_priv/alberto   -> calendario de Alberto   (GCAL_ALBERTO_ID)
//   tcaes_agenda_priv/yoli      -> calendario de Yoli      (GCAL_YOLI_ID)
// Cada evento guarda su clave de la app en extendedProperties.private.appKey; así se actualiza o borra sin duplicar.
process.on("uncaughtException", e => { console.log("::error::" + (e.code ? e.code + ": " : "") + String(e.message || e).slice(0, 600)); process.exit(1); });
process.on("unhandledRejection", e => { console.log("::error::" + (e && e.code ? e.code + ": " : "") + String((e && e.message) || e).slice(0, 600)); process.exit(1); });
const admin = require("firebase-admin");
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
function plan(appItems, gEvents) {
  const byKey = new Map();
  const dupes = [];
  for (const g of gEvents) {
    const k = g.extendedProperties && g.extendedProperties.private && g.extendedProperties.private.appKey;
    if (!k) continue;                       // eventos creados a mano en Google: no se tocan
    if (byKey.has(k)) dupes.push(g.id); else byKey.set(k, g);
  }
  const create = [], update = [], del = [...dupes];
  for (const [key, e] of Object.entries(appItems || {})) {
    const ev = eventFor(key, e || {});
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

async function listAppEvents(client, calId) {
  const out = []; let pageToken;
  do {
    // Se listan todos los eventos y plan() se queda solo con los que llevan appKey
    const params = new URLSearchParams({ maxResults: "2500", showDeleted: "false", singleEvents: "true" });
    if (pageToken) params.set("pageToken", pageToken);
    const r = await client.request({ url: API + encodeURIComponent(calId) + "/events?" + params });
    out.push(...(r.data.items || []));
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  return out;
}

async function syncOne(client, name, calId, items) {
  if (!calId) { console.log(`[${name}] sin calendario configurado, se omite`); return; }
  const g = await listAppEvents(client, calId);
  const p = plan(items, g);
  console.log(`[${name}] app ${Object.keys(items || {}).length} · Google ${g.length} → crear ${p.create.length}, actualizar ${p.update.length}, borrar ${p.del.length}`);
  if (DRY) return;
  const base = API + encodeURIComponent(calId) + "/events";
  for (const ev of p.create) await client.request({ url: base, method: "POST", data: ev });
  for (const [id, ev] of p.update) await client.request({ url: base + "/" + id, method: "PUT", data: ev });
  for (const id of p.del) {
    try { await client.request({ url: base + "/" + id, method: "DELETE" }); }
    catch (e) { if (!e.response || ![404, 410].includes(e.response.status)) throw e; }
  }
}

async function main() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(sa),
    databaseURL: "https://rotatorio-tcaes-default-rtdb.europe-west1.firebasedatabase.app" });
  const db = admin.database();
  const client = new JWT({ email: sa.client_email, key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/calendar.events"] });
  const [shared, alb, yoli] = await Promise.all([
    db.ref("tcaes_agenda").once("value"),
    db.ref("tcaes_agenda_priv/alberto").once("value"),
    db.ref("tcaes_agenda_priv/yoli").once("value"),
  ]);
  let failed = false;
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
  await admin.app().delete();
  if (failed) process.exit(1);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { eventFor, plan };
