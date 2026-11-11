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

/**
 * @param {{ modo?: "ok"|"colgada"|"incierta"|"sinEstado", estado?: Record<number, number> }} [opciones]
 */
async function crearImpresora(opciones = {}) {
  const impresora = {
    modo: opciones.modo ?? "ok",
    /** Respuesta a DLE EOT n; se puede cambiar en medio de la prueba (abrir tapa, etc.). */
    estado: { ...ESTADO_OK, ...(opciones.estado ?? {}) },
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

/** Contesta los DLE EOT que vengan en `datos` y devuelve el resto (lo que es para imprimir). */
function responderDleEot(datos, impresora, socket) {
  const resto = [];
  for (let i = 0; i < datos.length; i++) {
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

module.exports = { crearImpresora, puertoCerrado, ESTADO_OK };
