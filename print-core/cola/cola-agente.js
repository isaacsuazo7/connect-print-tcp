"use strict";
// Cola del agente (brief §6.2.4): lo que el POS manda con job_id se guarda en SQLite, se responde al
// instante y se imprime en orden por impresora. Si la impresora está caída, espera; cuando vuelve
// (offline → online) se descarga sola. Sobrevive cambios de caja, borrado del navegador y reinicios.
//
// Reglas:
//  - Idempotencia: el mismo job_id dos veces no encola dos veces (reenvíos del outbox del POS).
//  - En orden por impresora: si el más viejo no sale, los de atrás esperan (nunca se saltan).
//  - Tiempos (politica.js): pasado el de "sale solo" → awaiting_confirm (el POS pregunta, modal D8);
//    pasado el duro → expired.
//  - fallido (no conectó) → reintento con espera 2 → 5 → 15 → 30 → 60 s (uno por minuto si está caída).
//  - incierto (se mandó y no confirmó) → awaiting_confirm: reintentarlo solo podría duplicar el ticket.

const { ESTADO_TRABAJO } = require("./almacen");
const { normalizarTipo, tiemposDe, decidir, DECISION, esperaParaReintentar } = require("./politica");
const { RESULTADO } = require("../envio");
const { ESTADO } = require("../estado-impresora");

const INTERVALO_REVISION_MS = 1000;
const INTERVALO_PURGA_MS = 10 * 60 * 1000;
/** Lo terminado (impreso, vencido, descartado) se guarda un día para /jobs y soporte. */
const CONSERVAR_TERMINADOS_MS = 24 * 60 * 60 * 1000;
const LARGO_MAXIMO_JOB_ID = 64;
const ESTADOS_CAIDA = new Set([ESTADO.OFFLINE, ESTADO.NOT_FOUND]);

class ColaAgente {
  /**
   * @param {{ almacen: import("./almacen").AlmacenCola,
   *           registro: import("../registro-impresoras").RegistroImpresoras,
   *           serializador: import("../serializador").SerializadorPorImpresora,
   *           enviar: (t: { host: string, puerto: number, datos: Buffer, impresora: object }) => Promise<{ resultado: string, error: string|null, detalle: string }>,
   *           monitor?: { estadoDe: (imp: object) => { estado: string }, registrarEnvio: (imp: object, r: string, error?: string|null) => void },
   *           alDescargar?: (d: { impresora: object, impresos: number }) => void,
   *           ttlNube?: () => Record<string, { autoMs?: number, duroMs?: number }>,
   *           ahora?: () => number,
   *           log?: (...m: unknown[]) => void }} deps
   */
  constructor({ almacen, registro, serializador, enviar, monitor = null, alDescargar = () => undefined, ttlNube = () => ({}), ahora = Date.now, log = () => undefined }) {
    this.almacen = almacen;
    this.registro = registro;
    this.serializador = serializador;
    this.enviar = enviar;
    this.monitor = monitor;
    this.alDescargar = alDescargar;
    this.ttlNube = ttlNube;
    this.ahora = ahora;
    this.log = log;
    /** @type {Map<string, Promise<number>>} impresoras con una pasada en curso */
    this.procesando = new Map();
    this.timers = [];
  }

  iniciar() {
    const interrumpidos = this.almacen.recuperarInterrumpidos();
    if (interrumpidos) this.log(`Cola: ${interrumpidos} trabajo(s) quedaron a medias por un corte; quedan por confirmar`);
    this.timers.push(setInterval(() => this.revisar(), INTERVALO_REVISION_MS));
    this.timers.push(setInterval(() => this.almacen.purgar(this.ahora() - CONSERVAR_TERMINADOS_MS), INTERVALO_PURGA_MS));
    this.revisar();
  }

