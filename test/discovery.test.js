"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Discovery, prefijosABarrer } = require("../print-core/discovery");
const { RegistroImpresoras, DISCOVERY } = require("../print-core/registro-impresoras");
const { prefijo24 } = require("../print-core/red-local");

const MAC = "00:61:A2:66:41:AB";

/** Red falsa: la tabla ARP "antes" y "después" del barrido, y qué IPs responden en el puerto. */
function redFalsa({ antes = [], despues = antes, responden = [], ips = ["10.0.30.244"] } = {}) {
  const red = {
    barridos: [],
    barrido: false,
    ipsLocales: () => ips,
    prefijo24,
    barrer: async (prefijos) => {
      red.barridos.push(prefijos);
      red.barrido = true;
    },
    leerTablaArp: async () => (red.barrido ? despues : antes),
    puertoResponde: async (ip) => responden.includes(ip),
  };
  return red;
}

function registroCon(...impresoras) {
  const r = new RegistroImpresoras(null);
  for (const i of impresoras) r.resolverDestino({ puerto: 9100, ...i });
  return r;
}

test("la impresora cambió de IP (DHCP): la encuentra por MAC y la mueve", async () => {
  const registro = registroCon({ ip: "10.0.30.243", codImpresora: 12, mac: MAC });
  const red = redFalsa({ antes: [], despues: [{ ip: "10.0.30.57", mac: MAC }], responden: ["10.0.30.57"] });
  const movidas = [];
  const d = new Discovery({ registro, red, alMoverse: (c) => movidas.push(c) });

  await d.ubicar();
  const imp = registro.buscarPorCodigo(12);
  assert.equal(imp.ip, "10.0.30.57");
  assert.equal(imp.discovery, DISCOVERY.OK);
  assert.deepEqual(movidas.map((m) => [m.antes, m.despues]), [["10.0.30.243", "10.0.30.57"]]);
  // Y el POS que sigue mandando la IP vieja imprime en la nueva:
  assert.equal(registro.resolverDestino({ ip: "10.0.30.243", puerto: 9100, codImpresora: 12 }).ip, "10.0.30.57");
});

test("todo en su lugar según la tabla ARP: no barre la red", async () => {
  const registro = registroCon({ ip: "10.0.30.243", mac: MAC });
  const red = redFalsa({ antes: [{ ip: "10.0.30.243", mac: MAC }] });
  await new Discovery({ registro, red }).ubicar();
  assert.equal(red.barridos.length, 0);
  assert.equal(registro.lista()[0].discovery, DISCOVERY.OK);
});

test("apagada: la MAC no aparece y su IP no responde = not_found", async () => {
  const registro = registroCon({ ip: "10.0.30.243", mac: MAC });
  await new Discovery({ registro, red: redFalsa() }).ubicar();
  assert.equal(registro.lista()[0].discovery, DISCOVERY.NO_ENCONTRADA);
  assert.equal(registro.lista()[0].ip, "10.0.30.243", "no se mueve a ningún lado");
});

test("AP isolation / VLAN: no se ve la MAC pero su IP responde = discovery_degraded y sigue en su IP", async () => {
  const registro = registroCon({ ip: "10.0.30.243", mac: MAC });
  await new Discovery({ registro, red: redFalsa({ responden: ["10.0.30.243"] }) }).ubicar();
  assert.equal(registro.lista()[0].discovery, DISCOVERY.DEGRADADO);
  assert.equal(registro.lista()[0].ip, "10.0.30.243");
});

test("captura en alta: sin MAC, responde en su IP → aprende la MAC de la tabla ARP", async () => {
  const registro = registroCon({ ip: "10.0.30.243" });
  // Conectar a su IP deja su MAC en la tabla ARP: no hace falta barrer la red para esto.
  const red = redFalsa({ antes: [{ ip: "10.0.30.243", mac: MAC }], responden: ["10.0.30.243"] });
  await new Discovery({ registro, red }).ubicar();
  assert.equal(red.barridos.length, 0);
  assert.equal(registro.lista()[0].mac, MAC);
  assert.equal(registro.lista()[0].discovery, DISCOVERY.OK);
});

test("entrada vieja en la tabla ARP: con la MAC en dos IPs, vale la que responde", async () => {
  const registro = registroCon({ ip: "10.0.30.243", mac: MAC });
  const tabla = [{ ip: "10.0.30.243", mac: MAC }, { ip: "10.0.30.57", mac: MAC }];
  const red = redFalsa({ antes: tabla, responden: ["10.0.30.57"] });
  await new Discovery({ registro, red }).ubicar();
  assert.equal(registro.lista()[0].ip, "10.0.30.57");
});

test("otra cosa tomó la IP vieja (otra MAC): no se confunde, sigue buscando por la MAC", async () => {
  const registro = registroCon({ ip: "10.0.30.243", mac: MAC });
  const red = redFalsa({ despues: [{ ip: "10.0.30.243", mac: "AA:BB:CC:DD:EE:01" }], responden: ["10.0.30.243"] });
  await new Discovery({ registro, red }).ubicar();
  // Responde algo en esa IP pero no es ella: queda degradada en su IP, nunca se le asigna la MAC ajena.
  assert.equal(registro.lista()[0].mac, MAC);
});

test("una sola pasada a la vez aunque la pidan varias veces", async () => {
  const registro = registroCon({ ip: "10.0.30.243", mac: MAC });
  const red = redFalsa();
  const d = new Discovery({ registro, red });
  await Promise.all([d.ubicar(), d.ubicar(), d.ubicar()]);
  assert.equal(red.barridos.length, 1);
});

test("qué barrer: solo la red de la PC donde hay impresoras (no la VPN); si ninguna, todas", () => {
  const imps = [{ ip: "10.0.30.243", ipConocida: "10.0.30.243" }];
  assert.deepEqual(prefijosABarrer(imps, ["10.0.30.244", "172.27.253.176"], prefijo24), ["10.0.30"]);
  const otraRed = [{ ip: "192.168.5.20", ipConocida: "192.168.5.20" }];
  assert.deepEqual(prefijosABarrer(otraRed, ["10.0.30.244", "172.27.253.176"], prefijo24), ["10.0.30", "172.27.253"]);
});
