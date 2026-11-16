"use strict";
// Genera print-core/inventario/oui-datos.js con la tabla de fabricantes por MAC (OUI) de la IEEE.
// Inventario del parque de impresoras (brief §8 Fase 2).
//
// Uso:
//   node scripts/generar-oui.js                 baja https://standards-oui.ieee.org/oui/oui.csv
//   node scripts/generar-oui.js ruta/oui.csv    usa un CSV ya bajado
//
// Solo MA-L (prefijos de 24 bits, ~40 mil). Se guarda "PREFIJO\tNombre" por línea, comprimido con gzip y
// en base64 dentro de un .js, para que ncc/pkg lo metan en el exe sin configurar assets.
// Para tener la tabla nueva en las PCs: regenerar, publicar una versión del agente (auto-actualización).
// Las correcciones puntuales llegan antes por la nube (imp_fabricantesoui, en la respuesta del heartbeat).

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const URL_IEEE = "https://standards-oui.ieee.org/oui/oui.csv";
const DESTINO = path.join(__dirname, "..", "print-core", "inventario", "oui-datos.js");
const LARGO_MAXIMO_NOMBRE = 60;
const PATRON_PREFIJO = /^[0-9A-F]{6}$/;

/** Separa una línea CSV respetando comillas ("Nokia, Inc."). */
function camposCsv(linea) {
  const campos = [];
  let actual = "";
  let entreComillas = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i];
    if (c === '"' && entreComillas && linea[i + 1] === '"') {
      actual += '"';
      i++;
      continue;
    }
    if (c === '"') {
      entreComillas = !entreComillas;
      continue;
    }
    if (c === "," && !entreComillas) {
      campos.push(actual);
      actual = "";
      continue;
    }
    actual += c;
  }
  campos.push(actual);
  return campos;
}

const limpiarNombre = (nombre) => nombre.replace(/[\t\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, LARGO_MAXIMO_NOMBRE);

/** @param {string} csv @returns {Map<string, string>} */
function leerCsvIeee(csv) {
  const tabla = new Map();
  for (const linea of csv.split(/\r?\n/).slice(1)) {
    if (!linea.trim()) continue;
    const [registro, prefijo, nombre] = camposCsv(linea);
    if (registro !== "MA-L") continue;
    const p = String(prefijo).trim().toUpperCase();
    const n = limpiarNombre(String(nombre || ""));
    if (!PATRON_PREFIJO.test(p) || !n) continue;
    tabla.set(p, n);
  }
  return tabla;
}

async function main() {
  const origen = process.argv[2];
  const csv = origen ? fs.readFileSync(origen, "utf8") : await (await fetch(URL_IEEE, { headers: { "User-Agent": "yalo-print-agent-build" } })).text();
  const tabla = leerCsvIeee(csv);
  if (tabla.size < 30000) throw new Error(`La tabla tiene solo ${tabla.size} prefijos; ¿bajó bien el CSV?`);

  const texto = [...tabla.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([p, n]) => `${p}\t${n}`).join("\n");
  const base64 = zlib.gzipSync(Buffer.from(texto, "utf8"), { level: 9 }).toString("base64");
  const fecha = new Date().toISOString().slice(0, 10);
  const js = [
    '"use strict";',
    "// GENERADO por scripts/generar-oui.js: no editar a mano.",
    `// Tabla OUI (MA-L) de la IEEE del ${fecha}: ${tabla.size} prefijos. "PREFIJO\\tNombre" por línea, gzip + base64.`,
    `module.exports = { VERSION_OUI: "${fecha}", PREFIJOS: ${tabla.size}, DATOS: "${base64}" };`,
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(DESTINO), { recursive: true });
  fs.writeFileSync(DESTINO, js);
  console.log(`${DESTINO}: ${tabla.size} prefijos, ${Math.round(js.length / 1024)} KB`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { leerCsvIeee, camposCsv };