  detener() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  /**
   * Guarda un trabajo. No espera a la impresora.
   * @param {{ jobId: string, ip: string, puerto: number, codImpresora?: number|null, mac?: string|null,
   *           tipo?: string|number, datos: Buffer, creadoEn?: number|string, origen?: string|null }} pedido
   * @returns {{ nuevo: boolean, trabajo: object }}
   */
  encolar(pedido) {
    if (typeof pedido.jobId !== "string" || !pedido.jobId.trim() || pedido.jobId.length > LARGO_MAXIMO_JOB_ID) {
      throw new Error("job_id inválido");
    }
    const existente = this.almacen.obtener(pedido.jobId);
    if (existente) return { nuevo: false, trabajo: existente };

    const ahora = this.ahora();
    const { impresora } = this.registro.resolverDestino({
      ip: pedido.ip,
      puerto: pedido.puerto,
      codImpresora: pedido.codImpresora,
      mac: pedido.mac,
    });
    const tipo = normalizarTipo(pedido.tipo);
    const tiempos = tiemposDe(tipo, this.ttlNube());
    const creadoEn = Math.min(fechaEnMs(pedido.creadoEn) ?? ahora, ahora); // nunca en el futuro (reloj de la tablet)
    const insertado = this.almacen.insertar({
      job_id: pedido.jobId,
      printer_id: impresora.clave,
      printer_host: pedido.ip,
      printer_port: pedido.puerto,
      cod_impresora: impresora.codImpresora,
      printer_mac: impresora.mac,
      type: tipo,
      payload: pedido.datos,
      created_at: creadoEn,
      received_at: ahora,
      auto_ttl_at: creadoEn + tiempos.autoMs,
      hard_ttl_at: creadoEn + tiempos.duroMs,
      status: ESTADO_TRABAJO.PENDIENTE,
      origin_device: pedido.origen || null,
    });
    const trabajo = this.almacen.obtener(pedido.jobId);
    if (!insertado) return { nuevo: false, trabajo };
    this.procesar(impresora.clave);
    return { nuevo: true, trabajo };
  }

  /** La impresora volvió (offline → online): descargar lo pendiente ya. */
  async alVolver(impresora) {
    this.almacen.adelantar(impresora.clave);
    const impresos = await this.procesar(impresora.clave);
    if (impresos > 0) {
      this.log(`Cola: ${impresora.nombre || impresora.clave} volvió y salieron ${impresos} trabajo(s) pendientes`);
      this.alDescargar({ impresora, impresos });
    }
    return impresos;
  }

  /** POST /jobs/flush: intentar ya todo lo pendiente. */
  async descargar() {
    this.almacen.adelantar(null);
    const filas = this.almacen.impresorasConPendientes();
    const impresos = await Promise.all(filas.map((f) => this.procesar(f.printer_id)));
    return impresos.reduce((a, b) => a + b, 0);
  }

  /** El usuario dijo "imprimir igual" a uno por confirmar (modal D8). */
  confirmar(jobId) {
    const t = this.almacen.obtener(jobId);
    if (!t || t.status !== ESTADO_TRABAJO.POR_CONFIRMAR) return t;
    this.almacen.actualizar(jobId, {
      status: ESTADO_TRABAJO.PENDIENTE,
      confirmed_at: this.ahora(),
      attempts: 0,
      next_attempt_at: 0,
      last_error: null,
    });
    this.procesar(t.printer_id);
    return this.almacen.obtener(jobId);
  }

  descartar(jobId) {
    const t = this.almacen.obtener(jobId);
    const descartable = t && (t.status === ESTADO_TRABAJO.PENDIENTE || t.status === ESTADO_TRABAJO.POR_CONFIRMAR);
    if (!descartable) return t;
    this.almacen.actualizar(jobId, { status: ESTADO_TRABAJO.DESCARTADO });
    return this.almacen.obtener(jobId);
  }

  /** Cada segundo: vencer lo que hay que vencer y procesar las impresoras con algo listo para intentar. */
  revisar() {
    const ahora = this.ahora();
    try {
      this.almacen.vencerPorConfirmar(ahora);
      for (const fila of this.almacen.impresorasConPendientes()) {
        if (Number(fila.proximo) <= ahora) this.procesar(fila.printer_id);
      }
    } catch (error) {
      this.log("Cola: error al revisar", error);
    }
  }

