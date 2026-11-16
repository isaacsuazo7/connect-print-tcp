"use strict";
// print-core: la lógica de impresión de red, sin Express ni servicio de Windows, para que la use el
// servicio y (más adelante) Electron embebido con un solo comportamiento. Brief §6.2.7.

module.exports = {
  ...require("./envio"),
  ...require("./serializador"),
  ...require("./estado-impresora"),
  ...require("./mac"),
  ...require("./registro-impresoras"),
  ...require("./discovery"),
  ...require("./monitor-impresoras"),
  ...require("./cola/politica"),
  ...require("./cola/almacen"),
  ...require("./cola/cola-agente"),
  ...require("./identidad-agente"),
  ...require("./red-del-agente"),
  ...require("./registro-eventos"),
  ...require("./ticket-prueba"),
  ...require("./seguridad"),
  ...require("./nube/heartbeat"),
  ...require("./actualizacion/version"),
  ...require("./actualizacion/firma"),
  ...require("./actualizacion/estado-versiones"),
  ...require("./actualizacion/actualizador"),
  ...require("./actualizacion/clave-publica"),
  ...require("./inventario/oui"),
  ...require("./inventario/gs-i"),
  ...require("./inventario/inventario"),
};
