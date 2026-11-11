"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizarMac, parsearTablaArp, ipsDeMac, macDeIp } = require("../print-core/mac");

// Salida real de `arp -a` en la PC de pruebas (11-nov-2026), Windows en español.
const ARP_REAL = `
Interfaz: 172.27.253.176 --- 0xb
  Dirección de Internet          Dirección física      Tipo
  172.27.248.1          00-ff-a8-15-31-64     dinámico
  172.27.255.255        ff-ff-ff-ff-ff-ff     estático
  224.0.0.22            01-00-5e-00-00-16     estático

Interfaz: 10.0.30.244 --- 0x11
  Dirección de Internet          Dirección física      Tipo
  10.0.30.1             4c-5e-0c-31-10-8d     dinámico
  10.0.30.234           6e-4f-60-1e-ef-35     dinámico
  10.0.30.243           00-61-a2-66-41-ab     dinámico
  10.0.30.255           ff-ff-ff-ff-ff-ff     estático
  239.255.255.250       01-00-5e-7f-ff-fa     estático
  255.255.255.255       ff-ff-ff-ff-ff-ff     estático
`;

test("normalizar: mismo formato que la API", () => {
  assert.equal(normalizarMac("00-61-a2-66-41-ab"), "00:61:A2:66:41:AB");
  assert.equal(normalizarMac(" 00:61:A2:66:41:AB "), "00:61:A2:66:41:AB");
});

test("normalizar: descarta vacías, broadcast, multicast y basura", () => {
  for (const mala of [null, "", "ff-ff-ff-ff-ff-ff", "00-00-00-00-00-00", "01-00-5e-00-00-16", "hola", "00-61-a2-66-41"]) {
    assert.equal(normalizarMac(mala), null, String(mala));
  }
});

test("parsear: salida real, solo equipos (sin broadcast ni multicast)", () => {
  const tabla = parsearTablaArp(ARP_REAL);
  assert.deepEqual(tabla.map((e) => e.ip), ["172.27.248.1", "10.0.30.1", "10.0.30.234", "10.0.30.243"]);
  assert.equal(macDeIp(tabla, "10.0.30.243"), "00:61:A2:66:41:AB");
});

test("parsear: funciona con la salida en otra codificación (acentos rotos)", () => {
  const roto = ARP_REAL.replace(/ó/g, "�").replace(/á/g, "�").replace(/\n/g, "\r\n");
  assert.equal(macDeIp(parsearTablaArp(roto), "10.0.30.243"), "00:61:A2:66:41:AB");
});

test("ipsDeMac: encuentra la IP por MAC, en cualquier formato", () => {
  const tabla = parsearTablaArp(ARP_REAL);
  assert.deepEqual(ipsDeMac(tabla, "00-61-a2-66-41-ab"), ["10.0.30.243"]);
  assert.deepEqual(ipsDeMac(tabla, "AA:AA:AA:AA:AA:AA"), []);
  assert.deepEqual(ipsDeMac(tabla, null), []);
});
