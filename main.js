"use strict";
// Punto de entrada del .exe (npm run build empaqueta este archivo).
//
//   YaloPrinterService.exe            → supervisor (lo que ejecuta nssm): elige la versión y la vigila.
//   YaloPrinterService.exe --agente   → el agente (index.js). Lo lanza el supervisor.
//
// En desarrollo se sigue usando `npm start` (index.js directo, sin supervisor ni auto-actualización).

const { version: VERSION } = require("./package.json");

const PUERTO_POR_DEFECTO = 3000;

if (process.argv.includes("--agente")) {
  require("./index.js");
} else {
  require("./servicio/supervisor").iniciarSupervisor({
    versionPropia: VERSION,
    puerto: Number(process.env.PORT) || PUERTO_POR_DEFECTO,
  });
}
