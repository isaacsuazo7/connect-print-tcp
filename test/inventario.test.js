"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { consultarIdentidad, leerRespuestaGsI, GS_I } = require("../print-core/inventario/gs-i");
const { TablaOui, SIN_FABRICANTE, prefijoDe } = require("../print-core/inventario/oui");
const { InventarioImpresoras } = require("../print-core/inventario/inventario");
const { SerializadorPorImpresora } = require("../print-core/serializador");
const { ESTADO } = require("../print-core/estado-impresora");
const { leerCsvIeee, camposCsv } = require("../scripts/generar-oui");
const { crearImpresora, puertoCerrado, IDENTIDAD_ITPP047 } = require("./impresora-simulada");

const RAPIDO = { timeoutConexionMs: 300, timeoutRespuestaMs: 150 };
const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
const carpetaTemporal = () => fs.mkdtempSync(path.join(os.tmpdir(), "inventario-"));

// ---------- GS I ----------

test("GS I: lee '_texto\\0', tolera bytes de otra respuesta antes y espera a que llegue completa", () => {
  assert.equal(leerRespuestaGsI(Buffer.from("_ITPP047\0", "latin1")), "ITPP047");
  assert.equal(leerRespuestaGsI(Buffer.concat([Buffer.from([0x16]), Buffer.from("_TM-T20II\0", "latin1")])), "TM-T20II");
  assert.equal(leerRespuestaGsI(Buffer.from("_ITPP0", "latin1")), null, "todavía no llegó el NUL");
  assert.equal(leerRespuestaGsI(Buffer.from("_  \0", "latin1")), null, "vacía = null");
  assert.equal(leerRespuestaGsI(Buffer.from("_A\x01B\0", "latin1")), "AB", "sin caracteres de control");
});

test("GS I: una impresora que lo soporta dice fabricante, modelo, serie y firmware", async () => {
  const impresora = await crearImpresora({ identidad: IDENTIDAD_ITPP047 });
  try {
    const r = await consultarIdentidad(impresora.host, impresora.puerto, RAPIDO);
    assert.deepEqual(r, {
      conecto: true,
      soportaGsI: true,
      fabricante: "ITPP",
      modelo: "ITPP047",
      serie: "P047A2311000123",
      firmware: "1.02 ESC/POS",
    });
    assert.deepEqual(impresora.preguntasGsI, [GS_I.FABRICANTE, GS_I.MODELO, GS_I.SERIE, GS_I.FIRMWARE]);
  } finally {
    await impresora.cerrar();
  }
});

test("GS I: si no contesta la primera no se sigue preguntando, y se manda ESC @ para que no salga impresa", async () => {
  const impresora = await crearImpresora({ identidad: null });
  try {
    const r = await consultarIdentidad(impresora.host, impresora.puerto, RAPIDO);
    assert.equal(r.conecto, true);
    assert.equal(r.soportaGsI, false);
    assert.equal(r.modelo, null);
    assert.deepEqual(impresora.preguntasGsI, [GS_I.FABRICANTE], "una sola pregunta");
    await esperar(100);
    const recibido = Buffer.concat(impresora.trabajos);
    assert.deepEqual([...recibido.subarray(-2)], [0x1b, 0x40], "termina con ESC @ (vacía el búfer)");
  } finally {
    await impresora.cerrar();
  }
});

test("GS I: apagada = no conectó (se vuelve a intentar después)", async () => {
  const r = await consultarIdentidad("127.0.0.1", await puertoCerrado(), RAPIDO);
  assert.equal(r.conecto, false);
  assert.equal(r.soportaGsI, false);
});

// ---------- OUI ----------

test("OUI: la tabla embebida reconoce a Epson y distingue sin MAC, MAC local y prefijo no registrado", () => {
  const tabla = new TablaOui({ archivoCorrecciones: null });
  assert.ok(tabla.tamano > 30000, `tabla con ${tabla.tamano} prefijos`);
  assert.deepEqual(tabla.buscar("50-57-9c-11-22-33"), { fabricante: "Seiko Epson Corporation", motivo: null });
  // "oficina" (11-nov-2026): el prefijo de su MAC no está registrado en la IEEE.
  assert.deepEqual(tabla.buscar("00:61:A2:66:41:AB"), { fabricante: null, motivo: SIN_FABRICANTE.NO_REGISTRADO });
  assert.deepEqual(tabla.buscar("02:11:22:33:44:55"), { fabricante: null, motivo: SIN_FABRICANTE.LOCAL });
  assert.deepEqual(tabla.buscar(null), { fabricante: null, motivo: SIN_FABRICANTE.SIN_MAC });
  assert.equal(prefijoDe("aa-bb-cc-dd-ee-ff"), "AABBCC");
});

