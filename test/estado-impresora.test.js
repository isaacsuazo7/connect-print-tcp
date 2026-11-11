"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { consultarEstado, interpretarEstado, ESTADO } = require("../print-core/estado-impresora");
const { crearImpresora, puertoCerrado, ESTADO_OK } = require("./impresora-simulada");

const RAPIDO = { timeoutConexionMs: 300, timeoutRespuestaMs: 150 };

// Bytes con los bits fijos (1 y 4 en 1) más el bit que interesa.
const FIJOS = 0x12;
const con = (...bits) => bits.reduce((b, n) => b | (1 << n), FIJOS);

test("interpretar: respuestas de 'oficina' con todo bien = online", () => {
  const r = interpretarEstado({ impresora: 0x16, causaOffline: 0x12, causaError: 0x12, papel: 0x12 });
  assert.equal(r.estado, ESTADO.ONLINE);
});

test("interpretar: tapa abierta", () => {
  const r = interpretarEstado({ impresora: con(3), causaOffline: con(2), causaError: FIJOS, papel: FIJOS });
  assert.equal(r.estado, ESTADO.ERROR_TAPA);
  assert.equal(r.detalle.tapaAbierta, true);
});

test("interpretar: sin papel (sensor y causa de offline)", () => {
  assert.equal(
    interpretarEstado({ impresora: con(3), causaOffline: FIJOS, causaError: FIJOS, papel: con(5, 6) }).estado,
    ESTADO.ERROR_PAPEL
  );
  assert.equal(
    interpretarEstado({ impresora: con(3), causaOffline: con(5), causaError: FIJOS, papel: null }).estado,
    ESTADO.ERROR_PAPEL
  );
});

test("interpretar: papel por acabarse sigue online, con el aviso en el detalle", () => {
  const r = interpretarEstado({ impresora: FIJOS, causaOffline: FIJOS, causaError: FIJOS, papel: con(2, 3) });
  assert.equal(r.estado, ESTADO.ONLINE);
  assert.equal(r.detalle.papelPorAcabarse, true);
});

test("interpretar: error del cortador = error", () => {
  const r = interpretarEstado({ impresora: con(3), causaOffline: con(6), causaError: con(3), papel: FIJOS });
  assert.equal(r.estado, ESTADO.ERROR);
  assert.equal(r.detalle.errorCortador, true);
});

test("interpretar: respuesta basura o ninguna = online sin detalle (clones)", () => {
  assert.deepEqual(interpretarEstado({ impresora: null }), { estado: ESTADO.ONLINE, detalle: {} });
  assert.deepEqual(interpretarEstado({ impresora: 0xff }), { estado: ESTADO.ONLINE, detalle: {} });
});

test("consultar: impresora bien = online y soporta estado", async () => {
  const imp = await crearImpresora({ modo: "ok" });
  const r = await consultarEstado(imp.host, imp.puerto, RAPIDO);
  await imp.cerrar();
  assert.equal(r.estado, ESTADO.ONLINE);
  assert.equal(r.soportaEstado, true);
  assert.equal(imp.trabajos.length, 0, "la consulta no debe imprimir nada");
});

test("consultar: tapa abierta en la simulada = error_cover", async () => {
  const imp = await crearImpresora({ modo: "ok", estado: { 1: con(3), 2: con(2) } });
  const r = await consultarEstado(imp.host, imp.puerto, RAPIDO);
  await imp.cerrar();
  assert.equal(r.estado, ESTADO.ERROR_TAPA);
});

test("consultar: clon sin DLE EOT = online sin detalle, sin romper nada", async () => {
  const imp = await crearImpresora({ modo: "sinEstado" });
  const r = await consultarEstado(imp.host, imp.puerto, RAPIDO);
  await imp.cerrar();
  assert.equal(r.estado, ESTADO.ONLINE);
  assert.equal(r.soportaEstado, false);
});

test("consultar: apagada = offline", async () => {
  const r = await consultarEstado("127.0.0.1", await puertoCerrado(), RAPIDO);
  assert.equal(r.estado, ESTADO.OFFLINE);
});

test("consultar: no enrutable = offline al vencer el connect", async () => {
  const r = await consultarEstado("10.255.255.1", 9100, RAPIDO);
  assert.equal(r.estado, ESTADO.OFFLINE);
  assert.ok(r.ms < 600, `tardó ${r.ms} ms`);
});

test("ESTADO_OK de la simulada es el de 'oficina'", () => {
  assert.equal(ESTADO_OK[1], 0x16);
});
