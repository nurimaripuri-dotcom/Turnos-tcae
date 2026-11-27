// Diagnóstico de App Check: abre la web real y registra qué pasa con reCAPTCHA y App Check.
// Solo imprime URLs (sin parámetros), códigos HTTP y mensajes de error. Nada de datos.
import { chromium } from "playwright";
const url = process.argv[2];
const b = await chromium.launch();
const pg = await b.newPage();
const clean = (u) => u.replace(/([?&](k|key|token)=)[^&]+/g, "$1…");
pg.on("console", (m) => { const t = m.text(); if (/appcheck|recaptcha|app check|firebase/i.test(t)) console.log("CONSOLE", m.type(), t.slice(0, 400)); });
pg.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 300)));
pg.on("requestfailed", (r) => { if (/recaptcha|appcheck|gstatic/.test(r.url())) console.log("FALLA", clean(r.url()).slice(0, 160), r.failure()?.errorText); });
pg.on("response", async (r) => {
  const u = r.url();
  if (/recaptcha|firebaseappcheck|app-check/.test(u)) {
    let extra = "";
    if (/firebaseappcheck/.test(u) && r.status() >= 400) { try { extra = (await r.text()).slice(0, 400); } catch {} }
    console.log("RESP", r.status(), r.request().method(), clean(u).split("#")[0].slice(0, 160), extra);
  }
});
await pg.goto(url, { waitUntil: "load" });
await pg.waitForTimeout(15000);
console.log("grecaptcha:", await pg.evaluate(() => typeof window.grecaptcha + " enterprise:" + typeof (window.grecaptcha && window.grecaptcha.enterprise)));
await b.close();
