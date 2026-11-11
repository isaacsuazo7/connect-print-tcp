"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { RegistroImpresoras, ORIGEN } = require("../print-core/registro-impresoras");

const MAC = "00:61:A2:66:41:AB";

test("POS de producción (solo IP): la registra y la usa tal cual", () => {
  const r = new RegistroImpresoras(null);
  const d = r.resolverDestino({ ip: "10.0.30.243", puerto: 9100 });
  assert.equal(d.ip, "10.0.30.243");
  assert.equal(d.redirigida, false);
  assert.equal(d.impresora.clave, "ip:10.0.30.243:9100");
  assert.equal(d.impresora.origen, ORIGEN.POS);
});

test("POS PrinterConfig: guarda código y MAC que manda", () => {
  const r = new RegistroImpresoras(null);
  const d = r.resolverDestino({ ip: "10.0.30.243", puerto: 9100, codImpresora: 12, mac: "00-61-a2-66-41-ab" });
  assert.equal(d.impresora.clave, "cod:12");
  assert.equal(d.impresora.mac, MAC);
});

test("se movió (por MAC) y el POS sigue mandando la IP vieja: imprime en la nueva", () => {
  const r = new RegistroImpresoras(null);
  const { impresora } = r.resolverDestino({ ip: "10.0.30.243", puerto: 9100, mac: MAC });
  r.moverA(impresora, "10.0.30.57");
  const d = r.resolverDestino({ ip: "10.0.30.243", puerto: 9100 });
  assert.equal(d.ip, "10.0.30.57");
  assert.equal(d.redirigida, true);
});

test("el POS manda OTRA IP (la reconfiguraron): se le hace caso y se olvida la MAC vieja", () => {
  const r = new RegistroImpresoras(null);
  const { impresora } = r.resolverDestino({ ip: "10.0.30.243", puerto: 9100, codImpresora: 12, mac: MAC });
  r.moverA(impresora, "10.0.30.57");
  const d = r.resolverDestino({ ip: "10.0.30.80", puerto: 9100, codImpresora: 12 });
  assert.equal(d.ip, "10.0.30.80");
  assert.equal(d.redirigida, false);
  assert.equal(d.impresora.mac, null);
});

test("aprendida por IP y después llega con código: se une, no se duplica", () => {
  const r = new RegistroImpresoras(null);
  r.resolverDestino({ ip: "10.0.30.243", puerto: 9100 });
  r.resolverDestino({ ip: "10.0.30.243", puerto: 9100, codImpresora: 12 });
  assert.deepEqual(r.lista().map((i) => i.clave), ["cod:12"]);
});

test("misma IP con otro código: son dos impresoras distintas, no se mezclan", () => {
  const r = new RegistroImpresoras(null);
  r.resolverDestino({ ip: "10.0.30.243", puerto: 9100, codImpresora: 12 });
  r.resolverDestino({ ip: "10.0.30.243", puerto: 9100, codImpresora: 13 });
  assert.deepEqual(r.lista().map((i) => i.clave).sort(), ["cod:12", "cod:13"]);
});

test("lista de la nube: crea, nombra y une con lo aprendido del POS", () => {
  const r = new RegistroImpresoras(null);
  r.resolverDestino({ ip: "10.0.30.243", puerto: 9100 });
  r.sincronizarConNube([
    { CodImpresora: 12, Nombre: "oficina", Ip: "10.0.30.243", Puerto: "9100", Mac: MAC },
    { CodImpresora: 13, Nombre: "Cocina", Ip: "10.0.30.60", Puerto: "9100", Mac: null },
  ]);
  const oficina = r.buscarPorCodigo(12);
  assert.equal(oficina.nombre, "oficina");
  assert.equal(oficina.mac, MAC);
  assert.equal(oficina.origen, ORIGEN.NUBE);
  assert.equal(r.buscarPorCodigo(13).ip, "10.0.30.60");
  assert.equal(r.lista().length, 2);
});

test("la nube corrige la IP a donde la encontramos: queda todo alineado", () => {
  const r = new RegistroImpresoras(null);
  r.sincronizarConNube([{ CodImpresora: 12, Ip: "10.0.30.243", Puerto: "9100", Mac: MAC }]);
  const imp = r.buscarPorCodigo(12);
  r.moverA(imp, "10.0.30.57");
  r.sincronizarConNube([{ CodImpresora: 12, Ip: "10.0.30.57", Puerto: "9100", Mac: MAC }]);
  assert.equal(imp.ipConocida, "10.0.30.57");
  assert.equal(imp.ip, "10.0.30.57");
  const d = r.resolverDestino({ ip: "10.0.30.57", puerto: 9100, codImpresora: 12 });
  assert.equal(d.redirigida, false);
});

test("se guarda en disco y sobrevive un reinicio; archivo roto = empieza vacío sin caerse", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "registro-"));
  const archivo = path.join(dir, "impresoras.json");
  const r1 = new RegistroImpresoras(archivo);
  const { impresora } = r1.resolverDestino({ ip: "10.0.30.243", puerto: 9100, codImpresora: 12, mac: MAC });
  r1.moverA(impresora, "10.0.30.57");

  const r2 = new RegistroImpresoras(archivo);
  assert.equal(r2.buscarPorCodigo(12).ip, "10.0.30.57");

  fs.writeFileSync(archivo, "{ roto");
  assert.equal(new RegistroImpresoras(archivo).lista().length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
