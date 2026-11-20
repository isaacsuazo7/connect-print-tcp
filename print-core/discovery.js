"use strict";
// Re-ubicar impresoras por MAC cuando cambian de IP (DHCP tras un bajón). Brief §6.2.2, caso El Chanchito.
//
// Cada pasada:
//  1. Lee la tabla ARP. Si todas las impresoras con MAC están donde se esperaba, no hace falta barrer.
//  2. Si falta alguna (o se pide forzar): barrido de la /24 para que Windows llene la tabla ARP, y relee.
//  3. Por impresora: MAC vista en otra IP → se mueve ahí (printer_ip_changed). MAC no vista pero su IP
//     responde → discovery_degraded (AP isolation / VLAN), se sigue usando esa IP. Nada → not_found.
//  4. Impresoras sin MAC todavía: si su IP responde, se captura la MAC de la tabla ARP.

const { ipsDeMac, macDeIp } = require("./mac");
const { DISCOVERY } = require("./registro-impresoras");
const redReal = require("./red-local");

/**
 * Qué /24 barrer: las de esta PC donde hay impresoras. Si ninguna impresora está en una red de la PC
 * (la PC cambió de red), todas las de la PC. Así no se barre la red de la VPN sin necesidad.
 * @param {{ ip: string, ipConocida: string }[]} impresoras
 * @param {string[]} ipsDeLaPc
 * @param {(ip: string) => string} prefijo24
 */
function prefijosABarrer(impresoras, ipsDeLaPc, prefijo24) {
  const propios = [...new Set(ipsDeLaPc.map(prefijo24))];
  const conImpresoras = new Set(impresoras.flatMap((i) => [i.ip, i.ipConocida]).filter(Boolean).map(prefijo24));
  const elegidos = propios.filter((p) => conImpresoras.has(p));
  return elegidos.length ? elegidos : propios;
}

class Discovery {
  /**
   * @param {{ registro: import("./registro-impresoras").RegistroImpresoras, red?: typeof redReal,
   *           alMoverse?: (cambio: { impresora: object, antes: string, despues: string }) => void,
   *           log?: (...m: unknown[]) => void }} deps
   */
  constructor({ registro, red = redReal, alMoverse = () => undefined, log = () => undefined }) {
    this.registro = registro;
    this.red = red;
    this.alMoverse = alMoverse;
    this.log = log;
    /** @type {Promise<object[]> | null} una sola pasada a la vez */
    this.enCurso = null;
  }

  /**
   * @param {{ forzarBarrido?: boolean }} [opciones]
   * @returns {Promise<{ impresora: object, antes: string, despues: string }[]>} las que se movieron
   */
  ubicar(opciones = {}) {
    if (this.enCurso) return this.enCurso;
    this.enCurso = this.pasada(opciones)
      .catch((error) => {
        this.log("Discovery falló", error);
        return [];
      })
      .finally(() => {
        this.enCurso = null;
      });
    return this.enCurso;
  }

  async pasada({ forzarBarrido = false }) {
    const impresoras = this.registro.lista();
    if (impresoras.length === 0) return [];

    let tabla = await this.red.leerTablaArp();
    // Solo una impresora con MAC conocida que no está donde se esperaba justifica barrer la red. Las que
    // no tienen MAC se capturan con la conexión directa (no hace falta barrer), y barrer cada minuto por
    // una impresora de otra red que nunca va a aparecer en el ARP sería ruido.
    const falta = impresoras.some((i) => (i.mac && !ipsDeMac(tabla, i.mac).includes(i.ip)) || (!i.mac && i.macAnterior));
    if (forzarBarrido || falta) {
      await this.red.barrer(prefijosABarrer(impresoras, this.red.ipsLocales(), this.red.prefijo24));
      tabla = await this.red.leerTablaArp();
    }

    const movidas = [];
    for (const imp of impresoras) {
      const movida = await this.ubicarUna(imp, tabla);
      if (movida) movidas.push(movida);
    }
    return movidas;
  }

