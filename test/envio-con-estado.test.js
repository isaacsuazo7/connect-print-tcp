"use strict";
// BUG-10 del reporte de QA (19-nov-2026): sin papel / tapa abierta no se manda nada y el resultado es fallido.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { enviarRevisandoEstado, esErrorFisico, ERROR_FISICO, ERROR_OTRA_IMPRESORA } = require("../print-core/envio-con-estado");
const { consultarEstado, ESTADO } = require("../print-core/estado-impresora");
const { enviarTrabajo, RESULTADO, ERROR } = require("../print-core/envio");
const { MonitorImpresoras } = require("../print-core/monitor-impresoras");
const { RegistroImpresoras } = require("../print-core/registro-impresoras");
const { SerializadorPorImpresora } = require("../print-core/serializador");
const { crearImpresora } = require("./impresora-simulada");

const FIJOS = 0x12;
const con = (...bits) => bits.reduce((b, n) => b | (1 << n), FIJOS);
/** Como la EPSON de QA y la "oficina": offline por falta de papel (n=1 bit 3, n=2 bit 5, n=4 bits 5-6). */
const SIN_PAPEL = { 1: con(3), 2: con(5), 4: con(5, 6) };
const TAPA_ABIERTA = { 1: con(3), 2: con(2) };
const TICKET = Buffer.from("COMANDA #1\n");
const RAPIDO = { timeoutConexionMs: 300, timeoutRespuestaMs: 150 };
const NADA_CONOCIDO = { estado: ESTADO.DESCONOCIDO, soportaEstado: null };

const consultarRapido = (host, puerto) => consultarEstado(host, puerto, RAPIDO);
const enviarRapido = (t) => enviarTrabajo(t, { timeoutConexionMs: 300 });
const trabajoPara = (imp) => ({ host: imp.host, puerto: imp.puerto, datos: TICKET });
const deps = (conocido = NADA_CONOCIDO, extra = {}) => ({ enviar: enviarRapido, consultar: consultarRapido, conocido, ...extra });

test("sin papel: no manda nada y devuelve fallido con error sin_papel", async () => {
  const imp = await crearImpresora({ estado: SIN_PAPEL });
  const envio = await enviarRevisandoEstado(trabajoPara(imp), deps());

  assert.equal(envio.resultado, RESULTADO.FALLIDO);
  assert.equal(envio.error, ERROR_FISICO.SIN_PAPEL);
  assert.equal(envio.consulta.estado, ESTADO.ERROR_PAPEL);
  assert.equal(imp.trabajos.length, 0, "la impresora no recibió el ticket");
  await imp.cerrar();
});

test("tapa abierta: no manda nada y devuelve fallido con error tapa_abierta", async () => {
  const imp = await crearImpresora({ estado: TAPA_ABIERTA });
  const envio = await enviarRevisandoEstado(trabajoPara(imp), deps());

  assert.equal(envio.resultado, RESULTADO.FALLIDO);
  assert.equal(envio.error, ERROR_FISICO.TAPA_ABIERTA);
  assert.equal(imp.trabajos.length, 0);
  await imp.cerrar();
});

test("con papel: imprime una sola vez", async () => {
  const imp = await crearImpresora();
  const envio = await enviarRevisandoEstado(trabajoPara(imp), deps());

  assert.equal(envio.resultado, RESULTADO.IMPRESO);
  assert.equal(imp.trabajos.length, 1);
  assert.deepEqual(imp.trabajos[0], TICKET);
  await imp.cerrar();
});

test("clon que ya se sabe que no contesta DLE EOT: no se le pregunta (sin demora)", async () => {
  const imp = await crearImpresora({ modo: "sinEstado" });
  let preguntas = 0;
  const envio = await enviarRevisandoEstado(
    trabajoPara(imp),
    deps({ estado: ESTADO.ONLINE, soportaEstado: false }, { consultar: (...a) => (preguntas++, consultarRapido(...a)) })
  );

  assert.equal(preguntas, 0);
  assert.equal(envio.resultado, RESULTADO.IMPRESO);
  assert.equal(envio.consulta, null);
  await imp.cerrar();
});

