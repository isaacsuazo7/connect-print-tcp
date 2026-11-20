"use strict";
// Ciclo de salud por impresora (brief §6.2.3): cada 15 s, conectar + DLE EOT + cerrar, y saber en qué
// estado está cada una. Toda transición se avisa (log, /printers, /health; y más adelante nube y cola).
//
// - En paralelo entre impresoras, pero por el MISMO turno que la impresión de cada una (serializador):
//   una consulta nunca se mete en medio de un ticket.
// - Si una revisión de esa impresora sigue en curso (cola larga), no se apila otra.
// - Los resultados de impresión también cuentan: imprimió = online; no conectó = offline, sin esperar
//   la próxima vuelta.

const { consultarEstado, ESTADO } = require("./estado-impresora");
const { DISCOVERY } = require("./registro-impresoras");
const { RESULTADO } = require("./envio");
const { esErrorFisico } = require("./envio-con-estado");

const INTERVALO_REVISION_MS = 15000;
/**
 * OBS-03 (QA 19-nov, visto también el 20-nov con "oficina"): mientras imprime y corta una factura grande la
 * impresora contesta DLE EOT con el bit de "no lista" sin decir por qué, y salía "error" ~15 s (barra del
 * POS y alerta a SAC). El "error" genérico se informa solo si sigue al menos este tiempo después de la
 * primera lectura; papel y tapa tienen su propio bit y se informan al instante.
 */
const CONFIRMAR_ERROR_MS = 10000;
/** Errores que solo ve DLE EOT: la impresora sigue aceptando conexiones y datos con ellos. */
const ESTADOS_CON_PAPEL_O_TAPA = new Set([ESTADO.ERROR_TAPA, ESTADO.ERROR_PAPEL, ESTADO.ERROR]);

/**
 * @typedef {{ estado: string, desde: string, detalle: object, soportaEstado: boolean | null, revisadaEn: string | null }} EstadoImpresora
 * @typedef {{ impresora: object, de: string, a: string }} Transicion
 */

class MonitorImpresoras {
  /**
   * @param {{ registro: import("./registro-impresoras").RegistroImpresoras,
   *           serializador: import("./serializador").SerializadorPorImpresora,
   *           consultar?: typeof consultarEstado, intervaloMs?: number,
   *           hacerPing?: ((ip: string) => Promise<boolean>) | null,
   *           alCambiar?: (t: Transicion) => void, log?: (...m: unknown[]) => void, ahora?: () => number }} deps
   *   hacerPing: para marcar `enRed` cuando no acepta conexiones (trabada). Null = no se pregunta.
   */
  constructor({ registro, serializador, consultar = consultarEstado, intervaloMs = INTERVALO_REVISION_MS, hacerPing = null, alCambiar = () => undefined, log = () => undefined, ahora = Date.now }) {
    this.ahora = ahora;
    /** @type {Map<string, number>} desde cuándo una impresora contesta "error" sin confirmar (OBS-03) */
    this.errorSinConfirmarDesde = new Map();
    this.registro = registro;
    this.serializador = serializador;
    this.consultar = consultar;
    this.hacerPing = hacerPing;
    this.intervaloMs = intervaloMs;
    this.alCambiar = alCambiar;
    this.log = log;
    /** @type {Map<string, EstadoImpresora>} */
    this.estados = new Map();
    /** @type {Set<string>} impresoras con una revisión en curso */
    this.enRevision = new Set();
    this.timer = null;
  }

  iniciar() {
    if (this.timer) return;
    this.revisarTodas();
    this.timer = setInterval(() => this.revisarTodas(), this.intervaloMs);
  }

  detener() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** @returns {Promise<void>} cuando terminó la vuelta (para pruebas) */
  revisarTodas() {
    return Promise.all(this.registro.lista().map((imp) => this.revisar(imp))).then(() => undefined);
  }

  async revisar(imp) {
    if (this.enRevision.has(imp.clave)) return;
    this.enRevision.add(imp.clave);
    try {
      const r = await this.serializador.ejecutar(imp.clave, () => this.consultar(imp.ip, imp.puerto));
      // Sin conexión no se sabe si soporta DLE EOT: se deja lo que se sabía (o null). Antes quedaba en
      // false y el inventario la contaba como "no soporta estado" (visto el 16-nov con "oficina" apagada).
      const soportaEstado = r.estado === ESTADO.OFFLINE ? null : r.soportaEstado;
      // Fuera del turno de la impresora (no frena tickets): solo cuando no aceptó la conexión.
      const detalle = r.estado === ESTADO.OFFLINE ? await this.detalleSinConexion(imp) : r.detalle;
      if (!this.errorConfirmado(imp, r.estado)) return;
      this.registrar(imp, this.estadoSegunDiscovery(imp, r.estado), detalle, soportaEstado);
      this.estados.get(imp.clave).latenciaMs = r.estado === ESTADO.OFFLINE ? null : r.ms ?? null;
    } catch (error) {
      this.log(`No se pudo revisar ${nombreDe(imp)}`, error);
    } finally {
      this.enRevision.delete(imp.clave);
    }
  }

