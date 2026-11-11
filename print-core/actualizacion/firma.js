"use strict";
// Firma de las versiones publicadas (Ed25519). La clave pública va dentro del agente (clave-publica.js);
// la privada la guarda quien publica (scripts/publicar-version.js). Lo firmado es la versión + el SHA-256
// del .exe: aunque alguien cambie la URL o el archivo en el servidor de descargas, el agente no instala
// nada que no haya firmado Yalo. Tampoco se puede "bajar" de versión: el agente solo acepta más nuevas.

const crypto = require("crypto");

const PREFIJO = "yalo-print-agent";
const FORMATO_SHA256 = /^[0-9a-f]{64}$/;

const mensajeFirmado = (version, sha256) => Buffer.from(`${PREFIJO}\n${version}\n${sha256}`, "utf8");

/** @returns {string} firma en base64 */
function firmar(clavePrivadaPem, version, sha256) {
  return crypto.sign(null, mensajeFirmado(version, sha256), clavePrivadaPem).toString("base64");
}

/** Nunca lanza: firma mal formada o clave inválida = no válida. */
function firmaValida(clavePublicaPem, version, sha256, firmaBase64) {
  if (typeof sha256 !== "string" || !FORMATO_SHA256.test(sha256)) return false;
  if (typeof firmaBase64 !== "string" || firmaBase64.length === 0) return false;
  try {
    return crypto.verify(null, mensajeFirmado(version, sha256), clavePublicaPem, Buffer.from(firmaBase64, "base64"));
  } catch {
    return false;
  }
}

module.exports = { firmar, firmaValida, FORMATO_SHA256 };
