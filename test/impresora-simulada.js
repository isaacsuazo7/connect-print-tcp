"use strict";
// Impresora ESC/POS falsa para las pruebas automáticas. Escucha en 127.0.0.1 en un puerto libre.
// Modos:
//  ok        lee todo y cierra su lado (como "oficina").
//  colgada   acepta la conexión y nunca lee ni cierra (firmware trabado).
//  incierta  lee un poco y corta la conexión de golpe (RST).
//  sinEstado ok, pero no contesta DLE EOT (clon que no lo soporta).
// "apagada" = puerto sin nadie escuchando (ver puertoCerrado()).

const net = require("net");

/** Respuestas DLE EOT de "oficina" con todo bien (medidas el 11-nov-2026). */
const ESTADO_OK = Object.freeze({ 1: 0x16, 2: 0x12, 3: 0x12, 4: 0x12 });

/** Respuestas a GS I n de una impresora que lo soporta (65 firmware, 66 fabricante, 67 modelo, 68 serie). */
const IDENTIDAD_ITPP047 = Object.freeze({ 65: "1.02 ESC/POS", 66: "ITPP", 67: "ITPP047", 68: "P047A2311000123" });

/**
 * @param {{ modo?: "ok"|"colgada"|"incierta"|"sinEstado", estado?: Record<number, number>,
 *           identidad?: Record<number, string> | null }} [opciones]
 *   identidad: respuestas a GS I; null (por defecto) = no contesta GS I.
 */
async function crearImpresora(opciones = {}) {
  const impresora = {
    modo: opciones.modo ?? "ok",
    /** Respuesta a DLE EOT n; se puede cambiar en medio de la prueba (abrir tapa, etc.). */
    estado: { ...ESTADO_OK, ...(opciones.estado ?? {}) },
    identidad: opciones.identidad ?? null,
    /** Preguntas GS I recibidas (n). */
    preguntasGsI: [],
    /** Bytes recibidos por trabajo, sin las consultas DLE EOT. */
    trabajos: [],
    conexiones: 0,
  };
  const sockets = new Set();

  const servidor = net.createServer((socket) => {
    impresora.conexiones++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);

    if (impresora.modo === "colgada") {
      socket.pause();
      return;
    }
    const recibido = [];
    socket.on("data", (datos) => {
      if (impresora.modo === "incierta") {
        socket.resetAndDestroy();
        return;
      }
      const resto = responderDleEot(datos, impresora, socket);
      if (resto.length) recibido.push(resto);
    });
    socket.on("end", () => {
      if (recibido.length) impresora.trabajos.push(Buffer.concat(recibido));
      socket.end();
    });
  });

  await new Promise((ok) => servidor.listen(0, "127.0.0.1", ok));
  impresora.host = "127.0.0.1";
  impresora.puerto = servidor.address().port;
  impresora.cerrar = () =>
    new Promise((ok) => {
      sockets.forEach((s) => s.destroy());
      servidor.close(() => ok());
    });
  return impresora;
}

/**
 * Contesta los DLE EOT (y GS I si tiene identidad) que vengan en `datos` y devuelve el resto (lo que es
 * para imprimir). Un GS I sin identidad queda en el resto: como un clon, lo "imprimiría".
 */
function responderDleEot(datos, impresora, socket) {
  const resto = [];
  for (let i = 0; i < datos.length; i++) {
    const esGsI = datos[i] === 0x1d && datos[i + 1] === 0x49 && i + 2 < datos.length;
    if (esGsI) impresora.preguntasGsI.push(datos[i + 2]);
    if (esGsI && impresora.identidad) {
      const texto = impresora.identidad[datos[i + 2]] ?? "";
      socket.write(Buffer.concat([Buffer.from([0x5f]), Buffer.from(texto, "latin1"), Buffer.from([0x00])]));
      i += 2;
      continue;
    }
    const esDleEot = datos[i] === 0x10 && datos[i + 1] === 0x04 && datos[i + 2] >= 1 && datos[i + 2] <= 4;
    if (!esDleEot) {
      resto.push(datos[i]);
      continue;
    }
    if (impresora.modo !== "sinEstado") socket.write(Buffer.from([impresora.estado[datos[i + 2]]]));
    i += 2;
  }
  return Buffer.from(resto);
}

/** Un puerto en el que no escucha nadie = impresora apagada (rechaza al instante). */
async function puertoCerrado() {
  const s = net.createServer();
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok));
  const puerto = s.address().port;
  await new Promise((ok) => s.close(ok));
  return puerto;
}

module.exports = { crearImpresora, puertoCerrado, ESTADO_OK, IDENTIDAD_ITPP047 };