test("OUI: las correcciones de la nube mandan sobre la tabla, se guardan y sobreviven un reinicio", () => {
  const archivo = path.join(carpetaTemporal(), "fabricantes-oui.json");
  const tabla = new TablaOui({ datos: null, archivoCorrecciones: archivo });
  tabla.aplicarCorrecciones([
    { Prefijo: "00:61:A2", Fabricante: "ITPP (clon)" },
    { Prefijo: "zz", Fabricante: "basura" },
    { Prefijo: "AABBCC", Fabricante: "" },
  ]);
  assert.equal(tabla.buscar("00:61:A2:66:41:AB").fabricante, "ITPP (clon)");

  const despuesDeReiniciar = new TablaOui({ datos: null, archivoCorrecciones: archivo });
  assert.equal(despuesDeReiniciar.buscar("00:61:A2:66:41:AB").fabricante, "ITPP (clon)");
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(archivo, "utf8"))), ["0061A2"], "lo inválido no se guarda");

  despuesDeReiniciar.aplicarCorrecciones([]);
  assert.equal(despuesDeReiniciar.buscar("00:61:A2:66:41:AB").motivo, SIN_FABRICANTE.NO_REGISTRADO, "la nube la quitó");
});

test("generar-oui: lee el CSV de la IEEE con comas entre comillas y se queda solo con MA-L", () => {
  assert.deepEqual(camposCsv('MA-L,286FB9,"Nokia, Inc.","Calle 1, Ciudad"'), ["MA-L", "286FB9", "Nokia, Inc.", "Calle 1, Ciudad"]);
  const tabla = leerCsvIeee(
    [
      "Registry,Assignment,Organization Name,Organization Address",
      'MA-L,50579C,Seiko Epson Corporation,"3-3-5 Owa, Suwa"',
      'MA-L,00AABB,"Star  Micronics, Co.",x',
      "MA-M,ABCDEF1,Otro,x",
      "MA-L,XYZ,Mal,x",
    ].join("\r\n")
  );
  assert.deepEqual([...tabla], [
    ["50579C", "Seiko Epson Corporation"],
    ["00AABB", "Star Micronics, Co."],
  ]);
});

// ---------- inventario ----------

function armar({ impresoras, estados, consultar, estaOcupado, archivo = null, ahora }) {
  const registro = { lista: () => impresoras };
  const monitor = { estadoDe: (imp) => estados[imp.clave] ?? { estado: ESTADO.DESCONOCIDO, soportaEstado: null } };
  const llamadas = [];
  const inventario = new InventarioImpresoras({
    archivo,
    registro,
    monitor,
    serializador: new SerializadorPorImpresora(),
    tablaOui: new TablaOui({ archivoCorrecciones: null }),
    consultar: async (ip, puerto) => {
      llamadas.push(`${ip}:${puerto}`);
      return consultar(ip, puerto);
    },
    estaOcupado,
    ahora,
  });
  return { inventario, llamadas };
}

const ITPP = { clave: "cod:977", codImpresora: 977, nombre: "oficina", mac: "00:61:A2:66:41:AB", ip: "10.0.30.243", puerto: 9100 };
const CLON = { clave: "cod:1301", codImpresora: 1301, nombre: "barra", mac: "50:57:9C:00:00:01", ip: "10.0.30.20", puerto: 9100 };
const SIN_MAC = { clave: "ip:10.0.30.30:9100", codImpresora: null, nombre: null, mac: null, ip: "10.0.30.30", puerto: 9100 };
const ONLINE_CON_ESTADO = { estado: ESTADO.ONLINE, soportaEstado: true };
const respuestaItpp = async () => ({ conecto: true, soportaGsI: true, fabricante: "ITPP", modelo: "ITPP047", serie: "S1", firmware: "1.02" });

