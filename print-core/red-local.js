"use strict";
// Lo que toca la red de la PC para el discovery: interfaces, barrido de la /24 y tabla ARP.

const os = require("os");
const dgram = require("dgram");
const net = require("net");
const { execFile } = require("child_process");
const { parsearTablaArp } = require("./mac");

/** Puerto "discard": a nadie le importa recibir algo ahí. Solo interesa que Windows pregunte por ARP. */
const PUERTO_BARRIDO = 9;
/** Tiempo para que lleguen las respuestas ARP después de mandar el barrido (la tarea pide ~2 s total). */
const ESPERA_RESPUESTAS_ARP_MS = 1500;
const TIMEOUT_ARP_MS = 5000;
const TIMEOUT_PRUEBA_PUERTO_MS = 1000;

/** IPv4 de LAN de esta PC (sin loopback). */
function ipsLocales() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && !i.internal && (i.family === "IPv4" || i.family === 4))
    .map((i) => i.address)
    .sort();
}

/** "10.0.30.244" → "10.0.30" (la /24, que es como están armadas las redes de los locales). */
const prefijo24 = (ip) => ip.split(".").slice(0, 3).join(".");

/**
 * Manda un datagrama a cada host de cada /24. No importa si alguien contesta: para mandarlo, Windows
 * tiene que preguntar por ARP quién es esa IP, y la tarjeta de red de la impresora contesta aunque
 * bloquee ping. Después de esto la tabla ARP tiene a todos los equipos encendidos de la red.
 * @param {string[]} prefijos p. ej. ["10.0.30"]
 */
async function barrer(prefijos) {
  if (prefijos.length === 0) return;
  const socket = dgram.createSocket("udp4");
  socket.on("error", () => undefined); // hosts inexistentes: no interesa
  const vacio = Buffer.alloc(0);
  const envios = [];
  for (const prefijo of prefijos) {
    for (let host = 1; host <= 254; host++) {
      envios.push(
        new Promise((ok) => socket.send(vacio, PUERTO_BARRIDO, `${prefijo}.${host}`, () => ok()))
      );
    }
  }
  await Promise.all(envios);
  await new Promise((ok) => setTimeout(ok, ESPERA_RESPUESTAS_ARP_MS));
  socket.close();
}

/** Tabla ARP de Windows (`arp -a`). Vacía si no se pudo leer. */
function leerTablaArp() {
  return new Promise((resolve) => {
    execFile("arp", ["-a"], { timeout: TIMEOUT_ARP_MS, windowsHide: true }, (error, stdout) => {
      if (error) {
        console.error(new Date().toISOString(), "No se pudo leer la tabla ARP", error.message);
        resolve([]);
        return;
      }
      resolve(parsearTablaArp(stdout));
    });
  });
}

/** ¿Algo acepta conexiones en ip:puerto? (para AP isolation / VLAN, donde no se ve la MAC). */
function puertoResponde(ip, puerto, timeoutMs = TIMEOUT_PRUEBA_PUERTO_MS) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: ip, port: Number(puerto) });
    const fin = (valor) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(valor);
    };
    const timer = setTimeout(() => fin(false), timeoutMs);
    socket.on("connect", () => fin(true));
    socket.on("error", () => fin(false));
  });
}

const TIMEOUT_PING_MS = 1000;

/**
 * ¿Contesta un ping? Para separar "apagada / desconectada" (no contesta nada) de "trabada" (contesta el
 * ping pero no acepta conexiones en el 9100; visto con "oficina" el 20-nov-2026: se arregló apagándola).
 * "TTL=" sale en la respuesta de ping de Windows en cualquier idioma; un "host inaccesible" no lo trae.
 */
function respondePing(ip, timeoutMs = TIMEOUT_PING_MS) {
  const argumentos = process.platform === "win32" ? ["-n", "1", "-w", String(timeoutMs), ip] : ["-c", "1", "-W", "1", ip];
  return new Promise((resolve) => {
    execFile("ping", argumentos, { timeout: timeoutMs + 1500, windowsHide: true }, (error, stdout) => {
      resolve(!error && /TTL=/i.test(String(stdout)));
    });
  });
}

module.exports = { ipsLocales, prefijo24, barrer, leerTablaArp, puertoResponde, respondePing };
