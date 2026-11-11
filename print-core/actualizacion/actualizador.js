"use strict";
// Auto-actualización, del lado del agente (brief §6.2.1). El cambio de versión y el rollback los hace el
// supervisor (servicio/supervisor.js); acá solo se decide CUÁNDO y se deja la versión nueva lista.
//
//  1. La nube ofrece una versión en el heartbeat: { Version, Url, Sha256, Firma, Ventana? }.
//  2. Se verifica la firma ANTES de descargar (sin firma válida no se baja nada).
//  3. Se descarga en segundo plano a versions\<versión>\ y se comprueba el SHA-256.
//  4. Se espera el momento: dentro de la ventana (si la hay), sin trabajos en cola ni imprimiéndose y sin
//     impresiones en el último minuto (no cortar a una caja en plena venta).
//  5. Se anota en actualizacion.json "probar <nueva>, volver a <actual>" y el agente se reinicia. El
//     supervisor levanta la nueva y, si no responde /health en 60 s, vuelve a la anterior.
//  6. Al arrancar, el agente reporta a la nube el resultado (update_succeeded / update_failed).
//
// Nada de esto frena la impresión: errores al log y se reintenta en el próximo heartbeat.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { esMasNueva, esVersionValida } = require("./version");
const { firmaValida } = require("./firma");
const { EstadoVersiones } = require("./estado-versiones");

const NOMBRE_EXE = "YaloPrinterService.exe";
const CARPETA_VERSIONES = "versions";
const REVISAR_CADA_MS = 30000;
const SIN_IMPRESIONES_MS = 60000;
const ESPERA_TRAS_FALLO_DESCARGA_MS = 5 * 60000;
const TIMEOUT_DESCARGA_MS = 10 * 60000;
const TAMANO_MAXIMO_BYTES = 200 * 1024 * 1024;
const FORMATO_VENTANA = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/;
const MINUTOS_POR_HORA = 60;

const ESTADO_PENDIENTE = Object.freeze({
  DESCARGANDO: "descargando",
  ESPERANDO: "esperando_momento",
  APLICANDO: "aplicando",
});

/** "02:00-05:00" → { desde: 120, hasta: 300 } en minutos del día. Inválida o ausente → null (a cualquier hora). */
function parsearVentana(texto) {
  const m = typeof texto === "string" ? FORMATO_VENTANA.exec(texto.trim()) : null;
  if (!m) return null;
  const [hd, md, hh, mh] = m.slice(1).map(Number);
  if (hd > 23 || hh > 23 || md > 59 || mh > 59) return null;
  return { desde: hd * MINUTOS_POR_HORA + md, hasta: hh * MINUTOS_POR_HORA + mh };
}

/** Hora local de la PC. Admite ventanas que cruzan la medianoche ("22:00-05:00"). */
function dentroDeVentana(ventana, fecha) {
  if (!ventana) return true;
  const minuto = fecha.getHours() * MINUTOS_POR_HORA + fecha.getMinutes();
  if (ventana.desde <= ventana.hasta) return minuto >= ventana.desde && minuto < ventana.hasta;
  return minuto >= ventana.desde || minuto < ventana.hasta;
}

function sha256DeArchivo(archivo) {
  return crypto.createHash("sha256").update(fs.readFileSync(archivo)).digest("hex");
}

class Actualizador {
  /**
   * @param {{ raiz: string, versionActual: string, clavePublica: string,
   *           estaOcupado: () => boolean, msDesdeUltimaImpresion: () => number, reiniciar: () => void,
   *           evento?: (tipo: string, datos: object) => void, fetch?: typeof globalThis.fetch,
   *           log?: (...m: unknown[]) => void, ahora?: () => Date, estado?: EstadoVersiones }} deps
   */
  constructor({
    raiz, versionActual, clavePublica, estaOcupado, msDesdeUltimaImpresion, reiniciar,
    evento = () => undefined, fetch = globalThis.fetch, log = () => undefined, ahora = () => new Date(), estado,
  }) {
    this.raiz = raiz;
    this.versionActual = versionActual;
    this.clavePublica = clavePublica;
    this.estaOcupado = estaOcupado;
    this.msDesdeUltimaImpresion = msDesdeUltimaImpresion;
    this.reiniciar = reiniciar;
    this.evento = evento;
    this.fetch = fetch;
    this.log = log;
    this.ahora = ahora;
    this.estado = estado || new EstadoVersiones(raiz);
    /** @type {null | { version: string, url: string, sha256: string, ventana: object|null, estado: string, reintentarDesde: number }} */
    this.pendiente = null;
    this.rechazada = null;
    this.enCurso = false;
    this.timer = null;
  }

