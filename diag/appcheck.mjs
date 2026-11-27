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
const KEY = "6LdNVzUuAAAAAM1XL_QcpJ_ip9LPbbaz36DOyvqj";
console.log("execute directo:", await pg.evaluate(async (k) => {
  try { await new Promise(r => grecaptcha.enterprise.ready(r));
        const t = await grecaptcha.enterprise.execute(k, { action: "diag" });
        return "token de " + (t ? t.length : 0) + " caracteres"; }
  catch (e) { return "ERROR: " + String(e && e.message || e); }
}, KEY));
for (const f of pg.frames()) {
  if (/recaptcha\/enterprise\/anchor/.test(f.url())) {
    try { console.log("ANCHOR texto:", (await f.evaluate(() => document.body.innerText)).replace(/\s+/g, " ").slice(0, 300)); } catch (e) { console.log("ANCHOR no legible", String(e).slice(0,100)); }
  }
}
console.log("divs app check:", await pg.evaluate(() => [...document.querySelectorAll("div[id^=fire_app_check]")].map(d => d.id + " en " + (d.parentElement && d.parentElement.tagName) + " visible=" + (d.offsetParent!==null)).join(" | ") || "ninguno"));
console.log("grecaptcha:", await pg.evaluate(() => typeof window.grecaptcha + " enterprise:" + typeof (window.grecaptcha && window.grecaptcha.enterprise)));
await b.close();
