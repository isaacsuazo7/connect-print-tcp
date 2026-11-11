"use strict";
// Supervisor con procesos reales (test/fixtures/agente-falso.js) y /health real por HTTP.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { Supervisor } = require("../servicio/supervisor");
const { EstadoVersiones } = require("../print-core/actualizacion/estado-versiones");

const AGENTE_FALSO = path.join(__dirname, "fixtures", "agente-falso.js");
const PLAZO_CORTO_MS = 1500;

const puertoLibre = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/**
 * @param {Record<string, string|null>} modos versión → modo del agente falso (null = no está en disco)
 */
async function armar(modos, estadoInicial) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "yalo-supervisor-"));
  const estado = new EstadoVersiones(raiz);
  if (estadoInicial) estado.escribir({ fallidas: [], ...estadoInicial });
  const puerto = await puertoLibre();
  const lanzadas = [];
  let alSalir;
  const salida = new Promise((r) => {
    alSalir = r;
  });
  const supervisor = new Supervisor({
    raiz,
    versionPropia: "1.3.0",
    puerto,
    plazoMs: PLAZO_CORTO_MS,
    cadaMs: 100,
    comandoDe: (v) => (modos[v] ? { comando: process.execPath, args: [AGENTE_FALSO, v, modos[v], String(puerto)] } : null),
    lanzar: (comando, args, env) => {
      lanzadas.push(args[1]);
      return spawn(comando, args, { env, stdio: "ignore" });
    },
    salir: (codigo) => alSalir(codigo),
    log: () => undefined,
  });
  const terminar = () => {
    supervisor.deteniendo = true;
    if (supervisor.hijo) supervisor.hijo.kill();
  };
  return { supervisor, estado, lanzadas, salida, terminar };
}

async function esperarQue(condicion, ms = 5000) {
  const limite = Date.now() + ms;
  while (!condicion()) {
    if (Date.now() > limite) throw new Error("tiempo agotado");
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("sin actualizacion.json corre la versión del instalador; si se cierra, sale con su código (nssm reinicia)", async () => {
  const { supervisor, lanzadas, salida } = await armar({ "1.3.0": "crash" });
  supervisor.iniciar();
  assert.equal(await salida, 3);
  assert.deepEqual(lanzadas, ["1.3.0"]);
});

test("versión nueva que responde /health queda confirmada", async () => {
  const { supervisor, estado, lanzadas, terminar } = await armar(
    { "1.3.0": "ok", "1.4.0": "ok" },
    { actual: "1.4.0", anterior: "1.3.0", probando: true }
  );
  supervisor.iniciar();
  await esperarQue(() => estado.leer().probando === false);
  const e = estado.leer();
  assert.equal(e.actual, "1.4.0");
  assert.equal(e.ultimoResultado.resultado, "ok");
  assert.equal(e.ultimoResultado.de, "1.3.0");
  assert.deepEqual(lanzadas, ["1.4.0"]);
  terminar();
});

test("versión nueva que se cae al arrancar: rollback a la anterior y queda como fallida", async () => {
  const { supervisor, estado, lanzadas, terminar } = await armar(
    { "1.3.0": "ok", "1.4.0": "crash" },
    { actual: "1.4.0", anterior: "1.3.0", probando: true }
  );
  supervisor.iniciar();
  await esperarQue(() => lanzadas.length === 2);
  const e = estado.leer();
  assert.deepEqual(lanzadas, ["1.4.0", "1.3.0"]);
  assert.equal(e.actual, "1.3.0");
  assert.equal(e.probando, false);
  assert.deepEqual(e.fallidas, ["1.4.0"]);
  assert.equal(e.ultimoResultado.resultado, "fallo");
  assert.match(e.ultimoResultado.motivo, /se cerró/);
  terminar();
});

test("versión nueva colgada (no responde /health en el plazo): se la mata y rollback", async () => {
  const { supervisor, estado, lanzadas, terminar } = await armar(
    { "1.3.0": "ok", "1.4.0": "mudo" },
    { actual: "1.4.0", anterior: "1.3.0", probando: true }
  );
  supervisor.iniciar();
  await esperarQue(() => lanzadas.length === 2, PLAZO_CORTO_MS + 4000);
  const e = estado.leer();
  assert.equal(e.actual, "1.3.0");
  assert.match(e.ultimoResultado.motivo, /no respondió \/health/);
  terminar();
});

test("el agente pide la actualización y sale: el supervisor levanta la nueva enseguida y la confirma", async () => {
  const { supervisor, estado, lanzadas, terminar } = await armar({ "1.3.0": "pide", "1.4.0": "ok" });
  supervisor.iniciar();
  await esperarQue(() => estado.leer().ultimoResultado?.resultado === "ok");
  assert.deepEqual(lanzadas, ["1.3.0", "1.4.0"]);
  assert.equal(estado.leer().actual, "1.4.0");
  terminar();
});

test("el agente pide una versión cuyo .exe no está: queda como fallida y sigue la actual", async () => {
  const { supervisor, estado, lanzadas, terminar } = await armar({ "1.3.0": "pide", "1.4.0": null });
  supervisor.iniciar();
  await esperarQue(() => lanzadas.length === 2);
  const e = estado.leer();
  assert.deepEqual(lanzadas, ["1.3.0", "1.3.0"]);
  assert.deepEqual(e.fallidas, ["1.4.0"]);
  assert.equal(e.ultimoResultado.resultado, "fallo");
  terminar();
});

test("reinstalación con un paquete más nuevo: ignora la versión vieja de actualizacion.json", async () => {
  const { supervisor, estado, lanzadas, terminar } = await armar(
    { "1.3.0": "ok", "1.2.0": "ok" },
    { actual: "1.2.0", anterior: "1.1.0", probando: false }
  );
  supervisor.iniciar();
  assert.deepEqual(lanzadas, ["1.3.0"]);
  assert.equal(estado.leer().actual, null);
  terminar();
});

test("parar el servicio durante la prueba no cuenta como fallo", async () => {
  const { supervisor, estado, salida } = await armar(
    { "1.3.0": "ok", "1.4.0": "mudo" },
    { actual: "1.4.0", anterior: "1.3.0", probando: true }
  );
  supervisor.iniciar();
  await new Promise((r) => setTimeout(r, 300));
  supervisor.detener();
  assert.equal(await salida, 0);
  const e = estado.leer();
  assert.equal(e.actual, "1.4.0", "sigue pendiente de probar en el próximo arranque");
  assert.deepEqual(e.fallidas, []);
});
