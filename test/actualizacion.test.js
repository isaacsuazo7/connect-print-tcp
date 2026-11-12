"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { compararVersiones, esMasNueva, esVersionValida } = require("../print-core/actualizacion/version");
const { firmar, firmaValida } = require("../print-core/actualizacion/firma");
const { EstadoVersiones } = require("../print-core/actualizacion/estado-versiones");
const {
  Actualizador, parsearVentana, dentroDeVentana, NOMBRE_EXE, SIN_IMPRESIONES_MS, ESTADO_PENDIENTE,
} = require("../print-core/actualizacion/actualizador");

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const CLAVE_PUBLICA = publicKey.export({ type: "spki", format: "pem" });
const CLAVE_PRIVADA = privateKey.export({ type: "pkcs8", format: "pem" });

const EXE_NUEVO = Buffer.from("MZ...binario de la version nueva...");
const SHA_NUEVO = crypto.createHash("sha256").update(EXE_NUEVO).digest("hex");

const carpetaTemporal = () => fs.mkdtempSync(path.join(os.tmpdir(), "yalo-actualizacion-"));

function oferta(cambios = {}) {
  const version = cambios.Version || "1.4.0";
  const sha = cambios.Sha256 || SHA_NUEVO;
  return { Version: version, Url: "https://descargas.yalo.test/agente.exe", Sha256: sha, Firma: firmar(CLAVE_PRIVADA, version, sha), ...cambios };
}

/** Actualizador con todo falso: servidor de descargas, ocupación y reinicio. */
function armar({ raiz = carpetaTemporal(), ocupado = false, sinImprimirMs = SIN_IMPRESIONES_MS, contenido = EXE_NUEVO, status = 200, ahora } = {}) {
  const registro = { descargas: 0, reinicios: 0, eventos: [], ocupado, sinImprimirMs };
  const act = new Actualizador({
    raiz,
    versionActual: "1.3.0",
    clavePublica: CLAVE_PUBLICA,
    estaOcupado: () => registro.ocupado,
    msDesdeUltimaImpresion: () => registro.sinImprimirMs,
    reiniciar: () => registro.reinicios++,
    evento: (tipo, datos) => registro.eventos.push({ tipo, ...datos }),
    fetch: async () => {
      registro.descargas++;
      return new Response(status === 200 ? contenido : "no", { status });
    },
    ahora,
  });
  return { act, raiz, registro, estado: new EstadoVersiones(raiz) };
}

test("versiones: solo mayor.menor.parche, comparación numérica", () => {
  assert.equal(esVersionValida("1.10.0"), true);
  assert.equal(esVersionValida("1.4.0-beta"), false);
  assert.equal(esVersionValida("../../x"), false);
  assert.ok(compararVersiones("1.10.0", "1.9.9") > 0);
  assert.equal(compararVersiones("1.3.0", "1.3.0"), 0);
  assert.equal(esMasNueva("1.3.1", "1.3.0"), true);
  assert.equal(esMasNueva("1.2.9", "1.3.0"), false);
  assert.equal(esMasNueva(undefined, "1.3.0"), false);
});

test("firma: válida solo con la clave correcta y la misma versión y SHA", () => {
  const firma = firmar(CLAVE_PRIVADA, "1.4.0", SHA_NUEVO);
  assert.equal(firmaValida(CLAVE_PUBLICA, "1.4.0", SHA_NUEVO, firma), true);
  assert.equal(firmaValida(CLAVE_PUBLICA, "1.4.1", SHA_NUEVO, firma), false, "otra versión");
  assert.equal(firmaValida(CLAVE_PUBLICA, "1.4.0", "0".repeat(64), firma), false, "otro archivo");
  const otra = crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  assert.equal(firmaValida(otra, "1.4.0", SHA_NUEVO, firma), false, "otra clave");
  assert.equal(firmaValida(CLAVE_PUBLICA, "1.4.0", SHA_NUEVO, "basura"), false);
  assert.equal(firmaValida(CLAVE_PUBLICA, "1.4.0", SHA_NUEVO, undefined), false);
});

test("ventana de actualización: horario normal y cruzando la medianoche", () => {
  const a = (h, m) => new Date(2026, 10, 11, h, m);
  const madrugada = parsearVentana("02:00-05:00");
  assert.equal(dentroDeVentana(madrugada, a(3, 30)), true);
  assert.equal(dentroDeVentana(madrugada, a(5, 0)), false);
  assert.equal(dentroDeVentana(madrugada, a(13, 0)), false);
  const noche = parsearVentana("22:00-05:00");
  assert.equal(dentroDeVentana(noche, a(23, 10)), true);
  assert.equal(dentroDeVentana(noche, a(1, 0)), true);
  assert.equal(dentroDeVentana(noche, a(12, 0)), false);
  assert.equal(parsearVentana("25:00-05:00"), null);
  assert.equal(dentroDeVentana(parsearVentana(null), a(12, 0)), true, "sin ventana: a cualquier hora");
});

