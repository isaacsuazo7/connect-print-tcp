"use strict";
// Las impresoras que conoce el agente, guardadas en disco (sobreviven reinicios). Brief §6.2.2.
//
// Se aprenden de dos lados:
//  - del POS: cada /print dice a qué IP imprimir (y el POS PrinterConfig agrega codImpresora y MAC);
//  - de la nube: la respuesta del heartbeat (API de Nelson) trae la lista del establecimiento.
//
// Por impresora se guardan DOS IPs:
//  - ipConocida: la que tienen el POS / la nube (la que llega en /print).
//  - ip: donde está de verdad, según la MAC en la tabla ARP.
// Si el POS manda la ipConocida y la impresora se movió, se imprime en `ip` (la nueva) sin tocar el POS.
// Si el POS manda OTRA IP, es que alguien la reconfiguró: se le hace caso y se olvida la MAC vieja.

const fs = require("fs");
const path = require("path");
const { normalizarMac } = require("./mac");

const ORIGEN = Object.freeze({ POS: "pos", NUBE: "nube" });
const DISCOVERY = Object.freeze({ OK: "ok", DEGRADADO: "discovery_degraded", NO_ENCONTRADA: "not_found" });

/**
 * @typedef {object} Impresora
 * @property {string} clave          "cod:12" o "ip:10.0.30.243:9100" si no se sabe el código
 * @property {number|null} codImpresora
 * @property {string|null} nombre
 * @property {string|null} mac
 * @property {string|null} [macAnterior] la que tenía antes de que el POS la reconfigurara (OBS-05)
 * @property {string} ipConocida
 * @property {string} ip
 * @property {number} puerto
 * @property {string} origen
 * @property {string|null} discovery
 * @property {string|null} vistaEn      ISO de la última vez que respondió
 */

const claveDe = (codImpresora, ip, puerto) =>
  Number.isInteger(codImpresora) && codImpresora > 0 ? `cod:${codImpresora}` : `ip:${ip}:${puerto}`;

/**
 * ¿Puede ser la IP de una impresora? OBS-04 (QA 19-nov): Reconectar del POS identifica el servicio con un
 * /print de prueba a 0.0.0.0 cuando no puede leer /health; eso quedaba registrado como una impresora sin
 * nombre que se vigilaba para siempre (siempre "offline"). 0.0.0.0 o vacía no es una impresora.
 * @param {unknown} ip
 */
function esIpDeImpresora(ip) {
  return typeof ip === "string" && ip.trim() !== "" && ip.trim() !== "0.0.0.0";
}

class RegistroImpresoras {
  /** @param {string | null} archivo null = solo en memoria (pruebas) */
  constructor(archivo) {
    this.archivo = archivo;
    /** @type {Map<string, Impresora>} */
    this.impresoras = new Map();
    this.cargar();
  }

  cargar() {
    if (!this.archivo || !fs.existsSync(this.archivo)) return;
    try {
      const lista = JSON.parse(fs.readFileSync(this.archivo, "utf8"));
      // OBS-04: las fantasmas que quedaron guardadas antes del arreglo (0.0.0.0) se olvidan al arrancar.
      for (const imp of Array.isArray(lista) ? lista : []) if (esIpDeImpresora(imp.ip)) this.impresoras.set(imp.clave, imp);
      // BUG-25: los duplicados sin código que ya aprendieron la MAC de una impresora con código, también.
      const macsConCodigo = new Set(this.lista().filter((i) => i.codImpresora && i.mac).map((i) => i.mac));
      for (const imp of this.lista()) if (!imp.codImpresora && imp.mac && macsConCodigo.has(imp.mac)) this.impresoras.delete(imp.clave);
    } catch (error) {
      // Archivo roto (corte de luz a mitad de escritura): se empieza de cero y se reaprende.
      console.error(new Date().toISOString(), "Registro de impresoras ilegible, se empieza vacío", error.message);
    }
  }

  guardar() {
    if (!this.archivo) return;
    try {
      fs.mkdirSync(path.dirname(this.archivo), { recursive: true });
      const temporal = `${this.archivo}.tmp`;
      fs.writeFileSync(temporal, JSON.stringify(this.lista(), null, 2));
      fs.renameSync(temporal, this.archivo); // reemplazo atómico: nunca queda a medias
    } catch (error) {
      console.error(new Date().toISOString(), "No se pudo guardar el registro de impresoras", error.message);
    }
  }

  /** @returns {Impresora[]} */
  lista() {
    return [...this.impresoras.values()];
  }

