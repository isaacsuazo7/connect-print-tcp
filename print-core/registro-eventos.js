"use strict";
// Últimos eventos del agente en memoria, para GET /logs?since= (adjuntar a soporte). El log completo
// queda en el archivo que escribe nssm.

const MAXIMO_EVENTOS = 1000;

class RegistroEventos {
  constructor(maximo = MAXIMO_EVENTOS) {
    this.maximo = maximo;
    /** @type {{ ts: string, mensaje: string }[]} */
    this.eventos = [];
  }

  agregar(mensaje) {
    this.eventos.push({ ts: new Date().toISOString(), mensaje });
    if (this.eventos.length > this.maximo) this.eventos.splice(0, this.eventos.length - this.maximo);
  }

  /** @param {string | undefined} desde ISO; sin él, todos */
  desde(desde) {
    const limite = Date.parse(desde || "");
    if (!Number.isFinite(limite)) return [...this.eventos];
    return this.eventos.filter((e) => Date.parse(e.ts) > limite);
  }
}

/** Convierte lo que se pasaría a console.log en una línea de texto. */
function comoTexto(partes) {
  return partes
    .map((p) => {
      if (p instanceof Error) return p.message;
      if (typeof p === "string") return p;
      try {
        return JSON.stringify(p);
      } catch {
        return String(p);
      }
    })
    .join(" ");
}

module.exports = { RegistroEventos, comoTexto };
