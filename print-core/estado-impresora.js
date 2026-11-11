"use strict";
// Consulta de estado en tiempo real de una impresora ESC/POS: DLE EOT n (0x10 0x04 n). Brief §6.2.3.
// Probado con la impresora "oficina" (11-nov-2026): responde los 4 en menos de 5 ms.
// Muchos clones no lo soportan: si no responde en 500 ms se asume online sin detalle.

const net = require("net");

const TIMEOUT_CONEXION_MS = 2000;
const TIMEOUT_RESPUESTA_MS = 500;

const ESTADO = Object.freeze({
  ONLINE: "online",
  OFFLINE: "offline",
  NOT_FOUND: "not_found",
  ERROR_PAPEL: "error_paper",
  ERROR_TAPA: "error_cover",
  ERROR: "error",
  DESCONOCIDO: "unknown",
});

const DLE_EOT = Object.freeze({ IMPRESORA: 1, CAUSA_OFFLINE: 2, CAUSA_ERROR: 3, PAPEL: 4 });

/** En las 4 respuestas el bit 0 y el 7 son 0, el 1 y el 4 son 1. Sirve para descartar basura. */
const MASCARA_FIJOS = 0b1001_0011;
const VALOR_FIJOS = 0b0001_0010;
const esRespuestaValida = (byte) => (byte & MASCARA_FIJOS) === VALOR_FIJOS;
const bit = (byte, n) => (byte >> n) & 1;

/**
 * Traduce las respuestas de DLE EOT 1–4 a un estado. Función pura, para probarla sin impresora.
 * Bits según el manual ESC/POS de Epson:
 *  n=1 bit3 offline · n=2 bit2 tapa abierta, bit5 se detuvo por falta de papel, bit6 hay error ·
 *  n=3 bit3 error del cortador, bit5 error no recuperable, bit6 error recuperable ·
 *  n=4 bits 2-3 papel por acabarse, bits 5-6 sin papel.
 * @param {{ impresora?: number|null, causaOffline?: number|null, causaError?: number|null, papel?: number|null }} r
 * @returns {{ estado: string, detalle: { offline?: boolean, tapaAbierta?: boolean, sinPapel?: boolean, papelPorAcabarse?: boolean, errorCortador?: boolean, errorNoRecuperable?: boolean } }}
 */
function interpretarEstado(r) {
  const valido = (b) => typeof b === "number" && esRespuestaValida(b);
  if (!valido(r.impresora)) {
    return { estado: ESTADO.ONLINE, detalle: {} }; // no soporta DLE EOT: online sin detalle
  }
  const detalle = {
    offline: bit(r.impresora, 3) === 1,
    tapaAbierta: valido(r.causaOffline) && bit(r.causaOffline, 2) === 1,
    sinPapel:
      (valido(r.papel) && bit(r.papel, 5) === 1 && bit(r.papel, 6) === 1) ||
      (valido(r.causaOffline) && bit(r.causaOffline, 5) === 1),
    papelPorAcabarse: valido(r.papel) && bit(r.papel, 2) === 1 && bit(r.papel, 3) === 1,
    errorCortador: valido(r.causaError) && bit(r.causaError, 3) === 1,
    errorNoRecuperable: valido(r.causaError) && bit(r.causaError, 5) === 1,
  };
  if (detalle.tapaAbierta) return { estado: ESTADO.ERROR_TAPA, detalle };
  if (detalle.sinPapel) return { estado: ESTADO.ERROR_PAPEL, detalle };
  if (detalle.errorCortador || detalle.errorNoRecuperable) return { estado: ESTADO.ERROR, detalle };
  if (valido(r.causaOffline) && bit(r.causaOffline, 6) === 1) return { estado: ESTADO.ERROR, detalle };
  if (detalle.offline) return { estado: ESTADO.ERROR, detalle };
  return { estado: ESTADO.ONLINE, detalle };
}

/**
 * Conecta, pregunta DLE EOT 1–4 y cierra (no deja la conexión viva).
 * @param {string} host
 * @param {number} puerto
 * @param {{ timeoutConexionMs?: number, timeoutRespuestaMs?: number }} [opciones]
 * @returns {Promise<{ estado: string, soportaEstado: boolean, detalle: object, ms: number }>}
 */
function consultarEstado(host, puerto, opciones = {}) {
  const timeoutConexionMs = opciones.timeoutConexionMs ?? TIMEOUT_CONEXION_MS;
  const timeoutRespuestaMs = opciones.timeoutRespuestaMs ?? TIMEOUT_RESPUESTA_MS;
  const inicio = Date.now();

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let terminado = false;
    const terminar = (valor) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(timerConexion);
      socket.destroy();
      resolve({ ...valor, ms: Date.now() - inicio });
    };
    const offline = () => terminar({ estado: ESTADO.OFFLINE, soportaEstado: false, detalle: {} });

    const timerConexion = setTimeout(offline, timeoutConexionMs);
    socket.on("error", offline);

    socket.on("connect", async () => {
      clearTimeout(timerConexion);
      socket.removeListener("error", offline);
      socket.on("error", () => undefined); // ya conectó: un error acá solo corta las preguntas
      const preguntar = (n) => preguntarDleEot(socket, n, timeoutRespuestaMs);

      const impresora = await preguntar(DLE_EOT.IMPRESORA);
      if (impresora === null || !esRespuestaValida(impresora)) {
        terminar({ estado: ESTADO.ONLINE, soportaEstado: false, detalle: {} });
        return;
      }
      const causaOffline = await preguntar(DLE_EOT.CAUSA_OFFLINE);
      const causaError = await preguntar(DLE_EOT.CAUSA_ERROR);
      const papel = await preguntar(DLE_EOT.PAPEL);
      const { estado, detalle } = interpretarEstado({ impresora, causaOffline, causaError, papel });
      terminar({ estado, soportaEstado: true, detalle });
    });

    socket.connect({ host, port: puerto });
  });
}

/** Manda DLE EOT n y espera un byte. Null si no responde a tiempo. */
function preguntarDleEot(socket, n, timeoutMs) {
  return new Promise((resolve) => {
    const alRecibir = (datos) => {
      clearTimeout(timer);
      socket.removeListener("data", alRecibir);
      resolve(datos[datos.length - 1]);
    };
    const timer = setTimeout(() => {
      socket.removeListener("data", alRecibir);
      resolve(null);
    }, timeoutMs);
    socket.on("data", alRecibir);
    socket.write(Buffer.from([0x10, 0x04, n]));
  });
}

module.exports = { consultarEstado, interpretarEstado, ESTADO, DLE_EOT, esRespuestaValida };
