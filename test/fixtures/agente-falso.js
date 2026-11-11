"use strict";
// Agente falso para las pruebas del supervisor:  node agente-falso.js <version> <modo> <puerto>
//   ok      responde /health con su versión
//   crash   se cierra con error al arrancar (versión rota)
//   mudo    queda vivo pero nunca responde /health (versión colgada)
//   pide    responde /health y a los 300 ms pide actualizar a 1.4.0 (como el Actualizador) y sale con 0
const http = require("http");
const fs = require("fs");
const path = require("path");

const [version, modo, puerto] = process.argv.slice(2);

const responder = () =>
  http.createServer((req, res) => res.end(JSON.stringify({ version }))).listen(Number(puerto), "127.0.0.1");

const modos = {
  ok: responder,
  crash: () => setTimeout(() => process.exit(3), 100),
  mudo: () => setInterval(() => undefined, 1000),
  pide: () => {
    responder();
    setTimeout(() => {
      const archivo = path.join(process.env.YALO_AGENT_RAIZ, "actualizacion.json");
      const estado = JSON.parse(fs.existsSync(archivo) ? fs.readFileSync(archivo, "utf8") : "{}");
      fs.writeFileSync(archivo, JSON.stringify({ ...estado, actual: "1.4.0", anterior: version, probando: true }));
      process.exit(0);
    }, 300);
  },
};

modos[modo]();