test("inventario: solo pregunta a las que tienen MAC y contestan DLE EOT, y lo manda en el heartbeat", async () => {
  let reloj = Date.parse("2026-11-16T15:00:00Z");
  const { inventario, llamadas } = armar({
    impresoras: [ITPP, CLON, SIN_MAC],
    estados: {
      [ITPP.clave]: ONLINE_CON_ESTADO,
      [CLON.clave]: { estado: ESTADO.ONLINE, soportaEstado: false }, // clon sin DLE EOT
      [SIN_MAC.clave]: ONLINE_CON_ESTADO,
    },
    consultar: respuestaItpp,
    ahora: () => reloj,
  });

  await inventario.revisarTodas();

  assert.deepEqual(llamadas, ["10.0.30.243:9100"]);
  assert.deepEqual(inventario.datosDe(ITPP), {
    FabricanteOui: null,
    SinFabricanteOui: SIN_FABRICANTE.NO_REGISTRADO,
    Fabricante: "ITPP",
    Modelo: "ITPP047",
    Serie: "S1",
    Firmware: "1.02",
    SoportaDleEot: true,
    SoportaGsI: true,
  });
  // Criterio de aceptación: la que no soporta GS I aparece con fabricante por OUI y modelo vacío.
  assert.deepEqual(inventario.datosDe(CLON), {
    FabricanteOui: "Seiko Epson Corporation",
    SinFabricanteOui: null,
    Fabricante: null,
    Modelo: null,
    Serie: null,
    Firmware: null,
    SoportaDleEot: false,
    SoportaGsI: null,
  });
});

test("inventario: no vuelve a preguntar antes de 24 h, sí después", async () => {
  let reloj = Date.parse("2026-11-16T15:00:00Z");
  const { inventario, llamadas } = armar({
    impresoras: [ITPP],
    estados: { [ITPP.clave]: ONLINE_CON_ESTADO },
    consultar: respuestaItpp,
    ahora: () => reloj,
  });
  await inventario.revisarTodas();
  reloj += 23 * 3600 * 1000;
  await inventario.revisarTodas();
  assert.equal(llamadas.length, 1);
  reloj += 2 * 3600 * 1000;
  await inventario.revisarTodas();
  assert.equal(llamadas.length, 2);
});

test("inventario: con impresiones en curso no pregunta; apagada justo ahora se reintenta en la próxima vuelta", async () => {
  let ocupado = true;
  let conecta = false;
  const { inventario, llamadas } = armar({
    impresoras: [ITPP],
    estados: { [ITPP.clave]: ONLINE_CON_ESTADO },
    consultar: async () => (conecta ? respuestaItpp() : { conecto: false, soportaGsI: false }),
    estaOcupado: () => ocupado,
    ahora: () => Date.parse("2026-11-16T15:00:00Z"),
  });
  await inventario.revisarTodas();
  assert.equal(llamadas.length, 0, "ocupado");

  ocupado = false;
  await inventario.revisarTodas();
  assert.equal(llamadas.length, 1);
  assert.equal(inventario.datosDe(ITPP).SoportaGsI, null, "no conectó: no se sabe");

  conecta = true;
  await inventario.revisarTodas();
  assert.equal(inventario.datosDe(ITPP).Modelo, "ITPP047");
});

test("inventario: lo guarda por MAC y un reinicio no vuelve a preguntar", async () => {
  const archivo = path.join(carpetaTemporal(), "inventario.json");
  const ahora = () => Date.parse("2026-11-16T15:00:00Z");
  const primero = armar({ impresoras: [ITPP], estados: { [ITPP.clave]: ONLINE_CON_ESTADO }, consultar: respuestaItpp, archivo, ahora });
  await primero.inventario.revisarTodas();

  const segundo = armar({ impresoras: [ITPP], estados: { [ITPP.clave]: ONLINE_CON_ESTADO }, consultar: respuestaItpp, archivo, ahora });
  await segundo.inventario.revisarTodas();
  assert.equal(segundo.llamadas.length, 0);
  assert.equal(segundo.inventario.datosDe(ITPP).Modelo, "ITPP047");
});

test("inventario: contra la impresora simulada, de punta a punta", async () => {
  const impresora = await crearImpresora({ identidad: IDENTIDAD_ITPP047 });
  try {
    const imp = { ...ITPP, ip: impresora.host, puerto: impresora.puerto };
    const inventario = new InventarioImpresoras({
      archivo: null,
      registro: { lista: () => [imp] },
      monitor: { estadoDe: () => ONLINE_CON_ESTADO },
      serializador: new SerializadorPorImpresora(),
      tablaOui: new TablaOui({ archivoCorrecciones: null }),
    });
    await inventario.revisarTodas();
    assert.equal(inventario.datosDe(imp).Modelo, "ITPP047");
    assert.equal(impresora.trabajos.length, 0, "no imprimió nada");
  } finally {
    await impresora.cerrar();
  }
});
