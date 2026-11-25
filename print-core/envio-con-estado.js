"use strict";
// BUG-10 del reporte de QA (19-nov-2026): sin papel o con la tapa abierta la impresora ACEPTA la conexión
// y los bytes (los guarda en su memoria), así que el envío salía "impreso" y el POS no lo guardaba en
// pendientes. Si después la apagan (lo normal cuando "no imprime"), la comanda se pierde.
//
// Antes de mandar se le pregunta el estado (DLE EOT, ~5 ms en "oficina"). Sin papel o con la tapa abierta
// NO se manda nada y el resultado es "fallido" (502 en /print): el POS lo guarda en pendientes y sale
// cuando se arregla. Mandarlo igual Y encolarlo no sirve: una impresora que imprime su memoria al poner
// papel (la "oficina" lo hace) lo sacaría dos veces.

const { ESTADO } = require("./estado-impresora");
const { RESULTADO, ERROR } = require("./envio");

/** Motivo en `error` cuando no se mandó por el estado de la impresora. El POS lo lee para el aviso. */
const ERROR_FISICO = Object.freeze({ SIN_PAPEL: "sin_papel", TAPA_ABIERTA: "tapa_abierta" });

const ERROR_POR_ESTADO = Object.freeze({
  [ESTADO.ERROR_PAPEL]: ERROR_FISICO.SIN_PAPEL,
  [ESTADO.ERROR_TAPA]: ERROR_FISICO.TAPA_ABIERTA,
});

/**
 * BUG-17 (QA ronda 3, 25-nov): en la IP contesta OTRA impresora (otra MAC). Se tomó la IP vieja de esta y la
 * comanda salía en la equivocada con "Impresión exitosa". No se manda; quien llama busca la correcta por MAC.
 */
const ERROR_OTRA_IMPRESORA = "otra_impresora";

const DETALLE_POR_ERROR = Object.freeze({
  [ERROR_FISICO.SIN_PAPEL]: "La impresora está sin papel: no se mandó nada",
  [ERROR_FISICO.TAPA_ABIERTA]: "La impresora tiene la tapa abierta: no se mandó nada",
});

/**
 * Conexión con el mismo margen que el envío (2 s); respuesta corta para no demorar el ticket: una
 * impresora ocupada que no contesta a tiempo se juzga por lo último que vio el monitor.
 */
const OPCIONES_CONSULTA = Object.freeze({ timeoutRespuestaMs: 300 });

/** @param {string | null | undefined} error */
const esErrorFisico = (error) => error === ERROR_FISICO.SIN_PAPEL || error === ERROR_FISICO.TAPA_ABIERTA;

/**
 * Pregunta el estado y manda solo si la impresora puede imprimir.
 * - Impresoras que ya se sabe que no contestan DLE EOT (clones): se manda directo, sin demora.
 * - No se pudo conectar: fallido sin mandar nada (lo mismo que habría dicho el envío).
 * @param {{ host: string, puerto: number, datos: Uint8Array }} trabajo
 * @param {{ enviar: (t: object) => Promise<{ resultado: string, error: string|null, detalle: string, ms: number }>,
 *           consultar: (host: string, puerto: number, opciones: object) => Promise<{ estado: string, soportaEstado: boolean, detalle: object, ms: number }>,
 *           conocido: { estado: string, soportaEstado: boolean | null },
 *           verificarDestino?: (host: string) => Promise<string | null> }} deps
 *   `verificarDestino`: null si en `host` está la impresora esperada; si no, el motivo (BUG-17). Va DESPUÉS de
 *   conectarse a preguntar el estado: esa conexión deja la tabla ARP al día con quién está en esa IP.
 * @returns {Promise<{ resultado: string, error: string|null, detalle: string, ms: number, consulta: object|null }>}
 *   `consulta` = lo que contestó la impresora (para el monitor), o null si no se le preguntó.
 */
async function enviarRevisandoEstado(trabajo, { enviar, consultar, conocido, verificarDestino = async () => null }) {
  if (conocido.soportaEstado === false) {
    const otra = await verificarDestino(trabajo.host);
    if (otra) return { ...fallidoPorOtraImpresora(otra, 0), consulta: null };
    return { ...(await enviar(trabajo)), consulta: null };
  }
  const consulta = await consultar(trabajo.host, trabajo.puerto, OPCIONES_CONSULTA);
  if (consulta.estado === ESTADO.OFFLINE) {
    return {
      resultado: RESULTADO.FALLIDO,
      error: ERROR.SIN_CONEXION,
      detalle: "No se pudo conectar con la impresora",
      ms: consulta.ms,
      consulta,
    };
  }
  const error = ERROR_POR_ESTADO[estadoParaDecidir(consulta, conocido)];
  if (error) {
    return { resultado: RESULTADO.FALLIDO, error, detalle: DETALLE_POR_ERROR[error], ms: consulta.ms, consulta };
  }
  const otra = await verificarDestino(trabajo.host);
  if (otra) return { ...fallidoPorOtraImpresora(otra, consulta.ms), consulta };
  return { ...(await enviar(trabajo)), consulta };
}

function fallidoPorOtraImpresora(detalle, ms) {
  return { resultado: RESULTADO.FALLIDO, error: ERROR_OTRA_IMPRESORA, detalle, ms };
}

/** Lo que contestó recién; si no contestó DLE EOT (ocupada o clon), lo último que se sabía. */
function estadoParaDecidir(consulta, conocido) {
  if (consulta.soportaEstado) return consulta.estado;
  return conocido.estado;
}

module.exports = { enviarRevisandoEstado, esErrorFisico, ERROR_FISICO, ERROR_OTRA_IMPRESORA };
