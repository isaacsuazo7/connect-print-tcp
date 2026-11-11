"use strict";
// Envío de un trabajo a una impresora de red (puerto 9100, ESC/POS). Brief §6.2.3 / §7.2.
//
// Un socket nuevo por trabajo, nunca conexiones vivas (después de un corte quedan muertas). El resultado
// es real: "impreso" solo cuando la impresora cerró su lado de la conexión, que es cuando ya leyó todo lo
// que le mandamos (medido con la impresora "oficina": cierra a los ~6 ms). Antes el servicio respondía
// "Impresión exitosa" apenas podía escribir (hallazgo P3) y tardaba 21 s en avisar que estaba apagada (R6).

const net = require("net");

/** Conectar a una impresora encendida en la LAN toma milisegundos; 2 s ya es "no está". */
const TIMEOUT_CONEXION_MS = 2000;
/** Tiempo total para que la impresora lea todo y cierre su lado. Más que esto = colgada. */
const TIMEOUT_TOTAL_MS = 10000;

/**
 * Resultados posibles:
 * - impreso: la impresora leyó todo y cerró su lado.
 * - fallido: no se pudo conectar; no se mandó nada, se puede reintentar sin duplicar.
 * - incierto: se mandaron datos pero no hubo confirmación. NO reintentar solo: si la impresora sí lo
 *   imprimió, saldría dos veces. (La tarea pide "failed / printer_hung" para la colgada; se deja como
 *   incierto para no duplicar tickets con impresoras que no cierran su lado.)
 */
const RESULTADO = Object.freeze({ IMPRESO: "impreso", FALLIDO: "fallido", INCIERTO: "incierto" });

const ERROR = Object.freeze({
  SIN_CONEXION: "printer_offline",
  COLGADA: "printer_hung",
  CORTADA: "connection_lost",
});

/**
 * Manda `datos` a host:puerto y espera la confirmación.
 * @param {{ host: string, puerto: number, datos: Uint8Array }} trabajo
 * @param {{ timeoutConexionMs?: number, timeoutTotalMs?: number }} [opciones] solo para pruebas
 * @returns {Promise<{ resultado: string, error: string | null, detalle: string, ms: number }>}
 */
function enviarTrabajo(trabajo, opciones = {}) {
  const timeoutConexionMs = opciones.timeoutConexionMs ?? TIMEOUT_CONEXION_MS;
  const timeoutTotalMs = opciones.timeoutTotalMs ?? TIMEOUT_TOTAL_MS;
  const inicio = Date.now();

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let conectado = false;
    let terminado = false;

    const terminar = (resultado, error, detalle) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(timerConexion);
      clearTimeout(timerTotal);
      socket.destroy();
      resolve({ resultado, error, detalle, ms: Date.now() - inicio });
    };

    const timerConexion = setTimeout(() => {
      terminar(RESULTADO.FALLIDO, ERROR.SIN_CONEXION, `No conectó en ${timeoutConexionMs / 1000} s`);
    }, timeoutConexionMs);

    const timerTotal = setTimeout(() => {
      terminar(
        RESULTADO.INCIERTO,
        ERROR.COLGADA,
        `La impresora aceptó la conexión pero no confirmó en ${timeoutTotalMs / 1000} s`
      );
    }, timeoutTotalMs);

    socket.on("connect", () => {
      conectado = true;
      clearTimeout(timerConexion);
      socket.write(Buffer.from(datosComoBuffer(trabajo.datos)));
      // Fin de nuestro lado; la impresora responde con su propio fin cuando terminó de leer.
      socket.end();
    });

    // Fin del lado de la impresora = leyó todo.
    socket.on("end", () => terminar(RESULTADO.IMPRESO, null, "OK"));

    socket.on("close", (huboError) => {
      if (huboError) return; // lo resuelve "error"
      terminar(RESULTADO.IMPRESO, null, "OK");
    });

    socket.on("error", (e) => {
      if (!conectado) {
        terminar(RESULTADO.FALLIDO, ERROR.SIN_CONEXION, `No se pudo conectar (${e.code || e.message})`);
        return;
      }
      terminar(RESULTADO.INCIERTO, ERROR.CORTADA, `Se cortó la conexión a mitad (${e.code || e.message})`);
    });

    socket.connect({ host: trabajo.host, port: trabajo.puerto });
  });
}

/** @param {Uint8Array | Buffer} datos */
function datosComoBuffer(datos) {
  if (Buffer.isBuffer(datos)) return datos;
  return Buffer.from(datos.buffer, datos.byteOffset, datos.byteLength);
}

module.exports = { enviarTrabajo, RESULTADO, ERROR, TIMEOUT_CONEXION_MS, TIMEOUT_TOTAL_MS };
