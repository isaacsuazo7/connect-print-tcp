"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { AlmacenCola, ESTADO_TRABAJO } = require("../print-core/cola/almacen");
const { ColaAgente } = require("../print-core/cola/cola-agente");
const { normalizarTipo, tiemposDe, decidir, DECISION, esperaParaReintentar, MINUTO_MS, HORA_MS } = require("../print-core/cola/politica");
const { RegistroImpresoras } = require("../print-core/registro-impresoras");
const { SerializadorPorImpresora } = require("../print-core/serializador");
const { RESULTADO, enviarTrabajo } = require("../print-core/envio");
const { ESTADO } = require("../print-core/estado-impresora");
const { crearImpresora } = require("./impresora-simulada");

const IP = "10.0.30.243";

/** Cola con impresora falsa: `resultados` decide qué devuelve cada envío (por defecto, impreso). */
function armar({ resultados = [], archivo = ":memory:", estadoMonitor = ESTADO.ONLINE } = {}) {
  const reloj = { ahora: Date.parse("2026-11-11T12:00:00Z") };
  const impresos = [];
  const pendientesDeResultado = [...resultados];
  const enviar = async ({ datos }) => {
    const resultado = pendientesDeResultado.shift() || RESULTADO.IMPRESO;
    if (resultado === RESULTADO.IMPRESO) impresos.push(datos.toString());
    return { resultado, error: resultado === RESULTADO.IMPRESO ? null : `error_${resultado}`, detalle: "" };
  };
  const almacen = new AlmacenCola(archivo);
  const descargas = [];
  const monitor = { estado: estadoMonitor, estadoDe: () => ({ estado: monitor.estado }), registrarEnvio: () => undefined };
  const cola = new ColaAgente({
    almacen,
    registro: new RegistroImpresoras(null),
    serializador: new SerializadorPorImpresora(),
    enviar,
    monitor,
    alDescargar: (d) => descargas.push(d.impresos),
    ahora: () => reloj.ahora,
  });
  const encolar = (jobId, extra = {}) =>
    cola.encolar({ jobId, ip: IP, puerto: 9100, tipo: "factura", datos: Buffer.from(jobId), creadoEn: reloj.ahora, ...extra });
  const esperar = () => Promise.all([...cola.procesando.values()]);
  return { cola, almacen, reloj, impresos, descargas, monitor, encolar, esperar };
}

// ---- política (pura) ----

test("política: los mismos tiempos que el POS", () => {
  assert.deepEqual(tiemposDe("comanda"), { autoMs: 10 * MINUTO_MS, duroMs: 4 * HORA_MS });
  assert.deepEqual(tiemposDe("proforma"), { autoMs: 10 * MINUTO_MS, duroMs: 1 * HORA_MS });
  assert.deepEqual(tiemposDe("factura"), { autoMs: 30 * MINUTO_MS, duroMs: 12 * HORA_MS });
  assert.deepEqual(tiemposDe("apartado"), tiemposDe("factura"));
  assert.deepEqual(tiemposDe("cierre_caja"), { autoMs: 60 * MINUTO_MS, duroMs: 24 * HORA_MS });
  assert.deepEqual(tiemposDe("test"), { autoMs: 1 * MINUTO_MS, duroMs: 5 * MINUTO_MS });
});

test("política: acepta el número de función del POS y la nube puede cambiar tiempos", () => {
  assert.equal(normalizarTipo(3), "comanda");
  assert.equal(normalizarTipo("1"), "proforma");
  assert.equal(normalizarTipo("FACTURA"), "factura");
  assert.equal(normalizarTipo("raro"), "otro");
  assert.equal(tiemposDe("comanda", { comanda: { autoMs: 5 * MINUTO_MS } }).autoMs, 5 * MINUTO_MS);
});

test("política: imprimir / confirmar / vencer; confirmado ya no pregunta", () => {
  const t = { auto_ttl_at: 100, hard_ttl_at: 200 };
  assert.equal(decidir(t, 50), DECISION.IMPRIMIR);
  assert.equal(decidir(t, 150), DECISION.CONFIRMAR);
  assert.equal(decidir({ ...t, confirmed_at: 120 }, 150), DECISION.IMPRIMIR);
  assert.equal(decidir(t, 200), DECISION.VENCER);
});

test("política: reintentos 2 → 5 → 15 → 30 → 60 s; caída = 1 por minuto", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((n) => esperaParaReintentar(n, false)), [2000, 5000, 15000, 30000, 60000, 60000]);
  assert.equal(esperaParaReintentar(1, true), 60000);
});