  async ubicarUna(imp, tabla) {
    if (!imp.mac) {
      return this.capturarMac(imp, tabla);
    }

    let ips = ipsDeMac(tabla, imp.mac);
    if (ips.length > 1) {
      // Puede quedar una entrada vieja en la tabla: vale la IP donde la impresora contesta.
      ips = await this.filtrarLasQueResponden(ips, imp.puerto);
    }
    if (ips.includes(imp.ip)) {
      this.registro.marcarDiscovery(imp, DISCOVERY.OK);
      return null;
    }
    if (ips.length > 0) {
      const antes = imp.ip;
      const despues = ips[0];
      this.registro.moverA(imp, despues);
      this.registro.marcarDiscovery(imp, DISCOVERY.OK);
      const cambio = { impresora: imp, antes, despues };
      this.log(`printer_ip_changed ${imp.nombre || imp.clave} (${imp.mac}): ${antes} → ${despues}`);
      this.alMoverse(cambio);
      return cambio;
    }
    if (await this.red.puertoResponde(imp.ip, imp.puerto)) {
      this.cambiarEstado(imp, DISCOVERY.DEGRADADO, "su MAC no se ve en la red, pero su IP responde");
      return null;
    }
    this.cambiarEstado(imp, DISCOVERY.NO_ENCONTRADA, "revisa que esté encendida y el cable con luz verde");
    return null;
  }

  /** @returns {Promise<{ impresora: object, antes: string, despues: string } | null>} si se movió (OBS-05) */
  async capturarMac(imp, tabla) {
    if (!(await this.red.puertoResponde(imp.ip, imp.puerto))) {
      const recuperada = await this.buscarConMacAnterior(imp, tabla);
      if (recuperada) return recuperada;
      this.cambiarEstado(imp, DISCOVERY.NO_ENCONTRADA, "no responde y todavía no se conoce su MAC");
      return null;
    }
    // Recién conectamos: la tabla ARP ya tiene su MAC (si está en la misma red de la PC).
    const mac = macDeIp(tabla, imp.ip) || macDeIp(await this.red.leerTablaArp(), imp.ip);
    if (!mac) {
      this.cambiarEstado(imp, DISCOVERY.DEGRADADO, "responde, pero su MAC no se ve (otra red o AP isolation)");
      return;
    }
    this.registro.aprenderMac(imp, mac);
    this.log(`MAC capturada ${imp.nombre || imp.clave}: ${mac}`);
    this.registro.marcarDiscovery(imp, DISCOVERY.OK);
    return null;
  }

  /**
   * OBS-05: un envío falló en la IP que mandó el POS y la impresora tiene MAC anterior. Sin barrer la red
   * (eso tiene freno de 30 s): basta la tabla ARP de Windows, que ya la tiene si estuvo en la red hace poco.
   * Así el ticket sale al primer intento aunque el POS siga mandando la IP vieja en cada venta.
   */
  async recuperarConMacAnterior(imp) {
    if (imp.mac || !imp.macAnterior) return null;
    return this.buscarConMacAnterior(imp, await this.red.leerTablaArp());
  }

  /**
   * OBS-05: el POS la reconfiguró a una IP donde no hay nada (la vieja de su config o un error al tipear).
   * Si la MAC que tenía antes está en otra IP, es la misma impresora: se mueve ahí. Solo cuando la IP nueva
   * no responde: si responde, es otra impresora y se captura su MAC (capturarMac).
   */
  async buscarConMacAnterior(imp, tabla) {
    if (!imp.macAnterior) return null;
    const ips = await this.filtrarLasQueResponden(ipsDeMac(tabla, imp.macAnterior), imp.puerto);
    if (ips.length === 0) return null;
    const antes = imp.ip;
    const despues = ips[0];
    this.registro.recuperarMacAnterior(imp);
    this.registro.moverA(imp, despues);
    this.registro.marcarDiscovery(imp, DISCOVERY.OK);
    const cambio = { impresora: imp, antes, despues };
    this.log(`printer_ip_changed ${imp.nombre || imp.clave} (${imp.mac}, la MAC que tenía): ${antes} → ${despues}`);
    this.alMoverse(cambio);
    return cambio;
  }

  async filtrarLasQueResponden(ips, puerto) {
    const responden = await Promise.all(ips.map((ip) => this.red.puertoResponde(ip, puerto)));
    return ips.filter((_, i) => responden[i]);
  }

  cambiarEstado(imp, estado, motivo) {
    if (imp.discovery !== estado) this.log(`${estado} ${imp.nombre || imp.clave} (${imp.ip}): ${motivo}`);
    this.registro.marcarDiscovery(imp, estado);
  }
}

module.exports = { Discovery, prefijosABarrer };
