"use strict";
// Heartbeat a la nube (brief §6.2.6) contra la API que ya existe en QA (rama nrecarte/ImpresoraSinServer):
//   POST {apiUrl}/Impresoras/Agentes/Heartbeat   headers X-Agente-Id + X-Agente-Llave
//   → { IntervaloSegundos, Impresoras: [{ CodImpresora, Nombre, Ip, Puerto, Mac }] }
// La nube aprende la MAC, corrige la IP de las impresoras que se movieron y el host del servidor de
// impresión de las cajas. La respuesta trae la lista de impresoras que el agente tiene que vigilar.
//
// Reglas:
//  - Nunca frena la impresión: corre aparte, con timeout, y sus errores solo van al log.
//  - Cada 30 s (o lo que diga la nube). Ante un cambio (estado de impresora, IP, vínculo) se manda ya,
//    para que la nube se entere en segundos.
//  - Sin internet: reintenta con espera creciente (5 → 15 → 30 → 60 s) y guarda los eventos en una cola
//    en memoria con tope; al volver los manda todos.
//  - Eventos (printer_state_changed, printer_ip_changed, agent_ip_changed, agent_started) viajan en el
//    mismo heartbeat (campo Eventos). La API actual ignora lo que no conoce; cuando lo lea, ya llegan.

const crypto = require("crypto");

const RUTA_HEARTBEAT = "/Impresoras/Agentes/Heartbeat";
const INTERVALO_POR_DEFECTO_MS = 30000;
const INTERVALO_MINIMO_MS = 10000;
const ESPERAS_SIN_NUBE_MS = [5000, 15000, 30000, 60000];
const TIMEOUT_PEDIDO_MS = 10000;
/** Agrupa cambios seguidos (p. ej. tres impresoras que se caen juntas) en un solo envío. */
const AGRUPAR_CAMBIOS_MS = 1000;
const MAXIMO_EVENTOS = 200;
/** La llave se da por inválida recién al tercer 401 seguido (no por un error pasajero). */
const RECHAZOS_PARA_DESVINCULAR = 3;
const STATUS_NO_AUTORIZADO = 401;

class HeartbeatNube {
  /**
   * @param {{ identidad: import("../identidad-agente").IdentidadAgente,
   *           armarReporte: () => object,
   *           alResponder?: (datos: object) => void,
   *           fetch?: typeof globalThis.fetch,
   *           log?: (...m: unknown[]) => void }} deps
   */
  constructor({ identidad, armarReporte, alResponder = () => undefined, fetch = globalThis.fetch, log = () => undefined }) {
    this.identidad = identidad;
    this.armarReporte = armarReporte;
    this.alResponder = alResponder;
    this.fetch = fetch;
    this.log = log;
    /** @type {object[]} */
    this.eventos = [];
    this.timer = null;
    this.enCurso = null;
    this.fallosSeguidos = 0;
    this.rechazosSeguidos = 0;
    this.intervaloMs = INTERVALO_POR_DEFECTO_MS;
    this.ultimoExito = null;
    this.detenido = true;
  }

  iniciar() {
    this.detenido = false;
    this.programar(0);
  }

  detener() {
    this.detenido = true;
    clearTimeout(this.timer);
  }

  /** Algo cambió: mandar ya (agrupando lo que pase en el próximo segundo). */
  ahora() {
    if (this.detenido) return;
    this.programar(AGRUPAR_CAMBIOS_MS);
  }

  /** @param {string} tipo @param {object} [datos] */
  evento(tipo, datos = {}) {
    // Id: la nube no duplica un evento si se reenvía (heartbeat que no llegó a confirmarse).
    this.eventos.push({ Id: crypto.randomUUID(), Tipo: tipo, Ts: new Date().toISOString(), ...datos });
    if (this.eventos.length > MAXIMO_EVENTOS) this.eventos.splice(0, this.eventos.length - MAXIMO_EVENTOS);
    this.ahora();
  }