// ---- cola ----

test("encolar responde al instante con pending y se imprime solo", async () => {
  const { encolar, esperar, impresos, almacen } = armar();
  const { nuevo, trabajo } = encolar("J1");
  assert.equal(nuevo, true);
  assert.equal(trabajo.status, ESTADO_TRABAJO.PENDIENTE);
  await esperar();
  assert.deepEqual(impresos, ["J1"]);
  assert.equal(almacen.obtener("J1").status, ESTADO_TRABAJO.IMPRESO);
});

test("idempotencia: el mismo job_id tres veces imprime una", async () => {
  const { encolar, esperar, impresos } = armar();
  assert.equal(encolar("J1").nuevo, true);
  await esperar();
  assert.equal(encolar("J1").nuevo, false);
  assert.equal(encolar("J1").trabajo.status, ESTADO_TRABAJO.IMPRESO);
  await esperar();
  assert.deepEqual(impresos, ["J1"]);
});

test("impresora caída: los 5 esperan y al volver salen en orden, sin duplicados", async () => {
  const { cola, encolar, esperar, impresos, descargas, reloj, monitor } = armar({ resultados: [RESULTADO.FALLIDO] });
  monitor.estado = ESTADO.OFFLINE;
  for (const n of [1, 2, 3, 4, 5]) {
    encolar(`J${n}`, { creadoEn: reloj.ahora + n });
  }
  await esperar();
  assert.deepEqual(impresos, [], "con la impresora caída no sale nada");
  monitor.estado = ESTADO.ONLINE;
  reloj.ahora += 30 * 1000; // vuelve a los 30 s
  await cola.alVolver(cola.registro.lista()[0]);
  assert.deepEqual(impresos, ["J1", "J2", "J3", "J4", "J5"]);
  assert.deepEqual(descargas, [5]);
});

test("si el más viejo falla, los de atrás esperan (nunca se saltan)", async () => {
  const { encolar, esperar, impresos, almacen, reloj } = armar({ resultados: [RESULTADO.FALLIDO] });
  encolar("J1", { creadoEn: reloj.ahora });
  await esperar();
  encolar("J2", { creadoEn: reloj.ahora + 1 });
  await esperar();
  assert.deepEqual(impresos, []);
  assert.equal(almacen.obtener("J2").status, ESTADO_TRABAJO.PENDIENTE);
});

test("fallido reintenta con la espera de la política", async () => {
  const { cola, encolar, esperar, impresos, almacen, reloj } = armar({ resultados: [RESULTADO.FALLIDO, RESULTADO.FALLIDO] });
  encolar("J1");
  await esperar();
  assert.equal(almacen.obtener("J1").next_attempt_at, reloj.ahora + 2000);
  cola.revisar();
  await esperar();
  assert.deepEqual(impresos, [], "antes de los 2 s no reintenta");
  reloj.ahora += 2000;
  cola.revisar();
  await esperar();
  assert.equal(almacen.obtener("J1").next_attempt_at, reloj.ahora + 5000);
  reloj.ahora += 5000;
  cola.revisar();
  await esperar();
  assert.deepEqual(impresos, ["J1"]);
  assert.equal(almacen.obtener("J1").attempts, 3);
});

test("incierto: queda por confirmar y NO se reintenta solo (no duplicar)", async () => {
  const { cola, encolar, esperar, impresos, almacen, reloj } = armar({ resultados: [RESULTADO.INCIERTO] });
  encolar("J1");
  await esperar();
  assert.equal(almacen.obtener("J1").status, ESTADO_TRABAJO.POR_CONFIRMAR);
  reloj.ahora += 5 * MINUTO_MS;
  cola.revisar();
  await esperar();
  assert.deepEqual(impresos, []);
  cola.confirmar("J1");
  await esperar();
  assert.deepEqual(impresos, ["J1"]);
});

test("comanda de hace 15 min queda en awaiting_confirm; confirmarla la imprime", async () => {
  const { cola, encolar, esperar, impresos, almacen, reloj } = armar();
  encolar("C1", { tipo: "comanda", creadoEn: reloj.ahora - 15 * MINUTO_MS });
  await esperar();
  assert.equal(almacen.obtener("C1").status, ESTADO_TRABAJO.POR_CONFIRMAR);
  assert.deepEqual(impresos, []);
  cola.confirmar("C1");
  await esperar();
  assert.deepEqual(impresos, ["C1"]);
});

