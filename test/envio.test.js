"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { enviarTrabajo, RESULTADO, ERROR } = require("../print-core/envio");
const { SerializadorPorImpresora } = require("../print-core/serializador");
const { crearImpresora, puertoCerrado } = require("./impresora-simulada");

const TICKET = Buffer.from("\x1b@Hola\n\x1dV\x00", "binary");
const RAPIDO = { timeoutConexionMs: 300, timeoutTotalMs: 800 };

test("impresora bien: impreso solo después de que ella cierra, con los bytes completos", async () => {
  const imp = await crearImpresora({ modo: "ok" });
  const r = await enviarTrabajo({ host: imp.host, puerto: imp.puerto, datos: TICKET }, RAPIDO);
  await imp.cerrar();
  assert.equal(r.resultado, RESULTADO.IMPRESO);
  assert.equal(imp.trabajos.length, 1);
  assert.deepEqual(imp.trabajos[0], TICKET);
});

test("acepta Uint8Array (lo que arma el servicio desde base64)", async () => {
  const imp = await crearImpresora({ modo: "ok" });
  const r = await enviarTrabajo({ host: imp.host, puerto: imp.puerto, datos: new Uint8Array(TICKET) }, RAPIDO);
  await imp.cerrar();
  assert.equal(r.resultado, RESULTADO.IMPRESO);
  assert.deepEqual(imp.trabajos[0], TICKET);
});

test("impresora apagada (rechaza): fallido al instante, se puede reintentar", async () => {
  const r = await enviarTrabajo({ host: "127.0.0.1", puerto: await puertoCerrado(), datos: TICKET }, RAPIDO);
  assert.equal(r.resultado, RESULTADO.FALLIDO);
  assert.equal(r.error, ERROR.SIN_CONEXION);
  assert.ok(r.ms < 300, `tardó ${r.ms} ms`);
});

test("impresora apagada (no contesta nadie): fallido al vencer el connect, no a los 21 s", async () => {
  // 10.255.255.1 no se enruta: el connect queda colgado como con la impresora apagada en la LAN.
  const r = await enviarTrabajo({ host: "10.255.255.1", puerto: 9100, datos: TICKET }, RAPIDO);
  assert.equal(r.resultado, RESULTADO.FALLIDO);
  assert.equal(r.error, ERROR.SIN_CONEXION);
  assert.ok(r.ms < 600, `tardó ${r.ms} ms`);
});

test("impresora colgada (acepta y no lee): incierto al vencer el total, nunca impreso", async () => {
  const imp = await crearImpresora({ modo: "colgada" });
  const r = await enviarTrabajo({ host: imp.host, puerto: imp.puerto, datos: TICKET }, RAPIDO);
  await imp.cerrar();
  assert.equal(r.resultado, RESULTADO.INCIERTO);
  assert.equal(r.error, ERROR.COLGADA);
  assert.ok(r.ms >= 700 && r.ms < 1200, `tardó ${r.ms} ms`);
});

test("se corta a mitad: incierto (pudo haber impreso algo)", async () => {
  const imp = await crearImpresora({ modo: "incierta" });
  const r = await enviarTrabajo({ host: imp.host, puerto: imp.puerto, datos: TICKET }, RAPIDO);
  await imp.cerrar();
  assert.equal(r.resultado, RESULTADO.INCIERTO);
  assert.equal(r.error, ERROR.CORTADA);
});

test("con dos impresoras, una colgada no retrasa a la otra", async () => {
  const colgada = await crearImpresora({ modo: "colgada" });
  const bien = await crearImpresora({ modo: "ok" });
  const serie = new SerializadorPorImpresora();
  const enviar = (imp) =>
    serie.ejecutar(`${imp.host}:${imp.puerto}`, () =>
      enviarTrabajo({ host: imp.host, puerto: imp.puerto, datos: TICKET }, RAPIDO)
    );
  const lenta = enviar(colgada);
  const rapida = await enviar(bien);
  assert.equal(rapida.resultado, RESULTADO.IMPRESO);
  assert.ok(rapida.ms < 200, `la buena tardó ${rapida.ms} ms`);
  assert.equal((await lenta).resultado, RESULTADO.INCIERTO);
  await colgada.cerrar();
  await bien.cerrar();
});

test("misma impresora: los trabajos salen uno por uno y en orden", async () => {
  const imp = await crearImpresora({ modo: "ok" });
  const serie = new SerializadorPorImpresora();
  const clave = `${imp.host}:${imp.puerto}`;
  const envios = [1, 2, 3].map((n) =>
    serie.ejecutar(clave, () => enviarTrabajo({ host: imp.host, puerto: imp.puerto, datos: Buffer.from(`T${n}`) }, RAPIDO))
  );
  const resultados = await Promise.all(envios);
  await imp.cerrar();
  assert.deepEqual(resultados.map((r) => r.resultado), ["impreso", "impreso", "impreso"]);
  assert.deepEqual(imp.trabajos.map((b) => b.toString()), ["T1", "T2", "T3"]);
  assert.equal(serie.impresorasOcupadas, 0);
});