  programar(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.enviar(), ms);
  }

  /** @returns {Promise<boolean>} si la nube lo recibió */
  enviar() {
    if (this.enCurso) return this.enCurso;
    this.enCurso = this.enviarUnaVez()
      .catch((error) => {
        this.log("Heartbeat: error inesperado", error);
        return false;
      })
      .then((ok) => {
        this.enCurso = null;
        if (!this.detenido) this.programar(ok ? this.intervaloMs : this.esperaTrasFallo());
        return ok;
      });
    return this.enCurso;
  }

  async enviarUnaVez() {
    const vinculo = this.identidad.vinculo;
    if (!vinculo) return true; // sin vincular no hay a quién reportar; el POS lo vincula en Reconectar

    const eventos = this.eventos.slice();
    const cuerpo = { ...this.armarReporte(), Eventos: eventos };
    let respuesta;
    try {
      respuesta = await this.fetch(`${vinculo.apiUrl}${RUTA_HEARTBEAT}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agente-Id": this.identidad.idAgente,
          "X-Agente-Llave": vinculo.llave,
        },
        body: JSON.stringify(cuerpo),
        signal: AbortSignal.timeout(TIMEOUT_PEDIDO_MS),
      });
    } catch (error) {
      this.registrarFallo(`sin conexión con la nube (${error.name === "TimeoutError" ? "timeout" : error.message})`);
      return false;
    }

    if (respuesta.status === STATUS_NO_AUTORIZADO) {
      this.rechazosSeguidos++;
      this.registrarFallo(`la nube rechazó la llave (${this.rechazosSeguidos}/${RECHAZOS_PARA_DESVINCULAR})`);
      if (this.rechazosSeguidos >= RECHAZOS_PARA_DESVINCULAR) {
        this.log("Heartbeat: la llave ya no vale; se desvincula para que el POS lo vuelva a vincular en Reconectar");
        this.identidad.desvincular();
        this.rechazosSeguidos = 0;
      }
      return false;
    }
    if (!respuesta.ok) {
      this.registrarFallo(`la nube respondió ${respuesta.status}`);
      return false;
    }

    const datos = leerDatos(await respuesta.json().catch(() => null));
    // Llegó: sacar de la cola los eventos que se mandaron (los nuevos que entraron mientras, quedan).
    this.eventos.splice(0, eventos.length);
    if (this.fallosSeguidos > 0) this.log(`Heartbeat: la nube volvió a responder después de ${this.fallosSeguidos} intento(s)`);
    this.fallosSeguidos = 0;
    this.rechazosSeguidos = 0;
    this.ultimoExito = new Date().toISOString();
    const intervalo = Number(datos && datos.IntervaloSegundos) * 1000;
    this.intervaloMs = intervalo >= INTERVALO_MINIMO_MS ? intervalo : INTERVALO_POR_DEFECTO_MS;
    if (datos) {
      try {
        this.alResponder(datos);
      } catch (error) {
        this.log("Heartbeat: error al aplicar la respuesta de la nube", error);
      }
    }
    return true;
  }

  registrarFallo(motivo) {
    this.fallosSeguidos++;
    // Al log solo el primero y cada 10, para no llenarlo si no hay internet por horas.
    if (this.fallosSeguidos === 1 || this.fallosSeguidos % 10 === 0) {
      this.log(`Heartbeat: ${motivo}; se reintenta (intento ${this.fallosSeguidos}, ${this.eventos.length} evento(s) guardados)`);
    }
  }

  esperaTrasFallo() {
    const i = Math.min(this.fallosSeguidos, ESPERAS_SIN_NUBE_MS.length) - 1;
    return ESPERAS_SIN_NUBE_MS[Math.max(i, 0)];
  }

  /** Para /health. */
  resumen() {
    return {
      vinculado: this.identidad.vinculado,
      ultimoReporte: this.ultimoExito,
      fallosSeguidos: this.fallosSeguidos,
      eventosPendientes: this.eventos.length,
    };
  }
}

/** La API envuelve en { success, data } (a veces en mayúscula). */
function leerDatos(json) {
  if (!json || typeof json !== "object") return null;
  return json.data || json.Data || null;
}

module.exports = { HeartbeatNube, RUTA_HEARTBEAT, MAXIMO_EVENTOS };