  buscarPorCodigo(codImpresora) {
    return this.impresoras.get(`cod:${codImpresora}`) ?? null;
  }

  buscarPorIpConocida(ip, puerto) {
    return this.lista().find((i) => i.ipConocida === ip && i.puerto === puerto) ?? null;
  }

  /** Impresora con código que hoy está en esa IP (puede no ser la que el POS tiene configurada). */
  buscarConCodigoPorIpActual(ip, puerto) {
    return this.lista().find((i) => i.codImpresora && i.ip === ip && i.puerto === puerto) ?? null;
  }

  /**
   * A dónde imprimir lo que el POS mandó a ip:puerto. Registra la impresora si es nueva.
   * @param {{ ip: string, puerto: number, codImpresora?: number|null, mac?: string|null }} pedido
   * @returns {{ impresora: Impresora, ip: string, redirigida: boolean }}
   */
  resolverDestino(pedido) {
    const cod = Number.isInteger(pedido.codImpresora) && pedido.codImpresora > 0 ? pedido.codImpresora : null;
    let imp = (cod && this.buscarPorCodigo(cod)) || this.buscarPorIpConocida(pedido.ip, pedido.puerto);
    const esOtraImpresora = imp && cod && imp.codImpresora && imp.codImpresora !== cod;

    // BUG-25 (QA ronda 3): un pedido sin código a la IP donde HOY está una impresora con código es para esa
    // impresora; antes se creaba un registro "ip:…" que después aprendía su MAC (duplicado). No se reconfigura:
    // sin código no hay nada que diga que su IP cambió.
    const conCodigoEnEsaIp = !cod && !imp ? this.buscarConCodigoPorIpActual(pedido.ip, pedido.puerto) : null;
    if (conCodigoEnEsaIp) {
      return { impresora: conCodigoEnEsaIp, ip: conCodigoEnEsaIp.ip, redirigida: false };
    }

    if (!imp || esOtraImpresora) {
      imp = this.nueva({ codImpresora: cod, ip: pedido.ip, puerto: pedido.puerto, mac: pedido.mac, origen: ORIGEN.POS });
      return { impresora: imp, ip: imp.ip, redirigida: false };
    }

    if (cod && !imp.codImpresora) this.asignarCodigo(imp, cod);

    if (imp.ipConocida !== pedido.ip || imp.puerto !== pedido.puerto) {
      // La reconfiguraron (SAC o la nube ya corrigió la IP): manda lo que dice el POS.
      this.reconfigurar(imp, pedido.ip, pedido.puerto, pedido.mac);
      return { impresora: imp, ip: imp.ip, redirigida: false };
    }

    const macPos = normalizarMac(pedido.mac);
    if (macPos && !imp.mac) {
      imp.mac = macPos;
      this.guardar();
    }
    return { impresora: imp, ip: imp.ip, redirigida: imp.ip !== pedido.ip };
  }

  /**
   * Lista que manda la nube en la respuesta del heartbeat (ImpresoraParaAgente).
   *
   * La lista es completa: una impresora con código que la nube ya no manda se borró o se desactivó en la
   * configuración (SAC la cambió, pasó a USB...). Se olvida, para no seguir vigilándola ni reportarla
   * caída (alerta falsa a SAC; visto el 16-nov al borrar impresoras de prueba). Salvo las que
   * `conservar` diga (p. ej. con trabajos pendientes en la cola: si no, la cola la volvería a crear).
   * Las que no tienen código (solo IP, aprendidas del POS) no se tocan: la nube no las conoce.
   *
   * @param {{ CodImpresora: number, Nombre?: string, Ip?: string, Puerto?: string, Mac?: string }[]} lista
   * @param {{ conservar?: (imp: Impresora) => boolean }} [opciones]
   * @returns {Impresora[]} las que se olvidaron
   */
  sincronizarConNube(lista, { conservar = () => false } = {}) {
    for (const n of lista) {
      const puerto = Number(n.Puerto) || 9100;
      // Por IP solo se une con una que todavía no tiene código (la aprendió del POS). Una con OTRO código
      // en esa IP es otra impresora: SAC borró la vieja y creó una nueva con la misma IP (16-nov: la nueva
      // quedaba pegada al código viejo y nunca se vigilaba). La vieja se olvida más abajo.
      const porIp = n.Ip ? this.buscarPorIpConocida(n.Ip, puerto) : null;
      const imp = this.buscarPorCodigo(n.CodImpresora) || (porIp && !porIp.codImpresora ? porIp : null);
      if (!imp) {
        if (!n.Ip) continue;
        this.nueva({ codImpresora: n.CodImpresora, nombre: n.Nombre, ip: n.Ip, puerto, mac: n.Mac, origen: ORIGEN.NUBE });
        continue;
      }
      if (!imp.codImpresora) this.asignarCodigo(imp, n.CodImpresora);
      imp.nombre = n.Nombre ?? imp.nombre;
      imp.origen = ORIGEN.NUBE;
      if (n.Ip && (n.Ip !== imp.ipConocida || puerto !== imp.puerto)) {
        // La nube ya tiene otra IP (la corrigió con nuestro reporte o la cambió SAC).
        imp.ipConocida = n.Ip;
        imp.puerto = puerto;
        if (normalizarMac(n.Mac) !== imp.mac) imp.ip = n.Ip;
      }
      const macNube = normalizarMac(n.Mac);
      if (macNube) imp.mac = macNube;
    }
    const enLaNube = new Set(lista.map((n) => n.CodImpresora));
    const olvidadas = this.lista().filter((i) => i.codImpresora && !enLaNube.has(i.codImpresora) && !conservar(i));
    for (const imp of olvidadas) this.impresoras.delete(imp.clave);
    this.guardar();
    return olvidadas;
  }

