"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { HeartbeatNube, MAXIMO_EVENTOS } = require("../print-core/nube/heartbeat");
const { IdentidadAgente } = require("../print-core/identidad-agente");

const LLAVE = "llave-de-prueba-123456";

function identidadVinculada() {
  const id = new IdentidadAgente(null);
  id.vincular({ codAgente: 34, llave: LLAVE, apiUrl: "https://qaposapi.yalocobro.com/api" });
  return id;
}

/** Nube falsa: guarda los pedidos y contesta lo que diga `responder`. */
function nubeFalsa(responder = () => ({ status: 200, json: { success: true, data: { IntervaloSegundos: 30, Impresoras: [] } } })) {
  const pedidos = [];
  const fetch = async (url, opciones) => {
    pedidos.push({ url, headers: opciones.headers, cuerpo: JSON.parse(opciones.body) });
    const r = responder(pedidos.length);
    if (r instanceof Error) throw r;
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.json };
  };
  return { fetch, pedidos };
}

const REPORTE = { Version: "1.3.0", NombreEquipo: "CAJA", IpLocal: "10.0.30.244", Puerto: 3000, Impresoras: [] };

test("manda al endpoint de la API con X-Agente-Id y X-Agente-Llave, y aplica la respuesta", async () => {
  const identidad = identidadVinculada();
  const respuestas = [];
  const nube = nubeFalsa(() => ({
    status: 200,
    json: { success: true, data: { IntervaloSegundos: 45, Impresoras: [{ CodImpresora: 977, Nombre: "oficina", Ip: "10.0.30.243", Puerto: "9100" }] } },
  }));
  const hb = new HeartbeatNube({ identidad, armarReporte: () => REPORTE, alResponder: (d) => respuestas.push(d), fetch: nube.fetch });
  assert.equal(await hb.enviar(), true);
  hb.detener();
  const [p] = nube.pedidos;
  assert.equal(p.url, "https://qaposapi.yalocobro.com/api/Impresoras/Agentes/Heartbeat");
  assert.equal(p.headers["X-Agente-Id"], identidad.idAgente);
  assert.equal(p.headers["X-Agente-Llave"], LLAVE);
  assert.equal(p.cuerpo.IpLocal, "10.0.30.244");
  assert.equal(respuestas[0].Impresoras[0].CodImpresora, 977);
  assert.equal(hb.intervaloMs, 45000, "usa el intervalo que dice la nube");
});

test("sin vincular no manda nada (y no es un error)", async () => {
  const nube = nubeFalsa();
  const hb = new HeartbeatNube({ identidad: new IdentidadAgente(null), armarReporte: () => REPORTE, fetch: nube.fetch });
  assert.equal(await hb.enviar(), true);
  hb.detener();
  assert.equal(nube.pedidos.length, 0);
});

test("sin internet: no tira error, guarda los eventos y los manda al volver", async () => {
  let hayInternet = false;
  const nube = nubeFalsa(() => (hayInternet ? { status: 200, json: { success: true, data: { IntervaloSegundos: 30 } } } : new TypeError("fetch failed")));
  const hb = new HeartbeatNube({ identidad: identidadVinculada(), armarReporte: () => REPORTE, fetch: nube.fetch });
  hb.evento("printer_state_changed", { CodImpresora: 977, De: "online", A: "offline" });
  assert.equal(await hb.enviar(), false);
  assert.equal(hb.esperaTrasFallo(), 5000);
  hb.evento("printer_state_changed", { CodImpresora: 977, De: "offline", A: "online", FlushedJobs: 3 });
  assert.equal(await hb.enviar(), false);
  assert.equal(hb.esperaTrasFallo(), 15000, "espera creciente");
  hayInternet = true;
  assert.equal(await hb.enviar(), true);
  hb.detener();
  const ultimo = nube.pedidos[nube.pedidos.length - 1];
  assert.deepEqual(ultimo.cuerpo.Eventos.map((e) => e.A), ["offline", "online"]);
  assert.equal(ultimo.cuerpo.Eventos[1].FlushedJobs, 3);
  assert.equal(hb.eventos.length, 0, "se vacía la cola al llegar");
});

test("la cola de eventos tiene tope (se descartan los más viejos)", () => {
  const hb = new HeartbeatNube({ identidad: identidadVinculada(), armarReporte: () => REPORTE, fetch: nubeFalsa().fetch });
  for (let i = 0; i < MAXIMO_EVENTOS + 50; i++) hb.evento("x", { N: i });
  hb.detener();
  assert.equal(hb.eventos.length, MAXIMO_EVENTOS);
  assert.equal(hb.eventos[0].N, 50);
});

test("eventos que llegan mientras se envía no se pierden", async () => {
  let hb;
  const nube = nubeFalsa(() => {
    hb.evento("agent_ip_changed", { Nueva: "10.0.30.99" }); // entra a mitad del envío
    return { status: 200, json: { success: true, data: {} } };
  });
  hb = new HeartbeatNube({ identidad: identidadVinculada(), armarReporte: () => REPORTE, fetch: nube.fetch });
  hb.evento("agent_started");
  await hb.enviar();
  hb.detener();
  assert.deepEqual(hb.eventos.map((e) => e.Tipo), ["agent_ip_changed"]);
});

test("llave rechazada 3 veces seguidas: se desvincula (el POS lo revincula en Reconectar)", async () => {
  const identidad = identidadVinculada();
  const nube = nubeFalsa(() => ({ status: 401, json: { success: false } }));
  const hb = new HeartbeatNube({ identidad, armarReporte: () => REPORTE, fetch: nube.fetch });
  await hb.enviar();
  await hb.enviar();
  assert.equal(identidad.vinculado, true, "un par de 401 no alcanza");
  await hb.enviar();
  hb.detener();
  assert.equal(identidad.vinculado, false);
});

test("un error al aplicar la respuesta no rompe el heartbeat", async () => {
  const hb = new HeartbeatNube({
    identidad: identidadVinculada(),
    armarReporte: () => REPORTE,
    alResponder: () => {
      throw new Error("boom");
    },
    fetch: nubeFalsa().fetch,
  });
  assert.equal(await hb.enviar(), true);
  hb.detener();
});