  carpetaDe(version) {
    return path.join(this.raiz, CARPETA_VERSIONES, version);
  }

  /** Al arrancar: reportar cómo terminó la última actualización y borrar versiones que ya no sirven. */
  iniciar() {
    this.reportarResultado();
    // También en cada vuelta: la versión nueva arranca ANTES de que el supervisor la confirme (espera su
    // /health), así que el "ok" aparece en actualizacion.json un par de segundos después del arranque.
    this.timer = setInterval(() => {
      this.reportarResultado();
      this.avanzar();
    }, REVISAR_CADA_MS);
    if (this.timer.unref) this.timer.unref();
  }

  /** Avisa a la nube cómo terminó la última actualización (una sola vez) y limpia versiones viejas. */
  reportarResultado() {
    try {
      const estado = this.estado.leer();
      const resultado = estado.ultimoResultado;
      if (!resultado || resultado.reportado || estado.probando) return;
      const tipo = resultado.resultado === "ok" ? "update_succeeded" : "update_failed";
      const motivo = resultado.motivo ? ` (${resultado.motivo})` : "";
      this.log(`Actualización ${resultado.de || "?"} → ${resultado.version}: ${resultado.resultado}${motivo}`);
      this.evento(tipo, { De: resultado.de, A: resultado.version, Motivo: resultado.motivo || null });
      this.estado.modificar((e) => ({ ...e, ultimoResultado: { ...e.ultimoResultado, reportado: true } }));
      this.limpiarVersionesViejas(estado);
    } catch (error) {
      this.log("Actualización: no se pudo reportar el resultado", error.message);
    }
  }

  detener() {
    clearInterval(this.timer);
  }

  /** Lo que mandó la nube en el heartbeat (null = no hay versión para este agente). */
  ofrecer(oferta) {
    if (!oferta || typeof oferta !== "object" || !esMasNueva(oferta.Version, this.versionActual)) {
      this.cancelarPendiente();
      return;
    }
    const { Version: version, Url: url, Sha256: sha256, Firma: firma, Ventana: ventana } = oferta;
    if (this.pendiente && this.pendiente.version === version) return;
    if (this.estado.leer().fallidas.includes(version)) return; // ya hizo rollback una vez: no insistir
    if (!firmaValida(this.clavePublica, version, sha256, firma) || !esUrlDescargable(url)) {
      this.rechazar(version);
      return;
    }
    this.cancelarPendiente();
    this.pendiente = {
      version, url, sha256, ventana: parsearVentana(ventana), estado: ESTADO_PENDIENTE.DESCARGANDO, reintentarDesde: 0,
    };
    this.log(`Actualización disponible: ${this.versionActual} → ${version}; descargando en segundo plano`);
    return this.avanzar();
  }

  cancelarPendiente() {
    if (!this.pendiente || this.pendiente.estado === ESTADO_PENDIENTE.APLICANDO) return;
    this.log(`Actualización a ${this.pendiente.version} cancelada: la nube ya no la ofrece`);
    this.pendiente = null;
  }

  rechazar(version) {
    if (this.rechazada === version) return;
    this.rechazada = version;
    this.log(`Actualización a ${version} rechazada: la firma o la URL no son válidas`);
    this.evento("update_rejected", { A: version, Motivo: "firma inválida" });
  }

  /** Un paso: descargar si falta; si ya está, aplicar cuando sea el momento. */
  async avanzar() {
    if (this.enCurso || !this.pendiente) return;
    this.enCurso = true;
    try {
      const p = this.pendiente;
      if (p.estado === ESTADO_PENDIENTE.DESCARGANDO && !(await this.descargarPendiente(p))) return;
      if (p.estado === ESTADO_PENDIENTE.ESPERANDO && this.esElMomento(p)) this.aplicar(p);
    } catch (error) {
      this.log("Actualización: error inesperado", error);
    } finally {
      this.enCurso = false;
    }
  }

  /** @returns {Promise<boolean>} true si quedó descargada y verificada */
  async descargarPendiente(p) {
    if (Date.now() < p.reintentarDesde) return false;
    const error = await this.descargar(p);
    if (this.pendiente !== p) return false; // la nube la canceló mientras bajaba
    if (error) {
      p.reintentarDesde = Date.now() + ESPERA_TRAS_FALLO_DESCARGA_MS;
      this.log(`Actualización a ${p.version}: no se pudo descargar (${error}); se reintenta en 5 min`);
      return false;
    }
    p.estado = ESTADO_PENDIENTE.ESPERANDO;
    this.log(`Actualización a ${p.version} descargada y verificada; se aplica cuando no haya impresiones en curso`);
    return true;
  }

