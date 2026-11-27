// Pruebas automáticas del rotatorio de las dos apps (TCE y Enfermeras).
// Se ejecutan con:  node --test tests/
// Variables de entorno: TCE_HTML y ENF_HTML (rutas a los index.html). Por defecto ./index.html y ../Turnos-enfermeras/index.html
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const TCE_HTML = process.env.TCE_HTML || path.join(__dirname, "..", "index.html");
const ENF_HTML = process.env.ENF_HTML || path.join(__dirname, "..", "..", "Turnos-enfermeras", "index.html");
const tceSrc = fs.readFileSync(TCE_HTML, "utf8");
const enfSrc = fs.readFileSync(ENF_HTML, "utf8");

// Saca del HTML el valor de "const NOMBRE = ..." (array, objeto o new Date(...)) sin ejecutar la app
function grab(src, name) {
  const m = new RegExp("const\\s+" + name + "\\s*=\\s*").exec(src);
  if (!m) throw new Error("No encuentro const " + name);
  const i = m.index + m[0].length;
  let j;
  if (src.startsWith("new Date", i)) j = src.indexOf(";", i) - 1;
  else {
    let d = 0;
    for (j = i; j < src.length; j++) {
      const c = src[j];
      if (c === "[" || c === "{") d++;
      else if (c === "]" || c === "}") { d--; if (d === 0) break; }
    }
  }
  const v = vm.runInNewContext("(" + src.slice(i, j + 1) + ")");
  // Pasar a objetos "normales" (los de vm son de otro contexto y deepEqual los vería distintos)
  return src.startsWith("new Date", i) ? new Date(v.getTime()) : JSON.parse(JSON.stringify(v));
}
// Saca una función "function nombre(...){...}" de una línea y la devuelve ejecutable con las constantes dadas
function grabFn(src, name, ctx) {
  const m = new RegExp("function\\s+" + name + "\\s*\\([^)]*\\)\\{[^\\n]*\\}").exec(src);
  if (!m) throw new Error("No encuentro function " + name);
  const sandbox = { ...ctx };
  vm.runInNewContext(m[0] + "; this." + name + "=" + name + ";", sandbox);
  return sandbox[name];
}
const sameDate = (a, b) => a.getTime() === b.getTime();

const APPS = {
  TCE: { src: tceSrc, ROTA: grab(tceSrc, "ROTA"), PEOPLE: grab(tceSrc, "PEOPLE"), REF: grab(tceSrc, "REF_MONDAY"), N: 15, refName: "REF_MONDAY" },
  ENF: { src: enfSrc, ROTA: grab(enfSrc, "ROTA_ENF"), PEOPLE: grab(enfSrc, "PEOPLE_ENF"), REF: grab(enfSrc, "REF_MONDAY_ENF"), N: 18, refName: "REF_MONDAY_ENF" },
};
const SHIFTS = { TCE: ["M", "T", "N", "L", "/", "MT", "TN"], ENF: ["D", "M", "N", "L", "/"] };
const UNITS = ["I", "V", "N2", "A", null];

// ---------- 1. Las copias cruzadas coinciden con el original ----------
test("Copia de TCE dentro de Enfermeras = original de TCE", () => {
  assert.deepEqual(grab(enfSrc, "ROTA_TCE"), APPS.TCE.ROTA, "ROTA_TCE desactualizado en Turnos-enfermeras");
  assert.deepEqual(grab(enfSrc, "PEOPLE_TCE"), APPS.TCE.PEOPLE, "PEOPLE_TCE desactualizado en Turnos-enfermeras");
  assert.ok(sameDate(grab(enfSrc, "REF_MONDAY_TCE"), APPS.TCE.REF), "REF_MONDAY_TCE distinto");
});
test("Copia de Enfermeras dentro de TCE = original de Enfermeras", () => {
  assert.deepEqual(grab(tceSrc, "ROTA_ENF"), APPS.ENF.ROTA, "ROTA_ENF desactualizado en Turnos-tcae");
  assert.deepEqual(grab(tceSrc, "PEOPLE_ENF"), APPS.ENF.PEOPLE, "PEOPLE_ENF desactualizado en Turnos-tcae");
  assert.ok(sameDate(grab(tceSrc, "REF_MONDAY_ENF"), APPS.ENF.REF), "REF_MONDAY_ENF distinto");
});

