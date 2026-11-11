// Envía notificaciones push de propuestas de cambio (TCE y Enfermeras).
// Lo ejecuta GitHub Actions cada 5 minutos con el secret FIREBASE_SERVICE_ACCOUNT.
// Guarda en <prefijo>_push_sent/{clave} el último estado ya avisado para no repetir.
const admin = require("firebase-admin");

const APPS = [
  { name: "TCE", proposals: "tcaes_proposals", tokens: "tcaes_push_tokens", sent: "tcaes_push_sent" },
  { name: "Enfermeras", proposals: "enf_proposals", tokens: "enf_push_tokens", sent: "enf_push_sent" },
];

let sa;
try { sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); }
catch (e) { console.log("::error::El secret FIREBASE_SERVICE_ACCOUNT no es un JSON válido (" + e.message + "). Vuelve a pegar el contenido entero del archivo .json."); process.exit(1); }
for (const k of ["project_id", "client_email", "private_key"]) if (!sa[k]) { console.log("::error::Al secret le falta el campo " + k + ". ¿Es el .json de 'Cuentas de servicio'?"); process.exit(1); }
console.log("Cuenta de servicio:", sa.client_email, "· proyecto:", sa.project_id);
admin.initializeApp({
  credential: admin.credential.cert(sa),
  databaseURL: "https://rotatorio-tcaes-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const DRY = process.env.DRY_RUN === "1";

function fmtDay(k) {
  const m = String(k || "").match(/(\d{4})(\d{2})(\d{2})/);
  return m ? `${+m[3]}/${+m[2]}` : String(k || "?");
}

function messageFor(p, status, prevStatus) {
  const tu = p.toTurn ? ` (${p.toTurn})` : "";
  const su = p.fromTurn ? ` (${p.fromTurn})` : "";
  if (status === "pending")
    return { row: p.to, title: `🔄 ${p.fromName} te propone un cambio`,
      body: `Su ${fmtDay(p.fromDay)}${su} por tu ${fmtDay(p.toDay)}${tu}` };
  if (status === "accepted")
    return { row: p.from, title: `✅ ${p.toName} aceptó tu cambio`,
      body: `Tu ${fmtDay(p.fromDay)} por su ${fmtDay(p.toDay)}` };
  if (status === "rejected")
    return { row: p.from, title: `❌ ${p.toName} rechazó tu cambio`,
      body: `Tu ${fmtDay(p.fromDay)} por su ${fmtDay(p.toDay)}` };
  if (status === "cancelled" && prevStatus === "pending")
    return { row: p.to, title: `🚫 ${p.fromName} canceló su propuesta`,
      body: `Su ${fmtDay(p.fromDay)} por tu ${fmtDay(p.toDay)}` };
  return null;
}

async function runApp(app) {
  const [propsSnap, sentSnap] = await Promise.all([
    db.ref(app.proposals).once("value"), db.ref(app.sent).once("value")]);
  const props = propsSnap.val() || {};
  const sent = sentSnap.val();
  const updates = {};

  // Primera ejecución: se marca todo lo existente como ya avisado, sin enviar nada.
  if (sent === null) {
    for (const [k, p] of Object.entries(props)) updates[k] = (p && p.status) || "pending";
    updates._init = Date.now();
    if (!DRY) await db.ref(app.sent).update(updates);
    console.log(`[${app.name}] inicializado con ${Object.keys(props).length} propuestas, sin avisos`);
    return;
  }

  let n = 0;
  for (const [key, p] of Object.entries(props)) {
    if (!p || !p.status || sent[key] === p.status) continue;
    const msg = messageFor(p, p.status, sent[key]);
    updates[key] = p.status;
    if (!msg || !msg.row) continue;
    const tokSnap = await db.ref(`${app.tokens}/${msg.row}`).once("value");
    const tokens = Object.keys(tokSnap.val() || {});
    if (!tokens.length) { console.log(`[${app.name}] ${key}: fila ${msg.row} sin app instalada`); continue; }
    console.log(`[${app.name}] ${key}: ${p.status} → fila ${msg.row} (${tokens.length} disp.)`);
    if (DRY) continue;
    const res = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title: msg.title, body: msg.body },
      android: { priority: "high" },
    });
    n += res.successCount;
    res.responses.forEach((r, i) => {
      const code = r.error && r.error.code;
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
        db.ref(`${app.tokens}/${msg.row}/${tokens[i]}`).remove();
        console.log(`  token caducado eliminado`);
      } else if (r.error) console.log(`  error: ${code}`);
    });
  }
  if (Object.keys(updates).length && !DRY) await db.ref(app.sent).update(updates);
  console.log(`[${app.name}] ${Object.keys(updates).length} cambios de estado, ${n} avisos enviados`);
}

(async () => {
  for (const app of APPS) await runApp(app);
  await admin.app().delete();
})().catch(e => { console.log("::error::" + (e.code ? e.code + ": " : "") + String(e.message || e).slice(0, 500)); process.exit(1); });
