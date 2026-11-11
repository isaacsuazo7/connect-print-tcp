"use strict";
// Supervisor del agente: es lo que nssm ejecuta (YaloPrinterService.exe sin argumentos). No imprime nada;
// solo decide qué versión del agente correr y la vigila. Así un .exe en uso nunca hay que sobreescribirlo
// y el rollback no depende de que la versión nueva funcione.
//
//   Program Files\Yalo\PrintAgent\
//     YaloPrinterService.exe        ← el del instalador: supervisor, y agente de la versión base
//     versions\1.4.0\YaloPrinterService.exe   ← bajadas por la auto-actualización
//     actualizacion.json            ← qué correr (print-core/actualizacion/estado-versiones.js)
//
// Reglas:
//  - Corre la versión "actual" de actualizacion.json solo si es más nueva que la del instalador y su .exe
//    existe. Si no (reinstalación con un paquete más nuevo, archivo borrado), corre la del instalador.
//  - Versión en prueba: tiene 60 s para responder /health con su número de versión. Si no, o si se cierra
//    antes, se la mata, se vuelve a la anterior y se anota el fallo (el agente lo reporta a la nube).
//  - El agente pide una actualización escribiendo actualizacion.json y cerrándose con código 0: el
//    supervisor levanta enseguida la nueva (sin esperar el reinicio de nssm).
//  - Cualquier otro cierre del agente: el supervisor se cierra con el mismo código y nssm reinicia todo.
//  - Ante Ctrl+C / parada del servicio no se toca nada (no es un fallo de la versión nueva).

const fs = require("fs");
const path = require("path");
const { compararVersiones, esVersionValida } = require("../print-core/actualizacion/version");
const { EstadoVersiones } = require("../print-core/actualizacion/estado-versiones");
const { NOMBRE_EXE, CARPETA_VERSIONES } = require("../print-core/actualizacion/actualizador");

const PLAZO_VERSION_NUEVA_MS = 60000;
const CONSULTAR_HEALTH_CADA_MS = 2000;
const TIMEOUT_HEALTH_MS = 1500;
const CODIGO_FALLO = 1;
/** Código con el que Windows cierra un proceso por Ctrl+C (STATUS_CONTROL_C_EXIT): es una parada, no un fallo. */
const CODIGO_CTRL_C = 0xc000013a;

class Supervisor {
  /**
   * @param {{ raiz: string, versionPropia: string, puerto: number,
   *           comandoDe: (version: string) => { comando: string, args: string[] } | null,
   *           lanzar: (comando: string, args: string[], env: object) => import("child_process").ChildProcess,
   *           consultarVersion?: (puerto: number) => Promise<string|null>,
   *           salir?: (codigo: number) => void, log?: (...m: unknown[]) => void,
   *           plazoMs?: number, cadaMs?: number }} deps
   */
  constructor({
    raiz, versionPropia, puerto, comandoDe, lanzar, consultarVersion = consultarVersionPorHttp,
    salir = (codigo) => process.exit(codigo), log = (...m) => console.log("[supervisor]", ...m),
    plazoMs = PLAZO_VERSION_NUEVA_MS, cadaMs = CONSULTAR_HEALTH_CADA_MS,
  }) {
    this.raiz = raiz;
    this.versionPropia = versionPropia;
    this.puerto = puerto;
    this.comandoDe = comandoDe;
    this.lanzarProceso = lanzar;
    this.consultarVersion = consultarVersion;
    this.salir = salir;
    this.log = log;
    this.plazoMs = plazoMs;
    this.cadaMs = cadaMs;
    this.estado = new EstadoVersiones(raiz);
    this.hijo = null;
    this.version = null;
    this.prueba = null; // { version, motivoFallo } mientras la versión nueva no respondió /health
    this.deteniendo = false;
  }

  iniciar() {
    const estado = this.estado.leer();
    const version = this.versionACorrer(estado);
    if (estado.actual && version !== estado.actual) {
      this.log(`La versión ${estado.actual} no se puede usar (instalador más nuevo o archivo faltante); se corre ${version}`);
      this.estado.escribir({ ...estado, actual: null, anterior: null, probando: false });
    }
    this.lanzar(version, estado.probando && version === estado.actual);
  }

  /** La de actualizacion.json si es más nueva que la del instalador y está en disco; si no, la propia. */
  versionACorrer(estado) {
    const candidata = estado.actual;
    if (!esVersionValida(candidata) || compararVersiones(candidata, this.versionPropia) <= 0) return this.versionPropia;
    return this.comandoDe(candidata) ? candidata : this.versionPropia;
  }

  lanzar(version, enPrueba) {
    const cmd = this.comandoDe(version) || this.comandoDe(this.versionPropia);
    this.version = version;
    this.prueba = enPrueba ? { version, motivoFallo: null } : null;
    this.log(`Iniciando agente ${version}${enPrueba ? ` (en prueba: tiene ${this.plazoMs / 1000} s para responder)` : ""}`);
    const env = { ...process.env, YALO_AGENT_SUPERVISADO: "1", YALO_AGENT_RAIZ: this.raiz };
    const hijo = this.lanzarProceso(cmd.comando, cmd.args, env);
    this.hijo = hijo;
    hijo.on("error", (error) => {
      this.log(`No se pudo iniciar el agente ${version}: ${error.message}`);
      if (this.prueba) this.prueba.motivoFallo = `no se pudo iniciar (${error.message})`;
    });
    hijo.on("exit", (codigo) => {
      if (this.hijo === hijo) this.alSalirHijo(codigo);
    });
    if (enPrueba) this.vigilarPrueba(hijo, version);
  }

