"use strict";
// Ticket de prueba (POST /test-print): número de secuencia, nombre de la impresora y corte.
// Sin abrir la gaveta (no lleva ESC p). Solo ASCII: no depende de la página de códigos de la impresora.

const ESC = 0x1b;
const GS = 0x1d;
const INICIAR = [ESC, 0x40];
const CENTRAR = [ESC, 0x61, 1];
const IZQUIERDA = [ESC, 0x61, 0];
const NEGRITA_SI = [ESC, 0x45, 1];
const NEGRITA_NO = [ESC, 0x45, 0];
const AVANZAR_Y_CORTAR = [GS, 0x56, 66, 3]; // avanza 3 líneas y corta parcial

const sinAcentos = (texto) =>
  String(texto)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7e]/g, "?");

/**
 * @param {{ secuencia: number, nombre: string, ip: string, puerto: number, version: string, fecha?: Date }} datos
 * @returns {Buffer}
 */
function armarTicketPrueba({ secuencia, nombre, ip, puerto, version, fecha = new Date() }) {
  const linea = (texto) => Buffer.from(`${sinAcentos(texto)}\n`, "ascii");
  return Buffer.concat([
    Buffer.from(INICIAR),
    Buffer.from(CENTRAR),
    Buffer.from(NEGRITA_SI),
    linea("PRUEBA DE IMPRESION"),
    Buffer.from(NEGRITA_NO),
    linea(`#${secuencia}`),
    Buffer.from(IZQUIERDA),
    linea(""),
    linea(`Impresora: ${nombre}`),
    linea(`Direccion: ${ip}:${puerto}`),
    linea(`Fecha:     ${fecha.toLocaleString("es-HN")}`),
    linea(`Agente:    YaloPrinterService ${version}`),
    linea(""),
    Buffer.from(CENTRAR),
    linea("Si lees esto, la impresora funciona."),
    Buffer.from(AVANZAR_Y_CORTAR),
  ]);
}

module.exports = { armarTicketPrueba };