  /**
   * Lo que contestó la impresora al preguntarle justo antes de un envío (envio-con-estado.js). Si no
   * contestó DLE EOT no se concluye nada (puede estar ocupada o ser un clon): lo aclara la próxima vuelta.
   */
  registrarConsulta(imp, r) {
    if (r.estado === ESTADO.OFFLINE) {
      this.registrar(imp, this.estadoSegunDiscovery(imp, ESTADO.OFFLINE), this.detalleOfflineConocido(imp), null);
      return;
    }
    if (!r.soportaEstado) return;
    if (!this.errorConfirmado(imp, r.estado)) return;
    this.registrar(imp, r.estado, r.detalle, true);
  }

  /**
   * OBS-03: false = es un "error" genérico todavía sin confirmar; no se registra nada (queda lo de antes).
   * Cualquier otra lectura borra la sospecha.
   */
  errorConfirmado(imp, estado) {
    if (estado !== ESTADO.ERROR) {
      this.errorSinConfirmarDesde.delete(imp.clave);
      return true;
    }
    if (this.estadoDe(imp).estado === ESTADO.ERROR) return true; // ya estaba confirmado
    const ahora = this.ahora();
    const desde = this.errorSinConfirmarDesde.get(imp.clave);
    if (desde === undefined) {
      this.errorSinConfirmarDesde.set(imp.clave, ahora);
      return false;
    }
    return ahora - desde >= CONFIRMAR_ERROR_MS;
  }

  /**
   * Lo que se sabe por un trabajo de impresión, sin esperar la próxima vuelta.
   * @param {string} [error] fallido por papel o tapa = no se mandó; el estado ya lo dejó registrarConsulta.
   */
  registrarEnvio(imp, resultado, error) {
    if (resultado === RESULTADO.FALLIDO && esErrorFisico(error)) return;
    if (resultado === RESULTADO.IMPRESO) {
      // Imprimió: está online, salvo que ya se sepa algo más fino (p. ej. papel por acabarse).
      const actual = this.estados.get(imp.clave);
      // Con la tapa abierta o sin papel la impresora igual acepta la conexión y los datos (los guarda
      // hasta que se resuelve). Que "imprimió" no borre ese error: lo aclara la próxima consulta DLE EOT.
      // Visto el 12-nov: un Reconectar con la tapa abierta la pasaba a online hasta la revisión siguiente.
      if (actual && ESTADOS_CON_PAPEL_O_TAPA.has(actual.estado)) return;
      const detalle = actual && actual.estado === ESTADO.ONLINE ? actual.detalle : {};
      this.registrar(imp, ESTADO.ONLINE, detalle, actual ? actual.soportaEstado : null);
      return;
    }
    if (resultado === RESULTADO.FALLIDO) {
      this.registrar(imp, this.estadoSegunDiscovery(imp, ESTADO.OFFLINE), this.detalleOfflineConocido(imp), null);
    }
    // incierto: no dice nada seguro del estado; lo aclara la próxima revisión.
  }

  /**
   * No aceptó la conexión: ¿está en la red (contesta ping) o no? `enRed: true` = trabada: prendida y en la
   * red pero sin aceptar trabajos; se arregla apagándola y prendiéndola (visto con "oficina" el 20-nov).
   * Apagada o desconectada no contesta. El estado sigue "offline" (alertas a SAC y POS viejos igual).
   */
  async detalleSinConexion(imp) {
    if (!this.hacerPing) return {};
    try {
      return (await this.hacerPing(imp.ip)) ? { enRed: true } : {};
    } catch (error) {
      this.log(`No se pudo hacer ping a ${nombreDe(imp)}`, error);
      return {};
    }
  }

  /** Un envío fallido no sabe si está en la red: se deja lo que dijo la última revisión si seguía offline. */
  detalleOfflineConocido(imp) {
    const actual = this.estados.get(imp.clave);
    return actual && actual.estado === ESTADO.OFFLINE ? actual.detalle : {};
  }

  /** Sin conexión y el discovery tampoco la ve por MAC en ningún lado = not_found. */
  estadoSegunDiscovery(imp, estado) {
    if (estado === ESTADO.OFFLINE && imp.discovery === DISCOVERY.NO_ENCONTRADA) return ESTADO.NOT_FOUND;
    return estado;
  }

  registrar(imp, estado, detalle, soportaEstado) {
    const ahora = new Date().toISOString();
    const anterior = this.estados.get(imp.clave);
    const de = anterior ? anterior.estado : ESTADO.DESCONOCIDO;
    this.estados.set(imp.clave, {
      estado,
      desde: de === estado && anterior ? anterior.desde : ahora,
      detalle: detalle || {},
      soportaEstado: soportaEstado ?? (anterior ? anterior.soportaEstado : null),
      revisadaEn: ahora,
    });
    if (de === estado) return;
    this.log(`Impresora ${nombreDe(imp)} (${imp.ip}): ${de} → ${estado}`);
    try {
      this.alCambiar({ impresora: imp, de, a: estado });
    } catch (error) {
      this.log("Error al avisar el cambio de estado", error);
    }
  }

  /** @returns {EstadoImpresora} */
  estadoDe(imp) {
    return (
      this.estados.get(imp.clave) || { estado: ESTADO.DESCONOCIDO, desde: null, detalle: {}, soportaEstado: null, revisadaEn: null }
    );
  }
}

const nombreDe = (imp) => imp.nombre || imp.clave;

module.exports = { MonitorImpresoras, INTERVALO_REVISION_MS, CONFIRMAR_ERROR_MS };
