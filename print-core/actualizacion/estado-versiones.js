"use strict";
// actualizacion.json, en la carpeta de instalación (Program Files\Yalo\PrintAgent). Lo comparten el
// supervisor y el agente:
//   actual     versión a correr (null = la que vino con el instalador)
//   anterior   a la que se vuelve si la actual no levanta
//   probando   true desde que el agente pidió el cambio hasta que el supervisor vio /health de la nueva
//   fallidas   versiones que ya hicieron rollback: no se vuelven a intentar
//   ultimoResultado { version, de, resultado: "ok" | "fallo", motivo, ts, reportado }
// Escritura atómica (temporal + rename) para que un corte de luz no deje el archivo a medias.

const fs = require("fs");
const path = require("path");

const ARCHIVO = "actualizacion.json";
const MAXIMO_FALLIDAS = 20;

const VACIO = Object.freeze({ actual: null, anterior: null, probando: false, desde: null, fallidas: [], ultimoResultado: null });

class EstadoVersiones {
  /** @param {string} raiz carpeta de instalación */
  constructor(raiz) {
    this.raiz = raiz;
    this.archivo = path.join(raiz, ARCHIVO);
  }

  /** Nunca lanza: sin archivo o ilegible = estado vacío (se corre la versión del instalador). */
  leer() {
    try {
      const datos = JSON.parse(fs.readFileSync(this.archivo, "utf8"));
      return { ...VACIO, ...datos, fallidas: Array.isArray(datos.fallidas) ? datos.fallidas : [] };
    } catch {
      return { ...VACIO, fallidas: [] };
    }
  }

  escribir(estado) {
    const limpio = { ...estado, fallidas: (estado.fallidas || []).slice(-MAXIMO_FALLIDAS) };
    const temporal = `${this.archivo}.tmp`;
    fs.mkdirSync(this.raiz, { recursive: true });
    fs.writeFileSync(temporal, JSON.stringify(limpio, null, 2));
    fs.renameSync(temporal, this.archivo);
    return limpio;
  }

  /** Lee, aplica el cambio y guarda. */
  modificar(cambio) {
    return this.escribir(cambio(this.leer()));
  }
}

module.exports = { EstadoVersiones, ARCHIVO_ESTADO: ARCHIVO };
