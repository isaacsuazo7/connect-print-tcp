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

const INTERVALO_REVISION_MS = 15000;
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
   *           alCambiar?: (t: Transicion) => void, log?: (...m: unknown[]) => void }} deps
   */
  constructor({ registro, serializador, consultar = consultarEstado, intervaloMs = INTERVALO_REVISION_MS, alCambiar = () => undefined, log = () => undefined }) {
    this.registro = registro;
    this.serializador = serializador;
    this.consultar = consultar;
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
      this.registrar(imp, this.estadoSegunDiscovery(imp, r.estado), r.detalle, soportaEstado);
      this.estados.get(imp.clave).latenciaMs = r.estado === ESTADO.OFFLINE ? null : r.ms ?? null;
    } catch (error) {
      this.log(`No se pudo revisar ${nombreDe(imp)}`, error);
    } finally {
      this.enRevision.delete(imp.clave);
    }
  }

  /** Lo que se sabe por un trabajo de impresión, sin esperar la próxima vuelta. */
  registrarEnvio(imp, resultado) {
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
      this.registrar(imp, this.estadoSegunDiscovery(imp, ESTADO.OFFLINE), {}, null);
    }
    // incierto: no dice nada seguro del estado; lo aclara la próxima revisión.
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

module.exports = { MonitorImpresoras, INTERVALO_REVISION_MS };