  /**
   * Imprime en orden lo pendiente de una impresora hasta que no quede nada listo o algo no salga.
   * Una sola pasada por impresora a la vez.
   * @returns {Promise<number>} cuántos se imprimieron
   */
  procesar(printerId) {
    const enCurso = this.procesando.get(printerId);
    if (enCurso) return enCurso;
    const pasada = this.pasada(printerId)
      .catch((error) => {
        this.log(`Cola: error procesando ${printerId}`, error);
        return 0;
      })
      .finally(() => this.procesando.delete(printerId));
    this.procesando.set(printerId, pasada);
    return pasada;
  }

  async pasada(printerId) {
    let impresos = 0;
    for (;;) {
      const t = this.almacen.siguientePendiente(printerId);
      if (!t) return impresos;
      const ahora = this.ahora();
      if (Number(t.next_attempt_at) > ahora) return impresos;

      const decision = decidir(t, ahora);
      if (decision === DECISION.VENCER) {
        this.almacen.actualizar(t.job_id, { status: ESTADO_TRABAJO.VENCIDO });
        continue;
      }
      if (decision === DECISION.CONFIRMAR) {
        this.almacen.actualizar(t.job_id, { status: ESTADO_TRABAJO.POR_CONFIRMAR, last_error: "auto_ttl" });
        continue;
      }
      const sigue = await this.imprimirUno(t);
      if (!sigue) return impresos;
      impresos++;
    }
  }

  /** @returns {Promise<boolean>} true si salió y se puede seguir con el siguiente */
  async imprimirUno(t) {
    // Se imprime donde está la impresora ahora (puede haberse movido), sin reconfigurarla con la IP
    // que traía el trabajo (puede ser vieja).
    const impresora =
      this.registro.impresoras.get(t.printer_id) ||
      this.registro.resolverDestino({ ip: t.printer_host, puerto: t.printer_port, codImpresora: t.cod_impresora, mac: t.printer_mac }).impresora;
    const datos = this.almacen.payloadDe(t.job_id);
    this.almacen.actualizar(t.job_id, { status: ESTADO_TRABAJO.IMPRIMIENDO });

    const envio = await this.serializador.ejecutar(printerId(impresora, t), () =>
      this.enviar({ host: impresora.ip, puerto: impresora.puerto, datos, impresora })
    );
    if (this.monitor) this.monitor.registrarEnvio(impresora, envio.resultado, envio.error);
    const intentos = Number(t.attempts) + 1;

    if (envio.resultado === RESULTADO.IMPRESO) {
      this.almacen.actualizar(t.job_id, { status: ESTADO_TRABAJO.IMPRESO, attempts: intentos, printed_at: this.ahora(), last_error: null });
      return true;
    }
    if (envio.resultado === RESULTADO.INCIERTO) {
      this.almacen.actualizar(t.job_id, { status: ESTADO_TRABAJO.POR_CONFIRMAR, attempts: intentos, last_error: envio.error });
      return false;
    }
    const caida = this.monitor ? ESTADOS_CAIDA.has(this.monitor.estadoDe(impresora).estado) : false;
    this.almacen.actualizar(t.job_id, {
      status: ESTADO_TRABAJO.PENDIENTE,
      attempts: intentos,
      next_attempt_at: this.ahora() + esperaParaReintentar(intentos, caida),
      last_error: envio.error,
    });
    return false;
  }

  obtener(jobId) {
    return this.almacen.obtener(jobId);
  }

  listar(filtro) {
    return this.almacen.listar(filtro);
  }

  /** Tiene algo esperando para salir por esa impresora. */
  tienePendientes(printerId) {
    return this.almacen.siguientePendiente(printerId) !== null;
  }

  /** Para /health y el heartbeat: { pending, awaiting_confirm, ... } */
  totales() {
    return this.almacen.totales();
  }
}

/** Mismo turno que /print y el monitor para esa impresora. */
const printerId = (impresora, t) => (impresora ? impresora.clave : t.printer_id);

/** Acepta ms, ISO o nada. */
function fechaEnMs(valor) {
  if (valor === undefined || valor === null || valor === "") return null;
  const ms = typeof valor === "number" ? valor : Date.parse(valor);
  return Number.isFinite(ms) ? ms : null;
}

module.exports = { ColaAgente, ESTADO_TRABAJO };
