"use strict";
// BUG-12 (QA ronda 2, 24-nov): el POS espera al agente un tiempo fijo; si el agente tarda más (impresora
// apagada + búsqueda en la red), el POS lo da por "incierto" y cierra la comanda como impresa aunque no
// salió. Esto deja esperar una tarea solo hasta un momento dado, sin cancelarla: sigue en segundo plano.

/**
 * ¿Terminó `promesa` antes de `limite` (epoch ms)? Si se pasa del límite resuelve `false` y la promesa
 * sigue corriendo (sus errores se descartan aquí: quien la creó ya los registra). Nunca rechaza.
 * @param {Promise<unknown>} promesa
 * @param {number} limite
 * @param {() => number} [ahora] solo para pruebas
 * @returns {Promise<boolean>}
 */
function terminaAntesDe(promesa, limite, ahora = Date.now) {
  const restante = limite - ahora();
  const segura = promesa.then(
    () => true,
    () => true
  );
  if (restante <= 0) return Promise.resolve(false);
  let temporizador;
  const corte = new Promise((resolve) => {
    temporizador = setTimeout(() => resolve(false), restante);
  });
  return Promise.race([segura, corte]).finally(() => clearTimeout(temporizador));
}

module.exports = { terminaAntesDe };
