"use strict";
// Fabricante por los 3 primeros bytes de la MAC (OUI). Inventario del parque (brief §8 Fase 2).
//
// Ojo al leer el resultado: en impresoras baratas la MAC suele ser del fabricante de la placa de red
// (o un prefijo que nadie registró, como 00:61:A2 de "oficina"), no de la marca de la impresora. Por eso
// el inventario guarda aparte el fabricante que dice la impresora misma (GS I).
//
// La tabla viene en el exe (oui-datos.js, IEEE). La nube puede corregir o sumar prefijos en la respuesta
// del heartbeat (FabricantesOui); esas correcciones mandan sobre la tabla y se guardan en disco.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { normalizarMac } = require("../mac");

const PATRON_PREFIJO = /^[0-9A-F]{6}$/;
const LARGO_MAXIMO_NOMBRE = 60;

/** Para el inventario: sin fabricante por OUI, ¿por qué? */
const SIN_FABRICANTE = Object.freeze({
  SIN_MAC: "sin_mac",
  /** Bit "administrada localmente": MAC inventada (aleatoria o puesta a mano), no tiene fabricante. */
  LOCAL: "mac_local",
  /** El prefijo no está en el registro de la IEEE (clones). */
  NO_REGISTRADO: "no_registrado",
});

/** "AA:BB:CC:DD:EE:FF" → "AABBCC"; null si no es una MAC válida. */
function prefijoDe(mac) {
  const normalizada = normalizarMac(mac);
  return normalizada ? normalizada.slice(0, 8).replace(/:/g, "") : null;
}

const esMacLocal = (prefijo) => (parseInt(prefijo.slice(0, 2), 16) & 0b10) !== 0;

/** @param {string} texto "PREFIJO\tNombre" por línea @returns {Map<string, string>} */
function leerTabla(texto) {
  const tabla = new Map();
  for (const linea of texto.split("\n")) {
    const tab = linea.indexOf("\t");
    if (tab !== 6) continue;
    tabla.set(linea.slice(0, 6), linea.slice(7));
  }
  return tabla;
}

class TablaOui {
  /**
   * @param {{ datos?: { DATOS: string, VERSION_OUI: string } | null, archivoCorrecciones?: string | null,
   *           log?: (...m: unknown[]) => void }} [opciones]
   *   datos null = sin tabla embebida (pruebas); archivoCorrecciones null = solo en memoria.
   */
  constructor({ datos, archivoCorrecciones = null, log = () => undefined } = {}) {
    this.archivoCorrecciones = archivoCorrecciones;
    this.log = log;
    const embebidos = datos === undefined ? cargarEmbebidos(log) : datos;
    this.version = embebidos ? embebidos.VERSION_OUI : null;
    /** @type {Map<string, string>} */
    this.tabla = embebidos ? leerTabla(zlib.gunzipSync(Buffer.from(embebidos.DATOS, "base64")).toString("utf8")) : new Map();
    /** @type {Map<string, string>} correcciones de la nube */
    this.correcciones = new Map();
    this.cargarCorrecciones();
  }

  get tamano() {
    return this.tabla.size;
  }

  /**
   * @param {string | null | undefined} mac
   * @returns {{ fabricante: string | null, motivo: string | null }}
   */
  buscar(mac) {
    const prefijo = prefijoDe(mac);
    if (!prefijo) return { fabricante: null, motivo: SIN_FABRICANTE.SIN_MAC };
    const corregido = this.correcciones.get(prefijo);
    if (corregido) return { fabricante: corregido, motivo: null };
    if (esMacLocal(prefijo)) return { fabricante: null, motivo: SIN_FABRICANTE.LOCAL };
    const fabricante = this.tabla.get(prefijo) ?? null;
    return { fabricante, motivo: fabricante ? null : SIN_FABRICANTE.NO_REGISTRADO };
  }

  /**
   * Lo que manda la nube (imp_fabricantesoui). Reemplaza las correcciones anteriores: la nube manda la
   * lista completa. Si no cambió, no escribe el disco.
   * @param {{ Prefijo?: string, Fabricante?: string }[]} lista
   */
  aplicarCorrecciones(lista) {
    if (!Array.isArray(lista)) return;
    const nuevas = new Map();
    for (const item of lista) {
      const prefijo = String((item && item.Prefijo) || "").replace(/[:-]/g, "").trim().toUpperCase();
      const fabricante = String((item && item.Fabricante) || "").trim().slice(0, LARGO_MAXIMO_NOMBRE);
      if (PATRON_PREFIJO.test(prefijo) && fabricante) nuevas.set(prefijo, fabricante);
    }
    if (mismoContenido(nuevas, this.correcciones)) return;
    this.correcciones = nuevas;
    this.guardarCorrecciones();
  }

  cargarCorrecciones() {
    if (!this.archivoCorrecciones || !fs.existsSync(this.archivoCorrecciones)) return;
    try {
      const guardadas = JSON.parse(fs.readFileSync(this.archivoCorrecciones, "utf8"));
      this.correcciones = new Map(Object.entries(guardadas).filter(([p, n]) => PATRON_PREFIJO.test(p) && typeof n === "string"));
    } catch (error) {
      this.log("Correcciones de fabricantes ilegibles; se usan solo las de la tabla", error.message);
    }
  }

  guardarCorrecciones() {
    if (!this.archivoCorrecciones) return;
    try {
      fs.mkdirSync(path.dirname(this.archivoCorrecciones), { recursive: true });
      const temporal = `${this.archivoCorrecciones}.tmp`;
      fs.writeFileSync(temporal, JSON.stringify(Object.fromEntries(this.correcciones), null, 2));
      fs.renameSync(temporal, this.archivoCorrecciones);
    } catch (error) {
      this.log("No se pudieron guardar las correcciones de fabricantes", error.message);
    }
  }
}

function cargarEmbebidos(log) {
  try {
    return require("./oui-datos");
  } catch (error) {
    // Nunca frenar el servicio por esto: sin tabla, el inventario sale sin fabricante por OUI.
    log("Tabla de fabricantes (OUI) no disponible", error.message);
    return null;
  }
}

const mismoContenido = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

module.exports = { TablaOui, SIN_FABRICANTE, prefijoDe };
