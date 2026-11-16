"use strict";
// Inventario del parque de impresoras (brief §8 Fase 2): fabricante, modelo, serie y firmware de cada
// impresora, para que la nube arme el inventario sola. Viaja en el heartbeat.
//
// - Fabricante por OUI de la MAC (siempre que haya MAC; no toca la impresora).
// - Modelo, serie y firmware por GS I: se pregunta al descubrirla (o cuando cambia de MAC) y después una
//   vez cada 24 h. Se guarda por MAC en disco, así un reinicio no vuelve a preguntar.
// - Nunca frena la impresión: solo con la cola vacía y sin impresiones recientes, una impresora por vez,
//   en el turno de esa impresora (serializador), y solo si ya contestó DLE EOT (ver gs-i.js).

const fs = require("fs");
const path = require("path");
const { consultarIdentidad } = require("./gs-i");
const { ESTADO } = require("../estado-impresora");
const { normalizarMac } = require("../mac");

const INTERVALO_REVISION_MS = 5 * 60 * 1000;
/** Primera vuelta un rato después de arrancar: que primero se recupere lo pendiente. */
const ESPERA_INICIAL_MS = 2 * 60 * 1000;
const VIGENCIA_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {{ soportaGsI: boolean, fabricante: string|null, modelo: string|null, serie: string|null,
 *             firmware: string|null, consultadoEn: string }} IdentidadImpresora
 */

class InventarioImpresoras {
  /**
   * @param {{ archivo: string | null,
   *           registro: import("../registro-impresoras").RegistroImpresoras,
   *           monitor: import("../monitor-impresoras").MonitorImpresoras,
   *           serializador: import("../serializador").SerializadorPorImpresora,
   *           tablaOui: import("./oui").TablaOui,
   *           consultar?: typeof consultarIdentidad,
   *           estaOcupado?: () => boolean,
   *           intervaloMs?: number, esperaInicialMs?: number, vigenciaMs?: number,
   *           ahora?: () => number,
   *           log?: (...m: unknown[]) => void }} deps
   */
  constructor({
    archivo,
    registro,
    monitor,
    serializador,
    tablaOui,
    consultar = consultarIdentidad,
    estaOcupado = () => false,
    intervaloMs = INTERVALO_REVISION_MS,
    esperaInicialMs = ESPERA_INICIAL_MS,
    vigenciaMs = VIGENCIA_MS,
    ahora = Date.now,
    log = () => undefined,
  }) {
    this.archivo = archivo;
    this.registro = registro;
    this.monitor = monitor;
    this.serializador = serializador;
    this.tablaOui = tablaOui;
    this.consultar = consultar;
    this.estaOcupado = estaOcupado;
    this.intervaloMs = intervaloMs;
    this.esperaInicialMs = esperaInicialMs;
    this.vigenciaMs = vigenciaMs;
    this.ahora = ahora;
    this.log = log;
    /** @type {Map<string, IdentidadImpresora>} por MAC */
    this.porMac = new Map();
    this.timerInicial = null;
    this.timer = null;
    /** @type {Promise<void> | null} */
    this.enCurso = null;
    this.cargar();
  }

  iniciar() {
    if (this.timer || this.timerInicial) return;
    this.timerInicial = setTimeout(() => {
      this.timerInicial = null;
      this.revisarTodas();
      this.timer = setInterval(() => this.revisarTodas(), this.intervaloMs);
    }, this.esperaInicialMs);
  }

  detener() {
    clearTimeout(this.timerInicial);
    clearInterval(this.timer);
    this.timerInicial = null;
    this.timer = null;
  }

  /** Una vuelta: pregunta a las que lo necesitan, de a una. @returns {Promise<void>} */
  revisarTodas() {
    if (this.enCurso) return this.enCurso;
    this.enCurso = this.vuelta()
      .catch((error) => this.log("Inventario: error al revisar las impresoras", error))
      .finally(() => {
        this.enCurso = null;
      });
    return this.enCurso;
  }

  async vuelta() {
    for (const imp of this.registro.lista()) {
      if (this.estaOcupado()) return; // llegó trabajo: se sigue en la próxima vuelta
      if (!this.necesitaConsulta(imp)) continue;
      await this.revisar(imp);
    }
  }