test("oferta válida: descarga, verifica y aplica cuando no hay impresiones", async () => {
  const { act, raiz, registro, estado } = armar();
  await act.ofrecer(oferta());
  assert.equal(registro.descargas, 1);
  assert.deepEqual(fs.readFileSync(path.join(raiz, "versions", "1.4.0", NOMBRE_EXE)), EXE_NUEVO);
  assert.equal(registro.reinicios, 1);
  const e = estado.leer();
  assert.equal(e.actual, "1.4.0");
  assert.equal(e.anterior, "1.3.0");
  assert.equal(e.probando, true);
});

test("no actualiza con trabajos en curso ni recién impreso; sí cuando se libera", async () => {
  const { act, registro, estado } = armar({ ocupado: true });
  await act.ofrecer(oferta());
  assert.equal(registro.reinicios, 0, "hay trabajos");
  assert.equal(act.pendiente.estado, ESTADO_PENDIENTE.ESPERANDO);

  registro.ocupado = false;
  registro.sinImprimirMs = 5000;
  await act.avanzar();
  assert.equal(registro.reinicios, 0, "imprimió hace 5 s");

  registro.sinImprimirMs = SIN_IMPRESIONES_MS;
  await act.avanzar();
  assert.equal(registro.reinicios, 1);
  assert.equal(registro.descargas, 1, "no vuelve a descargar");
  assert.equal(estado.leer().actual, "1.4.0");
});

test("fuera de la ventana no aplica", async () => {
  const { act, registro } = armar({ ahora: () => new Date(2026, 10, 11, 14, 0) });
  await act.ofrecer(oferta({ Ventana: "02:00-05:00" }));
  assert.equal(registro.descargas, 1, "descarga igual (en segundo plano)");
  assert.equal(registro.reinicios, 0);
});

test("firma inválida: no descarga nada y avisa una sola vez", async () => {
  const { act, registro } = armar();
  const mala = oferta({ Firma: firmar(CLAVE_PRIVADA, "9.9.9", SHA_NUEVO) });
  await act.ofrecer(mala);
  await act.ofrecer(mala);
  assert.equal(registro.descargas, 0);
  assert.equal(registro.eventos.filter((e) => e.tipo === "update_rejected").length, 1);
  assert.deepEqual(act.resumen().VersionesFallidas, ["1.4.0"], "la nube deja de ofrecerla");
});

test("firma inválida: queda como fallida y una corrección más vieja sí llega", async () => {
  const { act, registro } = armar();
  await act.ofrecer(oferta({ Version: "1.5.0", Firma: firmar(CLAVE_PRIVADA, "9.9.9", SHA_NUEVO) }));
  // La nube ya no ofrece 1.5.0 (está en VersionesFallidas) y ofrece la 1.4.0 bien firmada.
  await act.ofrecer(oferta({ Version: "1.4.0" }));
  assert.equal(registro.reinicios, 1);
});

test("SHA distinto 3 veces seguidas: el archivo publicado está mal, queda como fallida", async () => {
  const { act, registro } = armar({ contenido: Buffer.from("otro exe") });
  await act.ofrecer(oferta());
  for (let i = 0; i < 2; i++) {
    act.pendiente.reintentarDesde = 0; // sin esperar los 5 min
    await act.avanzar();
  }
  assert.equal(registro.descargas, 3);
  assert.equal(act.pendiente, null);
  assert.deepEqual(act.resumen().VersionesFallidas, ["1.4.0"]);
  const rechazo = registro.eventos.find((e) => e.tipo === "update_rejected");
  assert.match(rechazo.Motivo, /SHA-256\) en 3 descargas/);
  await act.ofrecer(oferta());
  assert.equal(registro.descargas, 3, "no la vuelve a intentar");
});

test("el archivo descargado no coincide con el SHA firmado: se borra y no aplica", async () => {
  const { act, raiz, registro } = armar({ contenido: Buffer.from("otro exe, alterado en el servidor") });
  await act.ofrecer(oferta());
  assert.equal(registro.reinicios, 0);
  assert.equal(fs.existsSync(path.join(raiz, "versions", "1.4.0", NOMBRE_EXE)), false);
  assert.equal(fs.existsSync(path.join(raiz, "versions", "1.4.0", `${NOMBRE_EXE}.descarga`)), false);
  assert.equal(act.pendiente.estado, ESTADO_PENDIENTE.DESCARGANDO, "se reintenta más tarde");
});

