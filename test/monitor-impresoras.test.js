"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { MonitorImpresoras } = require("../print-core/monitor-impresoras");
const { RegistroImpresoras, DISCOVERY } = require("../print-core/registro-impresoras");
const { SerializadorPorImpresora } = require("../print-core/serializador");
const { consultarEstado, ESTADO } = require("../print-core/estado-impresora");
const { RESULTADO } = require("../print-core/envio");
const { crearImpresora } = require("./impresora-simulada");

const RAPIDO = { timeoutConexionMs: 300, timeoutRespuestaMs: 150 };
const FIJOS = 0x12;
const con = (...bits) => bits.reduce((b, n) => b | (1 << n), FIJOS);

function armar(impresoras) {
  const registro = new RegistroImpresoras(null);
  for (const imp of impresoras) registro.resolverDestino({ ip: imp.host, puerto: imp.puerto });
  const transiciones = [];
  const monitor = new MonitorImpresoras({
    registro,
    serializador: new SerializadorPorImpresora(),
    consultar: (ip, puerto) => consultarEstado(ip, puerto, RAPIDO),
    alCambiar: (t) => transiciones.push(`${t.de}→${t.a}`),
  });
  return { registro, monitor, transiciones };
}

test("apagada no dice si soporta estado: queda lo que se sabía o null (inventario)", async () => {
  const imp = await crearImpresora({ modo: "ok" });
  const { registro, monitor } = armar([imp]);
  const [registrada] = registro.lista();

  await monitor.revisarTodas();
  assert.equal(monitor.estadoDe(registrada).soportaEstado, true);
  await imp.cerrar();
  await monitor.revisarTodas();
  assert.equal(monitor.estadoDe(registrada).estado, ESTADO.OFFLINE);
  assert.equal(monitor.estadoDe(registrada).soportaEstado, true, "lo que se sabía");

  const { registro: otroRegistro, monitor: otroMonitor } = armar([imp]); // nunca contestó
  await otroMonitor.revisarTodas();
  assert.equal(otroMonitor.estadoDe(otroRegistro.lista()[0]).soportaEstado, null);
});

test("ciclo completo: online → apagada (offline) → encendida (online)", async () => {
  const imp = await crearImpresora({ modo: "ok" });
  const { registro, monitor, transiciones } = armar([imp]);
  const [registrada] = registro.lista();

  await monitor.revisarTodas();
  assert.equal(monitor.estadoDe(registrada).estado, ESTADO.ONLINE);

  await imp.cerrar(); // apagar
  await monitor.revisarTodas();
  assert.equal(monitor.estadoDe(registrada).estado, ESTADO.OFFLINE);

  const otra = await crearImpresora({ modo: "ok" }); // encender (en otro puerto: se mueve el registro)
  registrada.ip = otra.host;
  registrada.puerto = otra.puerto;
  await monitor.revisarTodas();
  await otra.cerrar();
  assert.deepEqual(transiciones, ["unknown→online", "online→offline", "offline→online"]);
});

test("tapa abierta → error_cover; al cerrarla vuelve a online", async () => {
  const imp = await crearImpresora({ modo: "ok" });
  const { registro, monitor, transiciones } = armar([imp]);
  await monitor.revisarTodas();
  imp.estado[1] = con(3);
  imp.estado[2] = con(2);
  await monitor.revisarTodas();
  assert.equal(monitor.estadoDe(registro.lista()[0]).estado, ESTADO.ERROR_TAPA);
  imp.estado[1] = 0x16;
  imp.estado[2] = FIJOS;
  await monitor.revisarTodas();
  await imp.cerrar();
  assert.deepEqual(transiciones, ["unknown→online", "online→error_cover", "error_cover→online"]);
});

test("con la tapa abierta, una impresión aceptada no la pasa a online (solo DLE EOT la aclara)", async () => {
  const imp = await crearImpresora({ modo: "ok" });
  const { registro, monitor, transiciones } = armar([imp]);
  const [registrada] = registro.lista();
  await monitor.revisarTodas();
  imp.estado[1] = con(3);
  imp.estado[2] = con(2);
  await monitor.revisarTodas();
  monitor.registrarEnvio(registrada, RESULTADO.IMPRESO); // p. ej. el chequeo de Reconectar
  assert.equal(monitor.estadoDe(registrada).estado, ESTADO.ERROR_TAPA);
  imp.estado[1] = 0x16;
  imp.estado[2] = FIJOS;
  await monitor.revisarTodas();
  await imp.cerrar();
  assert.deepEqual(transiciones, ["unknown→online", "online→error_cover", "error_cover→online"]);
});

test("sin papel → error_paper", async () => {
  const imp = await crearImpresora({ modo: "ok", estado: { 1: con(3), 4: con(5, 6) } });
  const { registro, monitor } = armar([imp]);
  await monitor.revisarTodas();
  await imp.cerrar();
  assert.equal(monitor.estadoDe(registro.lista()[0]).estado, ESTADO.ERROR_PAPEL);
});

