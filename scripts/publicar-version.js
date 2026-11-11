"use strict";
// Firma un YaloPrinterService.exe y arma el INSERT para publicarlo en la nube (imp_versionesagente).
//
//   node scripts/publicar-version.js --exe dist/YaloPrinterService.exe --version 1.4.0 \
//        --clave C:\ruta\segura\clave-privada-actualizaciones.pem --url https://.../YaloPrinterService-1.4.0.exe
//
// Pasos para publicar:
//   1. Subir el .exe a donde lo puedan descargar los agentes (la URL de --url).
//   2. Correr este script y ejecutar el INSERT que imprime (arranca sin agentes: porcentaje 0).
//   3. Despliegue escalonado, con UPDATE sobre esa fila:
//        pilotos:  agentespiloto = '34,51'        (codagente de imp_agentesimpresion)
//        parte:    porcentaje = 10, 50...
//        todos:    porcentaje = 100
//      Para frenarla: activo = false (los que ya se actualizaron se quedan; los demás no la bajan).
//
// La clave privada NUNCA va al repo ni se comparte por chat: solo la tiene quien publica.

const fs = require("fs");
const crypto = require("crypto");
const { firmar, firmaValida } = require("../print-core/actualizacion/firma");
const { esVersionValida } = require("../print-core/actualizacion/version");
const { CLAVE_PUBLICA_ACTUALIZACIONES } = require("../print-core/actualizacion/clave-publica");

function leerArgumentos(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--")) throw new Error(`Argumento inesperado: ${argv[i]}`);
    args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

const sqlTexto = (valor) => (valor == null ? "NULL" : `'${String(valor).replace(/'/g, "''")}'`);

function principal() {
  const args = leerArgumentos(process.argv.slice(2));
  for (const requerido of ["exe", "version", "clave", "url"]) {
    if (!args[requerido]) throw new Error(`Falta --${requerido}`);
  }
  if (!esVersionValida(args.version)) throw new Error("La versión tiene que ser mayor.menor.parche (p. ej. 1.4.0)");
  if (!/^https?:\/\//i.test(args.url)) throw new Error("La URL tiene que empezar con http:// o https://");

  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(args.exe)).digest("hex");
  const firma = firmar(fs.readFileSync(args.clave, "utf8"), args.version, sha256);
  if (!firmaValida(CLAVE_PUBLICA_ACTUALIZACIONES, args.version, sha256, firma)) {
    throw new Error("La clave privada no corresponde a la clave pública del agente (print-core/actualizacion/clave-publica.js)");
  }

  const publicacion = { Version: args.version, Url: args.url, Sha256: sha256, Firma: firma, Ventana: args.ventana || null };
  console.log(JSON.stringify(publicacion, null, 2));
  console.log(`
-- Publicar ${args.version} (arranca sin agentes; después: agentespiloto, porcentaje)
INSERT INTO public.imp_versionesagente (version, url, sha256, firma, ventana, agentespiloto, porcentaje, activo, notas, fechacreacion)
VALUES (${sqlTexto(args.version)}, ${sqlTexto(args.url)}, ${sqlTexto(sha256)}, ${sqlTexto(firma)}, ${sqlTexto(args.ventana || null)},
        ${sqlTexto(args.pilotos || null)}, ${Number(args.porcentaje) || 0}, true, ${sqlTexto(args.notas || null)}, now());`);
}

try {
  principal();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
