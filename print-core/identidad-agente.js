"use strict";
// Identidad del agente y su vínculo con la nube, guardados en disco (agente.json).
//
// - idAgente: GUID que se crea la primera vez que arranca. El POS lo lee de /health y lo manda a la API
//   (Impresoras/Agentes/Vincular), que devuelve CodAgente + Llave.
// - vínculo: el POS se lo pasa al agente con POST /vincular { codAgente, llave, apiUrl } (solo desde
//   esta PC). Con eso el agente reporta a la nube (heartbeat, headers X-Agente-Id / X-Agente-Llave).
// - tokenLocal: lo que tendrá que mandar el POS en X-Yalo-Agent-Token cuando se encienda la protección
//   (brief §6.2.5). Se crea al vincular y se le devuelve al POS de esta PC.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

class IdentidadAgente {
  /** @param {string | null} archivo null = solo en memoria (pruebas) */
  constructor(archivo, { log = () => undefined } = {}) {
    this.archivo = archivo;
    this.log = log;
    this.datos = this.cargar();
    if (!this.datos.idAgente) {
      this.datos.idAgente = crypto.randomUUID();
      this.guardar();
      this.log(`Agente nuevo: ${this.datos.idAgente}`);
    }
  }

  cargar() {
    if (!this.archivo || !fs.existsSync(this.archivo)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.archivo, "utf8")) || {};
    } catch (error) {
      // Archivo roto: se pierde el vínculo y el POS lo vuelve a vincular en el próximo Reconectar.
      this.log("agente.json ilegible; se crea una identidad nueva", error.message);
      return {};
    }
  }

  guardar() {
    if (!this.archivo) return;
    try {
      fs.mkdirSync(path.dirname(this.archivo), { recursive: true });
      const temporal = `${this.archivo}.tmp`;
      fs.writeFileSync(temporal, JSON.stringify(this.datos, null, 2));
      fs.renameSync(temporal, this.archivo);
    } catch (error) {
      this.log("No se pudo guardar agente.json", error.message);
    }
  }

  get idAgente() {
    return this.datos.idAgente;
  }

  get vinculado() {
    return Boolean(this.datos.codAgente && this.datos.llave && this.datos.apiUrl);
  }

  /** @returns {{ codAgente: number, llave: string, apiUrl: string } | null} */
  get vinculo() {
    if (!this.vinculado) return null;
    return { codAgente: this.datos.codAgente, llave: this.datos.llave, apiUrl: this.datos.apiUrl };
  }

  get tokenLocal() {
    return this.datos.tokenLocal || null;
  }

  /**
   * @param {{ codAgente: unknown, llave: unknown, apiUrl: unknown }} vinculo
   * @returns {string} el token local para el POS
   */
  vincular({ codAgente, llave, apiUrl }) {
    const cod = Number(codAgente);
    if (!Number.isInteger(cod) || cod <= 0) throw new Error("codAgente inválido");
    if (typeof llave !== "string" || llave.length < 16) throw new Error("llave inválida");
    if (typeof apiUrl !== "string" || !/^https?:\/\//i.test(apiUrl)) throw new Error("apiUrl inválida");
    this.datos.codAgente = cod;
    this.datos.llave = llave;
    this.datos.apiUrl = apiUrl.replace(/\/+$/, "");
    this.datos.vinculadoEn = new Date().toISOString();
    this.datos.tokenLocal = crypto.randomBytes(24).toString("base64url");
    this.guardar();
    return this.datos.tokenLocal;
  }

  /** Número para el próximo ticket de prueba (sigue contando después de reinicios). */
  siguienteSecuenciaPrueba() {
    this.datos.secuenciaPrueba = (Number(this.datos.secuenciaPrueba) || 0) + 1;
    this.guardar();
    return this.datos.secuenciaPrueba;
  }

  /** La nube dijo que la llave ya no vale (401): olvidar el vínculo para que el POS lo rehaga. */
  desvincular() {
    delete this.datos.codAgente;
    delete this.datos.llave;
    delete this.datos.vinculadoEn;
    this.guardar();
  }
}

module.exports = { IdentidadAgente };