test("proforma de hace 2 h queda expired", async () => {
  const { encolar, esperar, impresos, almacen, reloj } = armar();
  encolar("P1", { tipo: "proforma", creadoEn: reloj.ahora - 2 * HORA_MS });
  await esperar();
  assert.equal(almacen.obtener("P1").status, ESTADO_TRABAJO.VENCIDO);
  assert.deepEqual(impresos, []);
});

test("por confirmar que nadie confirmó: vence al pasar el tiempo duro", () => {
  const { cola, encolar, almacen, reloj } = armar({ resultados: [RESULTADO.INCIERTO] });
  encolar("P1", { tipo: "proforma" });
  return Promise.all([...cola.procesando.values()]).then(() => {
    reloj.ahora += 2 * HORA_MS;
    cola.revisar();
    assert.equal(almacen.obtener("P1").status, ESTADO_TRABAJO.VENCIDO);
  });
});

test("descartar: pendiente o por confirmar pasa a discarded y no sale", async () => {
  const { cola, encolar, esperar, impresos, almacen, monitor } = armar({ resultados: [RESULTADO.FALLIDO] });
  monitor.estado = ESTADO.OFFLINE;
  encolar("J1");
  await esperar();
  cola.descartar("J1");
  await cola.descargar();
  assert.equal(almacen.obtener("J1").status, ESTADO_TRABAJO.DESCARTADO);
  assert.deepEqual(impresos, []);
});

test("la hora de la tablet en el futuro no alarga los tiempos", () => {
  const { encolar, reloj } = armar();
  const { trabajo } = encolar("J1", { creadoEn: reloj.ahora + HORA_MS });
  assert.equal(trabajo.created_at, reloj.ahora);
});

test("job_id inválido se rechaza", () => {
  const { encolar } = armar();
  assert.throws(() => encolar(""), /job_id/);
  assert.throws(() => encolar("x".repeat(65)), /job_id/);
});

test("corte de luz con 5 pendientes: al reabrir siguen ahí y salen; lo que estaba imprimiéndose pregunta", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cola-"));
  const archivo = path.join(dir, "queue.db");
  const a = armar({ archivo, resultados: Array(5).fill(RESULTADO.FALLIDO) });
  a.monitor.estado = ESTADO.OFFLINE;
  for (const n of [1, 2, 3, 4, 5]) a.encolar(`J${n}`, { creadoEn: a.reloj.ahora + n });
  await a.esperar();
  a.almacen.actualizar("J1", { status: ESTADO_TRABAJO.IMPRIMIENDO }); // se cortó la luz mandando J1
  a.almacen.cerrar(); // "se apagó la PC"

  const b = armar({ archivo });
  b.reloj.ahora = a.reloj.ahora + 60 * 1000;
  b.cola.iniciar(); // al arrancar: lo que estaba imprimiéndose pasa a por confirmar
  b.cola.detener();
  await b.cola.descargar();
  assert.equal(b.almacen.obtener("J1").status, ESTADO_TRABAJO.POR_CONFIRMAR);
  assert.deepEqual(b.impresos, ["J2", "J3", "J4", "J5"]);
  b.almacen.cerrar();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("base corrupta: se aparta y se crea una nueva, sin caerse", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cola-"));
  const archivo = path.join(dir, "queue.db");
  fs.writeFileSync(archivo, "esto no es una base sqlite ".repeat(200));
  const mensajes = [];
  const almacen = new AlmacenCola(archivo, { log: (m) => mensajes.push(m) });
  assert.deepEqual(almacen.totales(), {});
  almacen.cerrar();
  assert.ok(mensajes.some((m) => m.includes("corrupta")));
  assert.ok(fs.readdirSync(dir).some((f) => f.includes("corrupta")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("con la impresora simulada de verdad: entra, sale y queda printed", async () => {
  const imp = await crearImpresora({ modo: "ok" });
  const almacen = new AlmacenCola(":memory:");
  const cola = new ColaAgente({
    almacen,
    registro: new RegistroImpresoras(null),
    serializador: new SerializadorPorImpresora(),
    enviar: (t) => enviarTrabajo(t, { timeoutConexionMs: 300, timeoutTotalMs: 800 }),
  });
  cola.encolar({ jobId: "R1", ip: imp.host, puerto: imp.puerto, tipo: 2, datos: Buffer.from("hola") });
  await Promise.all([...cola.procesando.values()]);
  await imp.cerrar();
  assert.equal(almacen.obtener("R1").status, ESTADO_TRABAJO.IMPRESO);
  assert.deepEqual(imp.trabajos.map((b) => b.toString()), ["hola"]);
});
