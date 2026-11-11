"use strict";
// Protección de la API local (brief §6.2.5): token X-Yalo-Agent-Token y CORS restringido.
//
// APAGADO POR DEFECTO: los POS que hoy imprimen no mandan token y no se conocen todos los orígenes
// (Electron, APK, dominios de producción). Encenderlo sin eso dejaría locales sin imprimir. Se enciende
// desde la nube (heartbeat) cuando todos los POS manden el token.

const HEADER_TOKEN = "x-yalo-agent-token";

/** Orígenes del POS (brief §6.2.5) para cuando se restrinja CORS. */
const ORIGENES_POS = [
  /^https:\/\/([a-z0-9-]+\.)*yalocobro\.com$/i,
  /^https?:\/\/localhost(:\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/i,
  /^capacitor:\/\/localhost$/i,
  /^file:\/\//i,
  /^app:\/\//i,
];

/** Rutas que nunca piden token. */
const RUTAS_LIBRES = new Set(["/health"]);

/**
 * @param {{ exigirToken: boolean }} config
 * @param {string | null} tokenEsperado
 * @param {{ ruta: string, token: string | undefined }} pedido
 * @returns {boolean}
 */
function tokenValido(config, tokenEsperado, pedido) {
  if (!config.exigirToken) return true;
  if (RUTAS_LIBRES.has(pedido.ruta)) return true;
  if (!tokenEsperado || typeof pedido.token !== "string") return false;
  return pedido.token === tokenEsperado;
}

/** @param {string | undefined} origen */
function origenPermitido(config, origen) {
  if (!config.restringirCors) return true;
  if (!origen) return true; // sin Origin: no es un navegador (curl, Electron main, nube)
  return ORIGENES_POS.some((patron) => patron.test(origen));
}

/**
 * Middlewares de Express.
 * @param {() => { exigirToken: boolean, restringirCors: boolean }} obtenerConfig
 * @param {() => string | null} obtenerToken
 */
function crearProteccion(obtenerConfig, obtenerToken) {
  const cors = (req, res, next) => {
    const origen = req.headers.origin;
    if (!origenPermitido(obtenerConfig(), origen)) {
      res.status(403).send({ message: "Origen no permitido" });
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", origen || "*");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "Content-Type, X-Yalo-Agent-Token, X-Skip-Interceptor");
    // Chrome pide esto para que una página pública llame a una IP privada (Private Network Access).
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };

  const token = (req, res, next) => {
    if (tokenValido(obtenerConfig(), obtenerToken(), { ruta: req.path, token: req.headers[HEADER_TOKEN] })) {
      next();
      return;
    }
    res.status(401).send({ message: "Falta el token del agente o no es válido" });
  };

  return { cors, token };
}

module.exports = { crearProteccion, tokenValido, origenPermitido, HEADER_TOKEN };
