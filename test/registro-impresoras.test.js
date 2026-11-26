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

test("lo que la nube ya no manda se olvida, salvo lo que hay que conservar y lo que no tiene código", () => {
  const r = new RegistroImpresoras(null);
  r.resolverDestino({ ip: "10.0.30.99", puerto: 9100 }); // solo IP, del POS: la nube no la conoce
  r.sincronizarConNube([
    { CodImpresora: 12, Ip: "10.0.30.243", Puerto: "9100", Mac: MAC },
    { CodImpresora: 13, Ip: "10.0.30.60", Puerto: "9100" },
    { CodImpresora: 14, Ip: "10.0.30.61", Puerto: "9100" },
  ]);

  // SAC borró la 13 y la 14; la 14 todavía tiene trabajos en la cola.
  const olvidadas = r.sincronizarConNube([{ CodImpresora: 12, Ip: "10.0.30.243", Puerto: "9100", Mac: MAC }], {
    conservar: (imp) => imp.codImpresora === 14,
  });

  assert.deepEqual(olvidadas.map((i) => i.codImpresora), [13]);
  assert.deepEqual(r.lista().map((i) => i.clave).sort(), ["cod:12", "cod:14", "ip:10.0.30.99:9100"]);
});

test("SAC borra una impresora y crea otra con la misma IP: la nueva entra con su código, la vieja se olvida", () => {
  const r = new RegistroImpresoras(null);
  r.sincronizarConNube([{ CodImpresora: 12, Nombre: "cocina", Ip: "10.0.30.60", Puerto: "9100", Mac: MAC }]);

  const olvidadas = r.sincronizarConNube([{ CodImpresora: 20, Nombre: "cocina nueva", Ip: "10.0.30.60", Puerto: "9100" }]);

  assert.deepEqual(olvidadas.map((i) => i.codImpresora), [12]);
  const nueva = r.buscarPorCodigo(20);
  assert.equal(nueva.nombre, "cocina nueva");
  assert.equal(nueva.mac, null, "la MAC de la vieja no se hereda");
  assert.deepEqual(r.lista().map((i) => i.clave), ["cod:20"]);
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

test("OBS-04: 0.0.0.0 o vacía no es una impresora; las fantasmas guardadas se olvidan al arrancar", () => {
  const { esIpDeImpresora } = require("../print-core/registro-impresoras");
  assert.equal(esIpDeImpresora("10.0.30.243"), true);
  assert.equal(esIpDeImpresora("0.0.0.0"), false);
  assert.equal(esIpDeImpresora(""), false);
  assert.equal(esIpDeImpresora(null), false);

  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const archivo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "registro-")), "impresoras.json");
  fs.writeFileSync(archivo, JSON.stringify([
    { clave: "cod:977", codImpresora: 977, ip: "10.0.30.243", ipConocida: "10.0.30.243", puerto: 9100 },
    { clave: "ip:0.0.0.0:9100", codImpresora: null, ip: "0.0.0.0", ipConocida: "0.0.0.0", puerto: 9100 },
  ]));
  const registro = new RegistroImpresoras(archivo);
  assert.deepEqual(registro.lista().map((i) => i.clave), ["cod:977"]);
});

// BUG-25 (QA ronda 3, 25-nov): registro "ip:192.168.10.201:9100" sin código con la MAC de Test.
test("un registro sin código que aprende la MAC de una impresora con código se olvida (duplicado)", () => {
  const r = new RegistroImpresoras(null);
  r.resolverDestino({ ip: "192.168.10.241", puerto: 9100, codImpresora: 1414, mac: "00:61:8F:6A:3A:5F" });
  const { impresora: fantasma } = r.resolverDestino({ ip: "192.168.10.201", puerto: 9100 });
  assert.equal(r.lista().length, 2);

  r.aprenderMac(fantasma, "00:61:8F:6A:3A:5F");

  assert.equal(r.lista().length, 1, "quedó solo Test");
  assert.equal(r.lista()[0].codImpresora, 1414);
});

test("al arrancar se olvidan los duplicados sin código con la MAC de una impresora con código", () => {
  const archivo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reg-")), "impresoras.json");
  fs.writeFileSync(archivo, JSON.stringify([
    { clave: "cod:1414", codImpresora: 1414, nombre: "Test", mac: "00:61:8F:6A:3A:5F", ipConocida: "192.168.10.241", ip: "192.168.10.241", puerto: 9100 },
    { clave: "ip:192.168.10.201:9100", codImpresora: null, nombre: null, mac: "00:61:8F:6A:3A:5F", ipConocida: "192.168.10.201", ip: "192.168.10.241", puerto: 9100 },
  ]));
  const r = new RegistroImpresoras(archivo);
  assert.deepEqual(r.lista().map((i) => i.clave), ["cod:1414"]);
});

// BUG-25 (QA ronda 3): el origen del duplicado, un pedido sin código a una IP donde ya hay una con código.
test("pedido sin código a la IP donde hoy está una impresora con código: usa esa, sin crear duplicado", () => {
  const r = new RegistroImpresoras(null);
  const { impresora: test1 } = r.resolverDestino({ ip: "192.168.10.201", puerto: 9100, codImpresora: 1414, mac: "00:61:8F:6A:3A:5F" });
  r.moverA(test1, "192.168.10.205"); // el discovery la encontró en otra IP; el POS (con código) sigue en la .201

  const d = r.resolverDestino({ ip: "192.168.10.205", puerto: 9100 });

  assert.equal(d.impresora, test1);
  assert.equal(r.lista().length, 1, "no se creó un registro ip:…");
  assert.equal(test1.ipConocida, "192.168.10.201", "no se reconfiguró por un pedido sin código");
});

test("pedido sin código a una IP desconocida: se registra como siempre (POS de producción)", () => {
  const r = new RegistroImpresoras(null);
  r.resolverDestino({ ip: "192.168.10.201", puerto: 9100, codImpresora: 1414 });
  const d = r.resolverDestino({ ip: "192.168.10.50", puerto: 9100 });
  assert.equal(r.lista().length, 2);
  assert.equal(d.ip, "192.168.10.50");
});
