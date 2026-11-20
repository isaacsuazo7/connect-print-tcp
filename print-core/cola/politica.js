"use strict";
// Política de la cola del agente (brief §6.2.4). Funciones puras, la misma tabla de tiempos que el POS
// (YALO-APP-CAP src/app/shared/prints/cola/tiempos-cola.ts), para que un trabajo se comporte igual esté
// en la cola del POS o en la del agente.

const MINUTO_MS = 60 * 1000;
const HORA_MS = 60 * MINUTO_MS;

/** Tipos de documento. Mismos números que FuncionesImpresora del POS (1–6); "test" es del agente. */
const TIPO = Object.freeze({
  PROFORMA: "proforma",
  FACTURA: "factura",
  COMANDA: "comanda",
  CIERRE_CAJA: "cierre_caja",
  CIERRE_TIENDA: "cierre_tienda",
  APARTADO: "apartado",
  TEST: "test",
  OTRO: "otro",
});

const TIPO_POR_FUNCION_POS = Object.freeze({
  1: TIPO.PROFORMA,
  2: TIPO.FACTURA,
  3: TIPO.COMANDA,
  4: TIPO.CIERRE_CAJA,
  5: TIPO.CIERRE_TIENDA,
  6: TIPO.APARTADO,
});

/** autoMs: hasta cuándo sale solo · duroMs: desde cuándo ya no vale la pena (se vence). */
const TIEMPOS_FACTURA = { autoMs: 30 * MINUTO_MS, duroMs: 12 * HORA_MS };
const TIEMPOS_CIERRE = { autoMs: 60 * MINUTO_MS, duroMs: 24 * HORA_MS };
const TIEMPOS_POR_DEFECTO = { autoMs: 10 * MINUTO_MS, duroMs: 24 * HORA_MS }; // igual que el POS

const TIEMPOS_POR_TIPO = Object.freeze({
  // OBS-07 (QA 19-nov, decisión del 20-nov): igual que el POS, la comanda sale sola solo hasta los 2 min.
  [TIPO.COMANDA]: { autoMs: 2 * MINUTO_MS, duroMs: 4 * HORA_MS },
  [TIPO.PROFORMA]: { autoMs: 10 * MINUTO_MS, duroMs: 1 * HORA_MS },
  [TIPO.FACTURA]: TIEMPOS_FACTURA,
  [TIPO.APARTADO]: TIEMPOS_FACTURA,
  [TIPO.CIERRE_CAJA]: TIEMPOS_CIERRE,
  [TIPO.CIERRE_TIENDA]: TIEMPOS_CIERRE,
  [TIPO.TEST]: { autoMs: 1 * MINUTO_MS, duroMs: 5 * MINUTO_MS },
});

/** Acepta el nombre ("comanda") o el número de función del POS (3). */
function normalizarTipo(tipo) {
  if (typeof tipo === "number" || /^\d+$/.test(String(tipo))) return TIPO_POR_FUNCION_POS[Number(tipo)] || TIPO.OTRO;
  const nombre = String(tipo || "").toLowerCase();
  return Object.values(TIPO).includes(nombre) ? nombre : TIPO.OTRO;
}

/**
 * Tiempos de un tipo. La nube los puede sobreescribir (heartbeat) con { comanda: { autoMs, duroMs } }.
 * @param {string} tipo
 * @param {Record<string, { autoMs?: number, duroMs?: number }>} [desdeNube]
 */
function tiemposDe(tipo, desdeNube = {}) {
  const base = TIEMPOS_POR_TIPO[tipo] || TIEMPOS_POR_DEFECTO;
  return { ...base, ...(desdeNube[tipo] || {}) };
}

const DECISION = Object.freeze({ IMPRIMIR: "imprimir", CONFIRMAR: "confirmar", VENCER: "vencer" });

/**
 * Qué hacer con un trabajo pendiente ahora.
 * - Vencido (pasó el tiempo duro): se vence.
 * - Pasó el tiempo de salir solo y nadie lo confirmó: se pregunta (modal D8 del POS).
 * - Si no: se imprime.
 * @param {{ auto_ttl_at: number, hard_ttl_at: number, confirmed_at?: number | null }} trabajo
 * @param {number} ahora
 */
function decidir(trabajo, ahora) {
  if (ahora >= trabajo.hard_ttl_at) return DECISION.VENCER;
  if (ahora >= trabajo.auto_ttl_at && !trabajo.confirmed_at) return DECISION.CONFIRMAR;
  return DECISION.IMPRIMIR;
}

/** Reintentos: 2 → 5 → 15 → 30 → 60 s. Con la impresora caída, uno por minuto. */
const ESPERAS_REINTENTO_MS = [2000, 5000, 15000, 30000, 60000];
const ESPERA_IMPRESORA_CAIDA_MS = 60000;

/**
 * @param {number} intentos los que ya fallaron (1 = falló una vez)
 * @param {boolean} impresoraCaida offline / not_found según el monitor
 */
function esperaParaReintentar(intentos, impresoraCaida) {
  if (impresoraCaida) return ESPERA_IMPRESORA_CAIDA_MS;
  const i = Math.min(Math.max(intentos, 1), ESPERAS_REINTENTO_MS.length) - 1;
  return ESPERAS_REINTENTO_MS[i];
}

module.exports = {
  TIPO,
  DECISION,
  normalizarTipo,
  tiemposDe,
  decidir,
  esperaParaReintentar,
  MINUTO_MS,
  HORA_MS,
};
