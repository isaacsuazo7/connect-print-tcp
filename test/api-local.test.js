"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { tokenValido, origenPermitido } = require("../print-core/seguridad");
const { ipPrincipal, ipDelCliente, esLoopback } = require("../print-core/red-del-agente");
const { IdentidadAgente } = require("../print-core/identidad-agente");
const { RegistroEventos } = require("../print-core/registro-eventos");
const { armarTicketPrueba } = require("../print-core/ticket-prueba");

const APAGADA = { exigirToken: false, restringirCors: false };
const ENCENDIDA = { exigirToken: true, restringirCors: true };

test("token apagado (por defecto): todo pasa, como hoy", () => {
  assert.equal(tokenValido(APAGADA, null, { ruta: "/print", token: undefined }), true);
});

test("token encendido: sin token o con uno malo, 401; /health siempre libre", () => {
  assert.equal(tokenValido(ENCENDIDA, "abc", { ruta: "/print", token: undefined }), false);
  assert.equal(tokenValido(ENCENDIDA, "abc", { ruta: "/print", token: "xyz" }), false);
  assert.equal(tokenValido(ENCENDIDA, "abc", { ruta: "/print", token: "abc" }), true);
  assert.equal(tokenValido(ENCENDIDA, "abc", { ruta: "/health", token: undefined }), true);
  assert.equal(tokenValido(ENCENDIDA, null, { ruta: "/print", token: "cualquiera" }), false, "sin vincular no hay token válido");
});

test("CORS restringido: orígenes del POS sí, otros no; sin Origin (no es navegador) sí", () => {
  for (const ok of ["https://app.yalocobro.com", "https://qa.yalocobro.com", "http://localhost:4200", "capacitor://localhost", "file://", undefined]) {
    assert.equal(origenPermitido(ENCENDIDA, ok), true, String(ok));
  }
  for (const malo of ["https://evil.com", "https://yalocobro.com.evil.com", "http://10.0.30.50:8080"]) {
    assert.equal(origenPermitido(ENCENDIDA, malo), false, malo);
  }
  assert.equal(origenPermitido(APAGADA, "https://evil.com"), true, "apagado = como hoy");
});

test("ipLocal: con Wi-Fi + VPN gana la red de las impresoras", () => {
  assert.equal(ipPrincipal(["10.0.30.244", "172.27.253.176"], ["10.0.30.243"]), "10.0.30.244");
  assert.equal(ipPrincipal(["172.27.253.176", "192.168.5.10"], ["192.168.5.20", "192.168.5.21"]), "192.168.5.10");
  assert.equal(ipPrincipal(["169.254.1.1", "10.0.30.244"], []), "10.0.30.244", "nunca link-local");
  assert.equal(ipPrincipal([], []), null);
});

test("client_ip y loopback", () => {
  assert.equal(ipDelCliente("::ffff:10.0.30.50"), "10.0.30.50");
  assert.equal(esLoopback("::ffff:127.0.0.1"), true);
  assert.equal(esLoopback("::1"), true);
  assert.equal(esLoopback("10.0.30.50"), false);
});

test("identidad: GUID estable entre reinicios; vincular valida y guarda; token nuevo por vínculo", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agente-"));
  const archivo = path.join(dir, "agente.json");
  const a = new IdentidadAgente(archivo);
  assert.match(a.idAgente, /^[0-9a-f-]{36}$/);
  assert.equal(a.vinculado, false);
  assert.throws(() => a.vincular({ codAgente: 0, llave: "x".repeat(20), apiUrl: "https://qa" }), /codAgente/);
  assert.throws(() => a.vincular({ codAgente: 5, llave: "corta", apiUrl: "https://qa" }), /llave/);
  assert.throws(() => a.vincular({ codAgente: 5, llave: "x".repeat(20), apiUrl: "ftp://x" }), /apiUrl/);
  const token = a.vincular({ codAgente: 5, llave: "x".repeat(20), apiUrl: "https://qaposapi.yalocobro.com/api/" });

  const b = new IdentidadAgente(archivo);
  assert.equal(b.idAgente, a.idAgente);
  assert.equal(b.vinculado, true);
  assert.equal(b.vinculo.apiUrl, "https://qaposapi.yalocobro.com/api");
  assert.equal(b.tokenLocal, token);
  assert.equal(b.siguienteSecuenciaPrueba(), 1);
  assert.equal(new IdentidadAgente(archivo).siguienteSecuenciaPrueba(), 2);
  b.desvincular();
  assert.equal(new IdentidadAgente(archivo).vinculado, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("logs: guarda los últimos y filtra por since", async () => {
  const r = new RegistroEventos(3);
  r.agregar("uno");
  await new Promise((ok) => setTimeout(ok, 5));
  const corte = new Date().toISOString();
  await new Promise((ok) => setTimeout(ok, 5));
  r.agregar("dos");
  r.agregar("tres");
  r.agregar("cuatro");
  assert.deepEqual(r.desde().map((e) => e.mensaje), ["dos", "tres", "cuatro"]);
  assert.deepEqual(r.desde(corte).map((e) => e.mensaje), ["dos", "tres", "cuatro"]);
});

test("ticket de prueba: secuencia, nombre, corte y SIN abrir gaveta", () => {
  const t = armarTicketPrueba({ secuencia: 7, nombre: "Cocina ñandú", ip: "10.0.30.243", puerto: 9100, version: "1.3.0" });
  const texto = t.toString("latin1");
  assert.ok(texto.includes("PRUEBA DE IMPRESION"));
  assert.ok(texto.includes("#7"));
  assert.ok(texto.includes("Cocina nandu"), "sin acentos");
  assert.ok(t.includes(Buffer.from([0x1d, 0x56])), "corta");
  assert.ok(!t.includes(Buffer.from([0x1b, 0x70])), "no abre la gaveta (ESC p)");
});