for (const [app, A] of Object.entries(APPS)) {
  // ---------- 2. Forma del rotatorio ----------
  test(`${app}: el rotatorio tiene ${A.N} semanas de 7 días con turnos y unidades válidos`, () => {
    assert.equal(A.ROTA.length, A.N);
    A.ROTA.forEach((row, i) => {
      assert.equal(row.length, 7, `fila ${i + 1} no tiene 7 días`);
      row.forEach((c, d) => {
        assert.ok(SHIFTS[app].includes(c[0]), `fila ${i + 1}, día ${d + 1}: turno desconocido "${c[0]}"`);
        c.slice(1).forEach((u) => assert.ok(UNITS.includes(u), `fila ${i + 1}, día ${d + 1}: unidad desconocida "${u}"`));
      });
    });
  });

  // ---------- 3. Personas ----------
  test(`${app}: cada persona empieza en una fila distinta y están todas las filas`, () => {
    assert.equal(A.PEOPLE.length, A.N);
    const rows = A.PEOPLE.map((p) => p.startRow).sort((a, b) => a - b);
    assert.deepEqual(rows, Array.from({ length: A.N }, (_, i) => i + 1));
    const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
    const names = A.PEOPLE.map((p) => norm(p.name));
    assert.equal(new Set(names).size, names.length, "hay nombres repetidos (sin tildes ni mayúsculas)");
  });

  // ---------- 4. Cálculo de semanas (con la función real de la app) ----------
  test(`${app}: cada semana de 2025 a 2031 a cada persona le toca una fila distinta`, () => {
    const ctx = { [A.refName]: A.REF };
    const weekOff = grabFn(A.src, "weekOff", ctx);
    const rowFor = grabFn(A.src, "rowFor", { ...ctx, weekOff });
    const mondayOf = grabFn(A.src, "mondayOf", {});
    for (let d = new Date(2025, 0, 6); d < new Date(2032, 0, 1); d.setDate(d.getDate() + 7)) {
      const mon = mondayOf(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 13, 30)); // hora cualquiera
      const rows = A.PEOPLE.map((p) => rowFor(p.startRow, mon));
      assert.equal(new Set(rows).size, A.N, `semana del ${mon.toDateString()}: dos personas en la misma fila`);
      rows.forEach((r) => assert.ok(r >= 0 && r < A.N));
    }
    // La semana de referencia es la fila de inicio de cada uno
    A.PEOPLE.forEach((p) => assert.equal(rowFor(p.startRow, A.REF), p.startRow - 1));
    // Una semana después, todos avanzan una fila
    const next = new Date(A.REF); next.setDate(next.getDate() + 7);
    A.PEOPLE.forEach((p) => assert.equal(rowFor(p.startRow, next), p.startRow % A.N));
  });

  test(`${app}: mondayOf devuelve el lunes de cualquier día (también en cambios de hora)`, () => {
    const mondayOf = grabFn(A.src, "mondayOf", {});
    for (const [y, m, d] of [[2026, 2, 29], [2026, 9, 25], [2027, 2, 28], [2027, 0, 1], [2026, 11, 31]]) {
      for (let k = 0; k < 7; k++) {
        const day = new Date(y, m, d + k, 0, 30);
        const mon = mondayOf(day);
        assert.equal(mon.getDay(), 1, `${day.toDateString()} → ${mon.toDateString()} no es lunes`);
        assert.ok(day - mon >= 0 && day - mon < 7 * 86400000 + 3600000);
      }
    }
  });

  // ---------- 5. Descanso tras la noche ----------
  test(`${app}: después de una noche siempre hay saliente o libre (también entre semanas)`, () => {
    for (let i = 0; i < A.N; i++) for (let d = 0; d < 7; d++) {
      const c = A.ROTA[i][d][0];
      if (!c.includes("N")) continue;
      const next = d < 6 ? A.ROTA[i][d + 1] : A.ROTA[(i + 1) % A.N][0];
      assert.ok(["/", "L"].includes(next[0]), `fila ${i + 1}, día ${d + 1}: ${c} seguido de ${next[0]}`);
    }
  });
}

// ---------- 6. Turnos de referencia del cuadrante de papel ----------
// tests/referencia.json: [{"app":"TCE","nombre":"Alberto","fecha":"2027-01-15","turno":"T","unidad":"I"}, ...]
const refFile = path.join(__dirname, "referencia.json");
const refs = fs.existsSync(refFile) ? JSON.parse(fs.readFileSync(refFile, "utf8")) : [];
test(`Turnos de referencia del cuadrante de papel (${refs.length})`, { skip: refs.length ? false : "aún no hay turnos de referencia" }, () => {
  for (const r of refs) {
    const A = APPS[r.app];
    const ctx = { [A.refName]: A.REF };
    const weekOff = grabFn(A.src, "weekOff", ctx);
    const rowFor = grabFn(A.src, "rowFor", { ...ctx, weekOff });
    const mondayOf = grabFn(A.src, "mondayOf", {});
    const p = A.PEOPLE.find((x) => x.name === r.nombre);
    assert.ok(p, `${r.app}: no existe ${r.nombre}`);
    const [y, m, d] = r.fecha.split("-").map(Number);
    const day = new Date(y, m - 1, d);
    const cell = A.ROTA[rowFor(p.startRow, mondayOf(day))][(day.getDay() + 6) % 7];
    assert.equal(cell[0], r.turno, `${r.app} ${r.nombre} ${r.fecha}: la app dice ${cell[0]}, el papel ${r.turno}`);
    if (r.unidad !== undefined) assert.equal(cell[1] ?? null, r.unidad, `${r.app} ${r.nombre} ${r.fecha}: unidad`);
  }
});