  /** El discovery la vio por MAC en otra IP. */
  moverA(imp, ipNueva) {
    imp.ip = ipNueva;
    this.guardar();
  }

  aprenderMac(imp, mac) {
    const normalizada = normalizarMac(mac);
    if (!normalizada || imp.mac === normalizada) return;
    // BUG-25 (QA ronda 3): un registro sin código (creado por un pedido sin codImpresora) aprendió la MAC de
    // "Test" y desde ahí cada cambio de Test salía dos veces. Si esa MAC ya es de una impresora con código,
    // este es un duplicado: se olvida.
    if (!imp.codImpresora && this.lista().some((i) => i !== imp && i.codImpresora && i.mac === normalizada)) {
      this.impresoras.delete(imp.clave);
      this.guardar();
      return;
    }
    imp.mac = normalizada;
    imp.macAnterior = null; // la IP nueva respondió: es esta impresora, la anterior ya no cuenta (OBS-05)
    this.guardar();
  }

  marcarDiscovery(imp, estado) {
    if (imp.discovery === estado) return;
    imp.discovery = estado;
    if (estado !== DISCOVERY.NO_ENCONTRADA) imp.vistaEn = new Date().toISOString();
    this.guardar();
  }

  nueva({ codImpresora, nombre = null, ip, puerto, mac = null, origen }) {
    /** @type {Impresora} */
    const imp = {
      clave: claveDe(codImpresora, ip, puerto),
      codImpresora: codImpresora || null,
      nombre: nombre || null,
      mac: normalizarMac(mac),
      ipConocida: ip,
      ip,
      puerto,
      origen,
      discovery: null,
      vistaEn: null,
    };
    this.impresoras.set(imp.clave, imp);
    this.guardar();
    return imp;
  }

  asignarCodigo(imp, codImpresora) {
    this.impresoras.delete(imp.clave);
    imp.codImpresora = codImpresora;
    imp.clave = claveDe(codImpresora, imp.ip, imp.puerto);
    this.impresoras.set(imp.clave, imp);
    this.guardar();
  }

  /**
   * La MAC vieja no se sigue (si cambiaron la impresora por otra, llevaría los tickets a la anterior): se
   * vuelve a capturar en la IP nueva. Pero se guarda aparte en `macAnterior`. OBS-05 (QA 19-nov, visto el
   * 20-nov): un POS con la IP vieja / equivocada "reconfiguraba" y el primer ticket fallaba sin buscarla por
   * MAC. El discovery solo usa `macAnterior` si la IP nueva NO responde (ver Discovery.capturarMac).
   */
  reconfigurar(imp, ip, puerto, mac) {
    const macPos = normalizarMac(mac);
    imp.macAnterior = macPos ? null : imp.mac || imp.macAnterior || null;
    imp.ipConocida = ip;
    imp.ip = ip;
    imp.puerto = puerto;
    imp.mac = macPos;
    imp.discovery = null;
    this.guardar();
  }

  /** La IP nueva no responde y la MAC anterior está en otra IP: es la misma impresora (OBS-05). */
  recuperarMacAnterior(imp) {
    imp.mac = imp.macAnterior;
    imp.macAnterior = null;
    this.guardar();
  }
}

module.exports = { RegistroImpresoras, ORIGEN, DISCOVERY, esIpDeImpresora };
