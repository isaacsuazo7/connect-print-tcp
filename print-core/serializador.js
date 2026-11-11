"use strict";
// Un trabajo a la vez por impresora; impresoras distintas en paralelo (brief §6.2.3).
// Así una impresora caída o colgada no retrasa a las demás, y dos tickets a la misma impresora no se
// mezclan.

class SerializadorPorImpresora {
  constructor() {
    /** @type {Map<string, Promise<unknown>>} última tarea encolada por impresora */
    this.colas = new Map();
  }

  /**
   * Corre `tarea` cuando terminen las anteriores de la misma impresora.
   * @template T
   * @param {string} clave impresora, p. ej. "10.0.30.243:9100"
   * @param {() => Promise<T>} tarea
   * @returns {Promise<T>}
   */
  ejecutar(clave, tarea) {
    const anterior = this.colas.get(clave) ?? Promise.resolve();
    // El fallo de una tarea no frena a la siguiente.
    const actual = anterior.catch(() => undefined).then(tarea);
    this.colas.set(clave, actual);
    const limpiar = () => {
      if (this.colas.get(clave) === actual) this.colas.delete(clave);
    };
    actual.then(limpiar, limpiar);
    return actual;
  }

  /** Cuántas impresoras tienen trabajos en curso o esperando. */
  get impresorasOcupadas() {
    return this.colas.size;
  }
}

module.exports = { SerializadorPorImpresora };