test("clon sin DLE EOT: online sin detalle, sin romper nada", async () => {
  const imp = await crearImpresora({ modo: "sinEstado" });
  const { registro, monitor } = armar([imp]);
  await monitor.revisarTodas();
  await imp.cerrar();
  const e = monitor.estadoDe(registro.lista()[0]);
  assert.equal(e.estado, ESTADO.ONLINE);
  assert.equal(e.soportaEstado, false);
});

test("sin conexión y el discovery no la encuentra por MAC = not_found", async () => {
  const imp = await crearImpresora({ modo: "ok" });
  const { registro, monitor } = armar([imp]);
  await imp.cerrar();
  registro.marcarDiscovery(registro.lista()[0], DISCOVERY.NO_ENCONTRADA);
  await monitor.revisarTodas();
  assert.equal(monitor.estadoDe(registro.lista()[0]).estado, ESTADO.NOT_FOUND);
});

test("antes de la primera revisión el estado es unknown", () => {
  const { monitor } = armar([]);
  assert.equal(monitor.estadoDe({ clave: "cod:1" }).estado, ESTADO.DESCONOCIDO);
});

test("dos impresoras en paralelo: una colgada no retrasa la revisión de la otra", async () => {
  const colgada = await crearImpresora({ modo: "colgada" });
  const bien = await crearImpresora({ modo: "ok" });
  const { registro, monitor } = armar([colgada, bien]);
  const inicio = Date.now();
  await monitor.revisarTodas();
  const ms = Date.now() - inicio;
  await colgada.cerrar();
  await bien.cerrar();
  // La colgada acepta pero no contesta DLE EOT: se toma como online sin detalle (como un clon).
  assert.ok(ms < 1000, `la vuelta tardó ${ms} ms`);
  assert.equal(monitor.estadoDe(registro.lista()[1]).estado, ESTADO.ONLINE);
});

test("una revisión no se mete en medio de un ticket de la misma impresora", async () => {
  const orden = [];
  const registro = new RegistroImpresoras(null);
  registro.resolverDestino({ ip: "10.0.0.1", puerto: 9100 });
  const [imp] = registro.lista();
  const serializador = new SerializadorPorImpresora();
  const monitor = new MonitorImpresoras({
    registro,
    serializador,
    consultar: async () => {
      orden.push("revisión");
      return { estado: ESTADO.ONLINE, detalle: {}, soportaEstado: true };
    },
  });
  const ticket = serializador.ejecutar(imp.clave, async () => {
    orden.push("ticket empieza");
    await new Promise((ok) => setTimeout(ok, 50));
    orden.push("ticket termina");
  });
  await Promise.all([ticket, monitor.revisarTodas()]);
  assert.deepEqual(orden, ["ticket empieza", "ticket termina", "revisión"]);
});

test("no apila revisiones de la misma impresora si la anterior sigue en curso", async () => {
  let consultas = 0;
  const registro = new RegistroImpresoras(null);
  registro.resolverDestino({ ip: "10.0.0.1", puerto: 9100 });
  const monitor = new MonitorImpresoras({
    registro,
    serializador: new SerializadorPorImpresora(),
    consultar: async () => {
      consultas++;
      await new Promise((ok) => setTimeout(ok, 50));
      return { estado: ESTADO.ONLINE, detalle: {}, soportaEstado: true };
    },
  });
  await Promise.all([monitor.revisarTodas(), monitor.revisarTodas(), monitor.revisarTodas()]);
  assert.equal(consultas, 1);
});

test("resultado de impresión: imprimió = online; no conectó = offline al instante", () => {
  const registro = new RegistroImpresoras(null);
  registro.resolverDestino({ ip: "10.0.0.1", puerto: 9100 });
  const [imp] = registro.lista();
  const transiciones = [];
  const monitor = new MonitorImpresoras({
    registro,
    serializador: new SerializadorPorImpresora(),
    alCambiar: (t) => transiciones.push(`${t.de}→${t.a}`),
  });
  monitor.registrarEnvio(imp, RESULTADO.IMPRESO);
  monitor.registrarEnvio(imp, RESULTADO.INCIERTO); // no cambia nada
  monitor.registrarEnvio(imp, RESULTADO.FALLIDO);
  assert.deepEqual(transiciones, ["unknown→online", "online→offline"]);
});

test("un error en quien escucha los cambios no rompe el monitor", async () => {
  const imp = await crearImpresora({ modo: "ok" });
  const registro = new RegistroImpresoras(null);
  registro.resolverDestino({ ip: imp.host, puerto: imp.puerto });
  const monitor = new MonitorImpresoras({
    registro,
    serializador: new SerializadorPorImpresora(),
    consultar: (ip, puerto) => consultarEstado(ip, puerto, RAPIDO),
    alCambiar: () => {
      throw new Error("la nube explotó");
    },
  });
  await monitor.revisarTodas();
  await imp.cerrar();
  assert.equal(monitor.estadoDe(registro.lista()[0]).estado, ESTADO.ONLINE);
});