test("servidor de descargas caído: reintenta más tarde, no reinicia", async () => {
  const { act, registro } = armar({ status: 503 });
  await act.ofrecer(oferta());
  await act.avanzar();
  assert.equal(registro.descargas, 1, "espera 5 min antes del siguiente intento");
  assert.equal(registro.reinicios, 0);
});

test("ignora la misma versión, una más vieja y una que ya hizo rollback", async () => {
  const { act, registro, estado } = armar();
  await act.ofrecer(oferta({ Version: "1.3.0" }));
  await act.ofrecer(oferta({ Version: "1.2.0" }));
  estado.escribir({ ...estado.leer(), fallidas: ["1.4.0"] });
  await act.ofrecer(oferta());
  assert.equal(registro.descargas, 0);
  assert.equal(act.pendiente, null);
});

test("si la nube deja de ofrecerla antes de aplicar, se cancela", async () => {
  const { act, registro } = armar({ ocupado: true });
  await act.ofrecer(oferta());
  await act.ofrecer(null);
  registro.ocupado = false;
  await act.avanzar();
  assert.equal(act.pendiente, null);
  assert.equal(registro.reinicios, 0);
});

test("al arrancar reporta el resultado una sola vez y borra versiones viejas", () => {
  const raiz = carpetaTemporal();
  const estado = new EstadoVersiones(raiz);
  for (const v of ["1.1.0", "1.2.0", "1.3.0"]) fs.mkdirSync(path.join(raiz, "versions", v), { recursive: true });
  estado.escribir({
    actual: "1.3.0", anterior: "1.2.0", probando: false, fallidas: ["1.2.5"],
    ultimoResultado: { version: "1.3.0", de: "1.2.0", resultado: "ok", motivo: null, ts: "2026-11-11T10:00:00Z", reportado: false },
  });
  const { act, registro } = armar({ raiz });
  act.iniciar();
  act.detener();
  assert.deepEqual(registro.eventos, [{ tipo: "update_succeeded", De: "1.2.0", A: "1.3.0", Motivo: null }]);
  assert.equal(estado.leer().ultimoResultado.reportado, true);
  assert.deepEqual(fs.readdirSync(path.join(raiz, "versions")).sort(), ["1.2.0", "1.3.0"]);

  const segundo = armar({ raiz });
  segundo.act.iniciar();
  segundo.act.detener();
  assert.equal(segundo.registro.eventos.length, 0, "ya estaba reportado");
});

test("versión nueva: el supervisor la confirma DESPUÉS de que arrancó; el ok se reporta en la vuelta siguiente", () => {
  // Visto en la prueba real en dev: la 1.3.1 arrancó 2 s antes de ser confirmada y no avisaba update_succeeded.
  const raiz = carpetaTemporal();
  const estado = new EstadoVersiones(raiz);
  estado.escribir({
    actual: "1.4.0", anterior: "1.3.0", probando: true, fallidas: [],
    ultimoResultado: { version: "1.3.2", de: "1.3.0", resultado: "fallo", motivo: "x", ts: "x", reportado: true },
  });
  const { act, registro } = armar({ raiz });
  act.iniciar();
  assert.equal(registro.eventos.length, 0, "todavía en prueba");

  estado.modificar((e) => ({
    ...e, probando: false,
    ultimoResultado: { version: "1.4.0", de: "1.3.0", resultado: "ok", motivo: null, ts: "y", reportado: false },
  }));
  act.reportarResultado();
  act.reportarResultado();
  act.detener();
  assert.deepEqual(registro.eventos, [{ tipo: "update_succeeded", De: "1.3.0", A: "1.4.0", Motivo: null }]);
});

test("rollback reportado como update_failed con el motivo", () => {
  const raiz = carpetaTemporal();
  new EstadoVersiones(raiz).escribir({
    actual: "1.3.0", anterior: null, probando: false, fallidas: ["1.4.0"],
    ultimoResultado: { version: "1.4.0", de: "1.3.0", resultado: "fallo", motivo: "no respondió /health en 60 s", ts: "x", reportado: false },
  });
  const { act, registro } = armar({ raiz });
  act.iniciar();
  act.detener();
  assert.deepEqual(registro.eventos, [{ tipo: "update_failed", De: "1.3.0", A: "1.4.0", Motivo: "no respondió /health en 60 s" }]);
  assert.equal(act.resumen().UltimaActualizacion.Resultado, "fallo");
  assert.deepEqual(act.resumen().VersionesFallidas, ["1.4.0"], "para que la nube no la vuelva a ofrecer");
});

test("actualizacion.json ilegible = estado vacío (se corre la versión del instalador)", () => {
  const raiz = carpetaTemporal();
  fs.writeFileSync(path.join(raiz, "actualizacion.json"), "{ esto no es json");
  const e = new EstadoVersiones(raiz).leer();
  assert.equal(e.actual, null);
  assert.deepEqual(e.fallidas, []);
});
