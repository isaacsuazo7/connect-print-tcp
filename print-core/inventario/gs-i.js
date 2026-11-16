"use strict";
// Modelo, serie y firmware que dice la impresora misma: GS I n (0x1D 0x49 n), "Transmit printer ID" de
// ESC/POS. Inventario del parque (brief §8 Fase 2).
//
//   n=66 fabricante · n=67 modelo · n=68 serie · n=65 firmware
//   Respuesta: 0x5F ("_") + texto + 0x00.
//
// Reglas:
//  - 500 ms por pregunta. Si la primera no contesta, no soporta GS I: no se sigue preguntando.
//  - Solo se pregunta a impresoras que contestan DLE EOT (ESC/POS de verdad). A un clon que no entiende
//    comandos, los bytes de la pregunta le pueden quedar en el búfer y salir impresos en el próximo
//    ticket. Por lo mismo, si alguna pregunta queda sin respuesta se manda ESC @ (vacía el búfer).
//  - Conexión propia, que se cierra al terminar. Quien llama la pone en el turno de la impresora
//    (serializador) para no meterse en medio de un ticket.

const net = require("net");

const TIMEOUT_CONEXION_MS = 2000;
const TIMEOUT_RESPUESTA_MS = 500;
const LARGO_MAXIMO = 60;

const GS_I = Object.freeze({ FIRMWARE: 65, FABRICANTE: 66, MODELO: 67, SERIE: 68 });
const INICIO_RESPUESTA = 0x5f;
const FIN_RESPUESTA = 0x00;
/** ESC @: inicializa la impresora y vacía el búfer de impresión. */
const ESC_ARROBA = Buffer.from([0x1b, 0x40]);

/**
 * Saca el texto de una respuesta a GS I n (65–69). Función pura, para probarla sin impresora.
 * Tolera bytes de otras respuestas antes (p. ej. un byte de DLE EOT): busca "_" ... NUL.
 * @param {Buffer} datos
 * @returns {string | null} null si todavía no llegó una respuesta completa
 */
function leerRespuestaGsI(datos) {
  const inicio = datos.indexOf(INICIO_RESPUESTA);
  if (inicio < 0) return null;
  const fin = datos.indexOf(FIN_RESPUESTA, inicio + 1);
  if (fin < 0) return null;
  return limpiar(datos.subarray(inicio + 1, fin).toString("latin1"));
}

/** Solo caracteres imprimibles; vacío = null. */
function limpiar(texto) {
  const limpio = texto.replace(/[^\x20-\x7E -ÿ]/g, "").replace(/\s+/g, " ").trim().slice(0, LARGO_MAXIMO);
  return limpio || null;
}

/**
 * Conecta, pregunta fabricante, modelo, serie y firmware, y cierra.
 * @param {string} host
 * @param {number} puerto
 * @param {{ timeoutConexionMs?: number, timeoutRespuestaMs?: number }} [opciones]
 * @returns {Promise<{ conecto: boolean, soportaGsI: boolean, fabricante: string|null, modelo: string|null, serie: string|null, firmware: string|null }>}
 */
function consultarIdentidad(host, puerto, opciones = {}) {
  const timeoutConexionMs = opciones.timeoutConexionMs ?? TIMEOUT_CONEXION_MS;
  const timeoutRespuestaMs = opciones.timeoutRespuestaMs ?? TIMEOUT_RESPUESTA_MS;
  const vacia = { conecto: false, soportaGsI: false, fabricante: null, modelo: null, serie: null, firmware: null };

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let terminado = false;
    const terminar = (valor) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(timerConexion);
      socket.destroy();
      resolve(valor);
    };

    const timerConexion = setTimeout(() => terminar(vacia), timeoutConexionMs);
    socket.on("error", () => terminar(vacia));

    socket.on("connect", async () => {
      clearTimeout(timerConexion);
      socket.removeAllListeners("error");
      socket.on("error", () => undefined);
      const preguntar = (n) => preguntarGsI(socket, n, timeoutRespuestaMs);

      const fabricante = await preguntar(GS_I.FABRICANTE);
      if (fabricante === undefined) {
        await vaciarBufer(socket);
        terminar({ ...vacia, conecto: true });
        return;
      }
      const modelo = await preguntar(GS_I.MODELO);
      const serie = await preguntar(GS_I.SERIE);
      const firmware = await preguntar(GS_I.FIRMWARE);
      if ([modelo, serie, firmware].includes(undefined)) await vaciarBufer(socket);
      terminar({
        conecto: true,
        soportaGsI: true,
        fabricante: fabricante ?? null,
        modelo: modelo ?? null,
        serie: serie ?? null,
        firmware: firmware ?? null,
      });
    });

    socket.connect({ host, port: puerto });
  });
}

/**
 * Manda GS I n y espera "_texto\0".
 * @returns {Promise<string | null | undefined>} texto; null = respondió vacío; undefined = no respondió
 */
function preguntarGsI(socket, n, timeoutMs) {
  return new Promise((resolve) => {
    let recibido = Buffer.alloc(0);
    const alRecibir = (datos) => {
      recibido = Buffer.concat([recibido, datos]);
      if (recibido.indexOf(INICIO_RESPUESTA) < 0 || recibido.indexOf(FIN_RESPUESTA, recibido.indexOf(INICIO_RESPUESTA) + 1) < 0) return;
      clearTimeout(timer);
      socket.removeListener("data", alRecibir);
      resolve(leerRespuestaGsI(recibido));
    };
    const timer = setTimeout(() => {
      socket.removeListener("data", alRecibir);
      resolve(undefined);
    }, timeoutMs);
    socket.on("data", alRecibir);
    socket.write(Buffer.from([0x1d, 0x49, n]));
  });
}

/** Que una pregunta sin respuesta no salga impresa en el próximo ticket. */
function vaciarBufer(socket) {
  return new Promise((resolve) => {
    if (socket.destroyed) return resolve();
    socket.write(ESC_ARROBA, () => resolve());
  });
}

module.exports = { consultarIdentidad, leerRespuestaGsI, GS_I };
