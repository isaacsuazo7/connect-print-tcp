"use strict";
// BUG-12 del reporte de QA ronda 2 (24-nov-2026): el envío no puede pasarse del tiempo que el POS espera.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { terminaAntesDe } = require("../print-core/plazo");

const esperar = (ms, valor) => new Promise((resolve) => setTimeout(() => resolve(valor), ms));

test("si termina a tiempo devuelve true", async () => {
  assert.equal(await terminaAntesDe(esperar(10), Date.now() + 500), true);
});

test("si se pasa del límite devuelve false sin esperarla", async () => {
  const inicio = Date.now();
  assert.equal(await terminaAntesDe(esperar(2000), Date.now() + 50), false);
  assert.ok(Date.now() - inicio < 1000, "no esperó a la tarea lenta");
});

test("con el límite ya vencido devuelve false al instante", async () => {
  assert.equal(await terminaAntesDe(esperar(10), Date.now() - 1), false);
});

test("si la tarea falla a tiempo no rechaza (cuenta como terminada)", async () => {
  assert.equal(await terminaAntesDe(Promise.reject(new Error("arp")), Date.now() + 500), true);
});
