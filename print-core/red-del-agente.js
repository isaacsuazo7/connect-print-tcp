"use strict";
// Qué IP de esta PC es "la del local" y desde dónde llama quien pregunta. Funciones puras.

/** "::ffff:10.0.30.50" → "10.0.30.50" */
function ipDelCliente(direccionRemota) {
  return String(direccionRemota || "").replace(/^::ffff:/, "");
}

const LOOPBACK = new Set(["127.0.0.1", "::1"]);
const esLoopback = (ip) => LOOPBACK.has(ipDelCliente(ip)) || ipDelCliente(ip).startsWith("127.");

const prefijo24 = (ip) => ip.split(".").slice(0, 3).join(".");
const esLinkLocal = (ip) => ip.startsWith("169.254.");

/**
 * La IP del local entre las de la PC (la que la nube guarda como servidor de impresión de las cajas y
 * la que usan las tablets). Una PC puede tener Wi-Fi + VPN: gana la red donde están las impresoras.
 * Sin impresoras conocidas, la primera que no sea link-local.
 * @param {string[]} ipsDeLaPc
 * @param {string[]} ipsDeImpresoras
 * @returns {string | null}
 */
function ipPrincipal(ipsDeLaPc, ipsDeImpresoras) {
  const candidatas = ipsDeLaPc.filter((ip) => !esLinkLocal(ip));
  if (candidatas.length === 0) return null;
  const conteo = (ip) => ipsDeImpresoras.filter((i) => i && prefijo24(i) === prefijo24(ip)).length;
  const ordenadas = [...candidatas].sort((a, b) => conteo(b) - conteo(a));
  return ordenadas[0];
}

module.exports = { ipDelCliente, esLoopback, ipPrincipal };
