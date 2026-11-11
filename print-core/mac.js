"use strict";
// MAC y tabla ARP. Funciones puras (sin red) para poder probarlas con salidas reales de `arp -a`.
// Mismo formato y reglas que la API (DireccionesImpresora.NormalizarMac): "AA:BB:CC:DD:EE:FF".

const PATRON_MAC = /^([0-9A-F]{2}[:-]){5}[0-9A-F]{2}$/i;
const MACS_INVALIDAS = new Set(["00:00:00:00:00:00", "FF:FF:FF:FF:FF:FF"]);

/** "aa-bb-cc-dd-ee-ff" → "AA:BB:CC:DD:EE:FF"; null si no es una MAC de un equipo (vacía, broadcast, multicast). */
function normalizarMac(mac) {
  if (typeof mac !== "string") return null;
  const limpia = mac.trim();
  if (!PATRON_MAC.test(limpia)) return null;
  const normalizada = limpia.replace(/-/g, ":").toUpperCase();
  if (MACS_INVALIDAS.has(normalizada)) return null;
  const esMulticast = (parseInt(normalizada.slice(0, 2), 16) & 1) === 1;
  if (esMulticast) return null;
  return normalizada;
}

// "  10.0.30.243          00-61-a2-66-41-ab     dinámico" (Windows, en cualquier idioma)
const PATRON_FILA_ARP = /^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-f]{2}(?:[-:][0-9a-f]{2}){5})\b/i;

/**
 * Lee la salida de `arp -a` y devuelve las entradas de equipos reales.
 * @param {string} texto
 * @returns {{ ip: string, mac: string }[]}
 */
function parsearTablaArp(texto) {
  const entradas = [];
  for (const linea of String(texto).split(/\r?\n/)) {
    const m = PATRON_FILA_ARP.exec(linea);
    if (!m) continue;
    const mac = normalizarMac(m[2]);
    if (!mac) continue;
    entradas.push({ ip: m[1], mac });
  }
  return entradas;
}

/** IPs en las que la tabla ARP ve esa MAC. */
function ipsDeMac(tabla, mac) {
  const buscada = normalizarMac(mac);
  if (!buscada) return [];
  return [...new Set(tabla.filter((e) => e.mac === buscada).map((e) => e.ip))];
}

/** MAC que la tabla ARP tiene para esa IP, o null. */
function macDeIp(tabla, ip) {
  const entrada = tabla.find((e) => e.ip === ip);
  return entrada ? entrada.mac : null;
}

module.exports = { normalizarMac, parsearTablaArp, ipsDeMac, macDeIp };
