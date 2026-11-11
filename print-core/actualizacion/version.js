"use strict";
// Versiones del agente: solo "mayor.menor.parche" (sin sufijos). Es lo único que se acepta de la nube,
// porque la versión también es el nombre de la carpeta donde se guarda (versions\1.4.0\).

const FORMATO_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/** @param {unknown} version */
function esVersionValida(version) {
  return typeof version === "string" && FORMATO_VERSION.test(version);
}

/** @returns {number} negativo si a < b, 0 si iguales, positivo si a > b. Las inválidas cuentan como 0.0.0. */
function compararVersiones(a, b) {
  const partes = (v) => (esVersionValida(v) ? v.split(".").map(Number) : [0, 0, 0]);
  const [pa, pb] = [partes(a), partes(b)];
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

const esMasNueva = (candidata, actual) => esVersionValida(candidata) && compararVersiones(candidata, actual) > 0;

module.exports = { esVersionValida, compararVersiones, esMasNueva };