  async vigilarPrueba(hijo, version) {
    const limite = Date.now() + this.plazoMs;
    while (this.hijo === hijo && this.prueba && !this.deteniendo) {
      if ((await this.consultarVersion(this.puerto)) === version) {
        this.confirmar(version);
        return;
      }
      if (Date.now() >= limite) {
        this.prueba.motivoFallo = `no respondió /health en ${this.plazoMs / 1000} s`;
        this.log(`La versión ${version} ${this.prueba.motivoFallo}; se vuelve a la anterior`);
        hijo.kill();
        return;
      }
      await esperar(this.cadaMs);
    }
  }

  confirmar(version) {
    this.prueba = null;
    this.estado.modificar((e) => ({
      ...e, probando: false,
      ultimoResultado: { version, de: e.anterior, resultado: "ok", motivo: null, ts: new Date().toISOString(), reportado: false },
    }));
    this.log(`Versión ${version} confirmada: responde /health`);
  }

  alSalirHijo(codigo) {
    if (this.deteniendo || codigo === CODIGO_CTRL_C) {
      this.salir(0);
      return;
    }
    if (this.prueba) {
      this.volverALaAnterior(codigo);
      return;
    }
    const estado = this.estado.leer();
    if (estado.probando && estado.actual !== this.version) {
      // El agente pidió la actualización y se cerró: levantar la nueva ya.
      if (this.versionACorrer(estado) === estado.actual) {
        this.lanzar(estado.actual, true);
        return;
      }
      this.prueba = { version: estado.actual, motivoFallo: "no se encontró el .exe de la versión nueva" };
      this.volverALaAnterior(codigo);
      return;
    }
    this.log(`El agente ${this.version} se cerró (código ${codigo}); nssm lo vuelve a iniciar`);
    this.salir(codigo == null ? CODIGO_FALLO : codigo);
  }

  volverALaAnterior(codigo) {
    const fallida = this.prueba.version;
    const motivo = this.prueba.motivoFallo || `se cerró (código ${codigo}) antes de responder`;
    const estado = this.estado.modificar((e) => ({
      ...e,
      actual: e.anterior,
      anterior: null,
      probando: false,
      fallidas: [...new Set([...(e.fallidas || []), fallida])],
      ultimoResultado: { version: fallida, de: e.anterior, resultado: "fallo", motivo, ts: new Date().toISOString(), reportado: false },
    }));
    this.log(`Rollback: ${fallida} falló (${motivo}); se vuelve a ${estado.actual || this.versionPropia}`);
    this.lanzar(this.versionACorrer(estado), false);
  }

  /** Parada del servicio (Ctrl+C de nssm): cerrar el agente sin tocar nada. */
  detener() {
    if (this.deteniendo) return;
    this.deteniendo = true;
    if (!this.hijo || this.hijo.exitCode !== null) {
      this.salir(0);
      return;
    }
    this.hijo.kill();
  }
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function consultarVersionPorHttp(puerto) {
  try {
    const respuesta = await fetch(`http://127.0.0.1:${puerto}/health`, { signal: AbortSignal.timeout(TIMEOUT_HEALTH_MS) });
    if (!respuesta.ok) return null;
    const datos = await respuesta.json();
    return typeof datos.version === "string" ? datos.version : null;
  } catch {
    return null;
  }
}

/**
 * Cómo correr cada versión. Empaquetado (pkg): la propia es este mismo .exe y las demás están en
 * versions\<v>\. Sin empaquetar (desarrollo): la propia es node + main.js; las demás no existen.
 */
function crearComandoDe({ raiz, versionPropia }) {
  return (version) => {
    if (version === versionPropia) {
      // pkg intercepta spawn de su propio .exe y lo corre como `node`: hay que pasarle el script
      // empaquetado (argv[1], dentro del .exe). Probado con el .exe real. Las versiones de versions\ son
      // otro archivo y no les pasa.
      if (process.pkg) return { comando: process.execPath, args: [process.argv[1], "--agente"] };
      return { comando: process.execPath, args: [...process.execArgv, path.join(__dirname, "..", "main.js"), "--agente"] };
    }
    const exe = path.join(raiz, CARPETA_VERSIONES, version, NOMBRE_EXE);
    return fs.existsSync(exe) ? { comando: exe, args: ["--agente"] } : null;
  };
}

/** Arranque real (main.js). */
function iniciarSupervisor({ versionPropia, puerto }) {
  const { spawn } = require("child_process");
  const raiz = process.env.YALO_AGENT_RAIZ || path.dirname(process.execPath);
  const supervisor = new Supervisor({
    raiz,
    versionPropia,
    puerto,
    comandoDe: crearComandoDe({ raiz, versionPropia }),
    lanzar: (comando, args, env) => spawn(comando, args, { stdio: "inherit", env, windowsHide: true }),
  });
  for (const senal of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(senal, () => supervisor.detener());
  try {
    supervisor.iniciar();
  } catch (error) {
    // El supervisor nunca debe dejar la tienda sin agente: ante cualquier problema, la versión del instalador.
    console.error("[supervisor] Error al elegir versión; se corre la del instalador", error);
    supervisor.lanzar(versionPropia, false);
  }
  return supervisor;
}

module.exports = { Supervisor, iniciarSupervisor, crearComandoDe, PLAZO_VERSION_NUEVA_MS };