test("no contesta DLE EOT ahora pero el monitor la vio sin papel: no manda", async () => {
  const imp = await crearImpresora({ modo: "sinEstado" });
  const envio = await enviarRevisandoEstado(trabajoPara(imp), deps({ estado: ESTADO.ERROR_PAPEL, soportaEstado: true }));

  assert.equal(envio.error, ERROR_FISICO.SIN_PAPEL);
  assert.equal(imp.trabajos.length, 0);
  await imp.cerrar();
});

test("apagada: fallido printer_offline, como antes (para que se busque por MAC)", async () => {
  const imp = await crearImpresora();
  const { host, puerto } = imp;
  await imp.cerrar();
  const envio = await enviarRevisandoEstado({ host, puerto, datos: TICKET }, deps());

  assert.equal(envio.resultado, RESULTADO.FALLIDO);
  assert.equal(envio.error, ERROR.SIN_CONEXION);
  assert.equal(esErrorFisico(envio.error), false);
});

test("monitor: un fallido por papel no la pasa a offline y la consulta deja el estado real", async () => {
  const imp = await crearImpresora({ estado: SIN_PAPEL });
  const registro = new RegistroImpresoras(null);
  registro.resolverDestino({ ip: imp.host, puerto: imp.puerto });
  const [registrada] = registro.lista();
  const monitor = new MonitorImpresoras({ registro, serializador: new SerializadorPorImpresora(), consultar: consultarRapido });

  const envio = await enviarRevisandoEstado(trabajoPara(imp), deps(monitor.estadoDe(registrada)));
  monitor.registrarConsulta(registrada, envio.consulta);
  monitor.registrarEnvio(registrada, envio.resultado, envio.error);

  assert.equal(monitor.estadoDe(registrada).estado, ESTADO.ERROR_PAPEL);
  assert.equal(monitor.estadoDe(registrada).soportaEstado, true);
  await imp.cerrar();
});

test("monitor: una consulta sin respuesta DLE EOT no cambia si soporta estado (pudo estar ocupada)", async () => {
  const registro = new RegistroImpresoras(null);
  registro.resolverDestino({ ip: "127.0.0.1", puerto: 9 });
  const [registrada] = registro.lista();
  const monitor = new MonitorImpresoras({ registro, serializador: new SerializadorPorImpresora() });
  monitor.registrar(registrada, ESTADO.ONLINE, {}, true);

  monitor.registrarConsulta(registrada, { estado: ESTADO.ONLINE, soportaEstado: false, detalle: {} });

  assert.equal(monitor.estadoDe(registrada).soportaEstado, true);
});

// BUG-17 (QA ronda 3, 25-nov): otra impresora tomó la IP vieja de esta.
test("otra impresora en la IP: no manda nada y devuelve fallido con error otra_impresora", async () => {
  const imp = await crearImpresora();
  const pedidas = [];
  const envio = await enviarRevisandoEstado(
    trabajoPara(imp),
    deps(NADA_CONOCIDO, { verificarDestino: async (host) => (pedidas.push(host), "En 10.0.0.1 contesta \"Test\"") }),
  );

  assert.equal(envio.resultado, RESULTADO.FALLIDO);
  assert.equal(envio.error, ERROR_OTRA_IMPRESORA);
  assert.equal(imp.trabajos.length, 0, "la impresora equivocada no recibió el ticket");
  assert.equal(pedidas.length, 1, "se verificó después de conectarse a preguntar el estado");
  await imp.cerrar();
});

test("la impresora esperada en la IP: imprime normal", async () => {
  const imp = await crearImpresora();
  const envio = await enviarRevisandoEstado(trabajoPara(imp), deps(NADA_CONOCIDO, { verificarDestino: async () => null }));

  assert.equal(envio.resultado, RESULTADO.IMPRESO);
  assert.equal(imp.trabajos.length, 1);
  await imp.cerrar();
});

test("clon sin DLE EOT con otra impresora en la IP: tampoco manda", async () => {
  const imp = await crearImpresora();
  const envio = await enviarRevisandoEstado(
    trabajoPara(imp),
    deps({ estado: ESTADO.ONLINE, soportaEstado: false }, { verificarDestino: async () => "otra" }),
  );

  assert.equal(envio.error, ERROR_OTRA_IMPRESORA);
  assert.equal(imp.trabajos.length, 0);
  await imp.cerrar();
});