  /** Tiene MAC, contesta DLE EOT ahora y no se le preguntó en las últimas 24 h (o cambió de MAC). */
  necesitaConsulta(imp) {
    const mac = normalizarMac(imp.mac);
    if (!mac) return false;
    const estado = this.monitor.estadoDe(imp);
    if (estado.estado !== ESTADO.ONLINE || estado.soportaEstado !== true) return false;
    const conocida = this.porMac.get(mac);
    if (!conocida) return true;
    return this.ahora() - Date.parse(conocida.consultadoEn) >= this.vigenciaMs;
  }

  async revisar(imp) {
    const mac = normalizarMac(imp.mac);
    const r = await this.serializador.ejecutar(imp.clave, () => this.consultar(imp.ip, imp.puerto));
    if (!r.conecto) return; // apagada justo ahora: se reintenta en la próxima vuelta
    const anterior = this.porMac.get(mac);
    /** @type {IdentidadImpresora} */
    const identidad = {
      soportaGsI: r.soportaGsI,
      fabricante: r.fabricante,
      modelo: r.modelo,
      serie: r.serie,
      firmware: r.firmware,
      consultadoEn: new Date(this.ahora()).toISOString(),
    };
    this.porMac.set(mac, identidad);
    this.guardar();
    if (!anterior || anterior.modelo !== identidad.modelo || anterior.firmware !== identidad.firmware) {
      const dice = r.soportaGsI ? `${r.fabricante || "?"} ${r.modelo || "?"} (serie ${r.serie || "?"}, firmware ${r.firmware || "?"})` : "no soporta GS I";
      this.log(`Inventario: ${imp.nombre || imp.clave} (${mac}): ${dice}`);
    }
  }

  /**
   * Campos para el heartbeat. Lo que no se sabe va en null (la nube distingue null de false).
   * @returns {{ FabricanteOui: string|null, SinFabricanteOui: string|null, Fabricante: string|null, Modelo: string|null,
   *             Serie: string|null, Firmware: string|null, SoportaDleEot: boolean|null, SoportaGsI: boolean|null }}
   */
  datosDe(imp) {
    const oui = this.tablaOui.buscar(imp.mac);
    const mac = normalizarMac(imp.mac);
    const identidad = mac ? this.porMac.get(mac) : null;
    const soportaEstado = this.monitor.estadoDe(imp).soportaEstado;
    return {
      FabricanteOui: oui.fabricante,
      SinFabricanteOui: oui.motivo,
      Fabricante: identidad ? identidad.fabricante : null,
      Modelo: identidad ? identidad.modelo : null,
      Serie: identidad ? identidad.serie : null,
      Firmware: identidad ? identidad.firmware : null,
      SoportaDleEot: typeof soportaEstado === "boolean" ? soportaEstado : null,
      SoportaGsI: identidad ? identidad.soportaGsI : null,
    };
  }

  cargar() {
    if (!this.archivo || !fs.existsSync(this.archivo)) return;
    try {
      const guardado = JSON.parse(fs.readFileSync(this.archivo, "utf8"));
      for (const [mac, identidad] of Object.entries(guardado)) {
        if (normalizarMac(mac) && identidad && typeof identidad.consultadoEn === "string") this.porMac.set(mac, identidad);
      }
    } catch (error) {
      // Archivo roto (corte de luz): se vuelve a preguntar, no pasa nada.
      this.log("Inventario ilegible, se vuelve a preguntar a las impresoras", error.message);
    }
  }

  guardar() {
    if (!this.archivo) return;
    try {
      fs.mkdirSync(path.dirname(this.archivo), { recursive: true });
      const temporal = `${this.archivo}.tmp`;
      fs.writeFileSync(temporal, JSON.stringify(Object.fromEntries(this.porMac), null, 2));
      fs.renameSync(temporal, this.archivo);
    } catch (error) {
      this.log("No se pudo guardar el inventario de impresoras", error.message);
    }
  }
}

module.exports = { InventarioImpresoras, VIGENCIA_INVENTARIO_MS: VIGENCIA_MS };