  esElMomento(p) {
    if (!dentroDeVentana(p.ventana, this.ahora())) return false;
    if (this.estaOcupado()) return false;
    return this.msDesdeUltimaImpresion() >= SIN_IMPRESIONES_MS;
  }

  aplicar(p) {
    p.estado = ESTADO_PENDIENTE.APLICANDO;
    this.estado.modificar((e) => ({
      ...e, actual: p.version, anterior: this.versionActual, probando: true, desde: this.ahora().toISOString(),
    }));
    this.log(`Actualizando ${this.versionActual} → ${p.version}: el agente se reinicia (si la nueva no levanta en 60 s, vuelve sola a ${this.versionActual})`);
    this.detener();
    this.reiniciar();
  }

  /** @returns {Promise<string|null>} motivo del fallo, o null si quedó el .exe verificado en su carpeta. */
  async descargar(p) {
    const carpeta = this.carpetaDe(p.version);
    const destino = path.join(carpeta, NOMBRE_EXE);
    if (fs.existsSync(destino) && sha256DeArchivo(destino) === p.sha256) return null;

    fs.mkdirSync(carpeta, { recursive: true });
    const temporal = `${destino}.descarga`;
    try {
      const respuesta = await this.fetch(p.url, { signal: AbortSignal.timeout(TIMEOUT_DESCARGA_MS) });
      if (!respuesta.ok || !respuesta.body) return `el servidor respondió ${respuesta.status}`;
      const sha = await guardarCalculandoSha(respuesta.body, temporal);
      if (sha === null) return "el archivo es demasiado grande";
      if (sha !== p.sha256) return "el archivo no coincide con el publicado (SHA-256)";
      fs.renameSync(temporal, destino);
      return null;
    } catch (error) {
      return error.name === "TimeoutError" ? "timeout" : error.message;
    } finally {
      fs.rmSync(temporal, { force: true });
    }
  }

  /** Deja solo la actual y la anterior (para un rollback). Nunca toca el .exe del instalador. */
  limpiarVersionesViejas(estado) {
    const carpeta = path.join(this.raiz, CARPETA_VERSIONES);
    const conservar = new Set([estado.actual, estado.anterior, this.versionActual].filter(Boolean));
    let nombres = [];
    try {
      nombres = fs.readdirSync(carpeta);
    } catch {
      return; // todavía no hubo ninguna actualización
    }
    for (const nombre of nombres.filter((n) => esVersionValida(n) && !conservar.has(n))) {
      try {
        fs.rmSync(path.join(carpeta, nombre), { recursive: true, force: true });
        this.log(`Actualización: se borró la versión vieja ${nombre}`);
      } catch (error) {
        this.log(`Actualización: no se pudo borrar ${nombre}`, error.message);
      }
    }
  }

  /** Para el heartbeat y /health. */
  resumen() {
    const estado = this.estado.leer();
    const r = estado.ultimoResultado;
    return {
      VersionAnterior: estado.anterior,
      // La nube no las vuelve a ofrecer: así puede llegar una corrección aunque sea más vieja que la rota.
      VersionesFallidas: estado.fallidas,
      Pendiente: this.pendiente ? { Version: this.pendiente.version, Estado: this.pendiente.estado } : null,
      UltimaActualizacion: r ? { Version: r.version, De: r.de, Resultado: r.resultado, Motivo: r.motivo || null, Ts: r.ts } : null,
    };
  }
}

const esUrlDescargable = (url) => typeof url === "string" && /^https?:\/\//i.test(url);

/** @returns {Promise<string|null>} SHA-256 de lo guardado, o null si superó el tamaño máximo. */
async function guardarCalculandoSha(cuerpo, archivo) {
  const hash = crypto.createHash("sha256");
  const salida = fs.openSync(archivo, "w");
  let bytes = 0;
  try {
    for await (const parte of cuerpo) {
      bytes += parte.length;
      if (bytes > TAMANO_MAXIMO_BYTES) return null;
      hash.update(parte);
      fs.writeSync(salida, parte);
    }
    fs.fsyncSync(salida);
  } finally {
    fs.closeSync(salida);
  }
  return hash.digest("hex");
}

module.exports = {
  Actualizador, parsearVentana, dentroDeVentana, sha256DeArchivo,
  NOMBRE_EXE, CARPETA_VERSIONES, SIN_IMPRESIONES_MS, ESTADO_PENDIENTE,
};
