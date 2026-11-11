"use strict";
// Cola persistente en SQLite (brief §6.2.4): %ProgramData%\Yalo\PrintAgent\queue.db.
// WAL + synchronous=FULL: un corte de luz a mitad de una escritura no pierde ni corrompe trabajos.
// Usa el SQLite que trae Node 22 (node:sqlite): sin módulos nativos, se empaqueta entero en el .exe.

const fs = require("fs");
const path = require("path");

const ESTADO_TRABAJO = Object.freeze({
  PENDIENTE: "pending",
  IMPRIMIENDO: "printing",
  IMPRESO: "printed",
  POR_CONFIRMAR: "awaiting_confirm",
  FALLIDO: "failed",
  VENCIDO: "expired",
  DESCARTADO: "discarded",
});

const ESTADOS_TERMINADOS = [ESTADO_TRABAJO.IMPRESO, ESTADO_TRABAJO.VENCIDO, ESTADO_TRABAJO.DESCARTADO, ESTADO_TRABAJO.FALLIDO];

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS print_jobs (
  job_id          TEXT PRIMARY KEY,
  printer_id      TEXT NOT NULL,
  printer_host    TEXT NOT NULL,
  printer_port    INTEGER NOT NULL,
  cod_impresora   INTEGER,
  printer_mac     TEXT,
  type            TEXT NOT NULL,
  payload         BLOB NOT NULL,
  created_at      INTEGER NOT NULL,
  received_at     INTEGER NOT NULL,
  auto_ttl_at     INTEGER NOT NULL,
  hard_ttl_at     INTEGER NOT NULL,
  status          TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  printed_at      INTEGER,
  confirmed_at    INTEGER,
  updated_at      INTEGER NOT NULL,
  origin_device   TEXT
);
CREATE INDEX IF NOT EXISTS ix_jobs_cola ON print_jobs (status, printer_id, created_at);
`;

/** Columnas que se devuelven hacia afuera (sin el payload, que puede pesar). */
const COLUMNAS_PUBLICAS =
  "job_id, printer_id, printer_host, printer_port, cod_impresora, type, created_at, received_at, auto_ttl_at, hard_ttl_at, status, attempts, next_attempt_at, last_error, printed_at, confirmed_at, origin_device";

class AlmacenCola {
  /**
   * @param {string} archivo ":memory:" para pruebas
   * @param {{ log?: (...m: unknown[]) => void }} [opciones]
   */
  constructor(archivo, { log = () => undefined } = {}) {
    // require acá adentro: si el Node no trae SQLite, falla solo la cola y no todo el servicio.
    const { DatabaseSync } = require("node:sqlite");
    this.log = log;
    this.db = abrirSano(DatabaseSync, archivo, log);
    this.db.exec(ESQUEMA);
    this.sentencias = {
      insertar: this.db.prepare(`INSERT INTO print_jobs (job_id, printer_id, printer_host, printer_port, cod_impresora, printer_mac, type, payload, created_at, received_at, auto_ttl_at, hard_ttl_at, status, updated_at, origin_device)
        VALUES (:job_id, :printer_id, :printer_host, :printer_port, :cod_impresora, :printer_mac, :type, :payload, :created_at, :received_at, :auto_ttl_at, :hard_ttl_at, :status, :received_at, :origin_device)`),
      obtener: this.db.prepare(`SELECT ${COLUMNAS_PUBLICAS} FROM print_jobs WHERE job_id = ?`),
      payload: this.db.prepare("SELECT payload FROM print_jobs WHERE job_id = ?"),
      siguiente: this.db.prepare(
        `SELECT ${COLUMNAS_PUBLICAS} FROM print_jobs WHERE status = 'pending' AND printer_id = ? ORDER BY created_at, received_at LIMIT 1`
      ),
      impresorasConPendientes: this.db.prepare(
        "SELECT printer_id, MIN(next_attempt_at) AS proximo FROM print_jobs WHERE status = 'pending' GROUP BY printer_id"
      ),
      porConfirmarVencidos: this.db.prepare(
        "UPDATE print_jobs SET status = 'expired', updated_at = :ahora WHERE status = 'awaiting_confirm' AND hard_ttl_at <= :ahora"
      ),
      adelantar: this.db.prepare(
        "UPDATE print_jobs SET next_attempt_at = 0, updated_at = :ahora WHERE status = 'pending' AND (:printer_id IS NULL OR printer_id = :printer_id)"
      ),
      huerfanos: this.db.prepare(
        "UPDATE print_jobs SET status = 'awaiting_confirm', last_error = 'interrupted', updated_at = :ahora WHERE status = 'printing'"
      ),
      purgar: this.db.prepare(
        `DELETE FROM print_jobs WHERE status IN (${ESTADOS_TERMINADOS.map((e) => `'${e}'`).join(",")}) AND updated_at < :antes`
      ),
      totales: this.db.prepare("SELECT status, COUNT(*) AS n FROM print_jobs GROUP BY status"),
    };
  }

  /** @returns {boolean} false si el job_id ya existía (idempotencia) */
  insertar(trabajo) {
    try {
      this.sentencias.insertar.run(trabajo);
      return true;
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) return false;
      throw error;
    }
  }

  obtener(jobId) {
    return this.sentencias.obtener.get(jobId) || null;
  }

  payloadDe(jobId) {
    const fila = this.sentencias.payload.get(jobId);
    return fila ? Buffer.from(fila.payload) : null;
  }

  /** El pendiente más viejo de esa impresora (el orden importa: nunca se salta uno). */
  siguientePendiente(printerId) {
    return this.sentencias.siguiente.get(printerId) || null;
  }

  impresorasConPendientes() {
    return this.sentencias.impresorasConPendientes.all();
  }

  /** Cambia campos de un trabajo. */
  actualizar(jobId, cambios) {
    const campos = Object.keys(cambios);
    const sql = `UPDATE print_jobs SET ${campos.map((c) => `${c} = :${c}`).join(", ")}, updated_at = :__ahora WHERE job_id = :__id`;
    this.db.prepare(sql).run({ ...cambios, __ahora: Date.now(), __id: jobId });
  }

  /** Lo que quedó "imprimiendo" cuando se cortó la luz: no se sabe si salió → que pregunte. */
  recuperarInterrumpidos() {
    return Number(this.sentencias.huerfanos.run({ ahora: Date.now() }).changes);
  }

  vencerPorConfirmar(ahora) {
    return Number(this.sentencias.porConfirmarVencidos.run({ ahora }).changes);
  }

  /** Que los pendientes (de una impresora o de todas) se intenten ya, sin esperar el backoff. */
  adelantar(printerId = null) {
    this.sentencias.adelantar.run({ ahora: Date.now(), printer_id: printerId });
  }

  purgar(antes) {
    return Number(this.sentencias.purgar.run({ antes }).changes);
  }

  /**
   * @param {{ status?: string, printer_id?: string, limite?: number }} filtro
   */
  listar(filtro = {}) {
    const condiciones = [];
    const valores = {};
    if (filtro.status) {
      condiciones.push("status = :status");
      valores.status = filtro.status;
    }
    if (filtro.printer_id) {
      condiciones.push("printer_id = :printer_id");
      valores.printer_id = filtro.printer_id;
    }
    const where = condiciones.length ? `WHERE ${condiciones.join(" AND ")}` : "";
    valores.limite = Math.min(Number(filtro.limite) || 200, 1000);
    return this.db.prepare(`SELECT ${COLUMNAS_PUBLICAS} FROM print_jobs ${where} ORDER BY created_at DESC LIMIT :limite`).all(valores);
  }

  /** { pending: 3, awaiting_confirm: 1, ... } */
  totales() {
    return Object.fromEntries(this.sentencias.totales.all().map((f) => [f.status, Number(f.n)]));
  }

  cerrar() {
    this.db.close();
  }
}

/**
 * Abre la base y revisa que esté sana. Si está corrupta, la aparta (queue.db.corrupta-<fecha>) y crea
 * una nueva, con log: es preferible perder la cola a que el agente no arranque.
 */
function abrirSano(DatabaseSync, archivo, log) {
  if (archivo !== ":memory:") fs.mkdirSync(path.dirname(archivo), { recursive: true });
  let db = null;
  try {
    db = new DatabaseSync(archivo);
    configurar(db);
    const { integrity_check: resultado } = db.prepare("PRAGMA integrity_check").get();
    if (resultado === "ok") return db;
    throw new Error(`integrity_check: ${resultado}`);
  } catch (error) {
    if (archivo === ":memory:") throw error;
    cerrarSinFallar(db); // Windows no deja mover un archivo abierto
    const apartada = `${archivo}.corrupta-${Date.now()}`;
    log(`Cola corrupta (${error.message}); se aparta en ${apartada} y se crea una nueva`);
    for (const sufijo of ["", "-wal", "-shm"]) {
      if (fs.existsSync(archivo + sufijo)) fs.renameSync(archivo + sufijo, apartada + sufijo);
    }
    return configurar(new DatabaseSync(archivo));
  }
}

function cerrarSinFallar(db) {
  try {
    if (db) db.close();
  } catch (error) {
    // Ya estaba cerrada o nunca se abrió del todo: no hay nada más que hacer.
    void error;
  }
}

function configurar(db) {
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
  return db;
}

module.exports = { AlmacenCola, ESTADO_TRABAJO };
