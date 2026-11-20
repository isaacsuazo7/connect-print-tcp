// YaloPrinterService (agente de impresión Yalo). Servicio de Windows que imprime en las impresoras de red
// del local. La lógica vive en print-core/; acá solo está el servidor HTTP y el armado.
//
// Regla de oro (11-nov-2026): instalarlo no puede romper ningún POS que hoy imprime. Por eso /print sin
// job_id mantiene el contrato de siempre, y el token / CORS restringido arrancan apagados.

const os = require("os");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const exec = require("child_process");
const { version: VERSION } = require("./package.json");
const { respondePing } = require("./print-core/red-local");
const {
  enviarTrabajo,
  RESULTADO,
  ERROR,
  consultarEstado,
  enviarRevisandoEstado,
  esErrorFisico,
  SerializadorPorImpresora,
  RegistroImpresoras,
  esIpDeImpresora,
  Discovery,
  DISCOVERY,
  MonitorImpresoras,
  ESTADO,
  AlmacenCola,
  ColaAgente,
  ESTADO_TRABAJO,
  IdentidadAgente,
  ipDelCliente,
  esLoopback,
  esDeEstaPc,
  ipPrincipal,
  RegistroEventos,
  comoTexto,
  armarTicketPrueba,
  crearProteccion,
  HeartbeatNube,
  Actualizador,
  CLAVE_PUBLICA_ACTUALIZACIONES,
  SIN_IMPRESIONES_MS,
  TablaOui,
  InventarioImpresoras,
} = require("./print-core");

// ---------------------------------------------------------------------------------------------------
// CONFIGURACIÓN
// ---------------------------------------------------------------------------------------------------

/** Puerto fijo (el POS lo busca en el 3000). PORT solo para desarrollo, si el 3000 está ocupado. */
const PUERTO_SERVICIO = Number(process.env.PORT) || 3000;

/**
 * Brief §6.2.1 / prueba P4: escuchar en TODAS las interfaces. Antes se escuchaba en una sola IP decidida
 * al arrancar y después de un apagón nadie lo encontraba. 0.0.0.0 incluye 127.0.0.1.
 */
const HOST_TODAS_LAS_INTERFACES = "0.0.0.0";

/** Identifica al agente nuevo ante el POS (NOMBRE_AGENTE_YALO en print-transport.types.ts). */
const NOMBRE_SERVICIO = "yalo-print-agent";

const CARPETA_DATOS =
  process.env.YALO_AGENT_DATA || path.join(process.env.ProgramData || os.tmpdir(), "Yalo", "PrintAgent");

const INTERVALO_REVISION_RED_MS = 10000;
const INTERVALO_DISCOVERY_MS = 60000;
/** Tras un fallo de conexión se barre la red ya, pero no más de una vez cada 30 s (impresora apagada). */
const ESPERA_ENTRE_RESCATES_MS = 30000;
/**
 * Auto-actualización (brief §6.2.1): solo cuando lo lanza el supervisor (servicio/supervisor.js), que es
 * quien cambia de versión y hace rollback. En desarrollo (node index.js) o sin supervisor, apagada.
 */
const SUPERVISADO = process.env.YALO_AGENT_SUPERVISADO === "1" && Boolean(process.env.YALO_AGENT_RAIZ);
/** Si el supervisor muere (no debería), el agente sale para no quedar huérfano ocupando el puerto. */
const REVISAR_SUPERVISOR_MS = 5000;
/**
 * Tamaño máximo de un pedido (el ticket va en base64 dentro del JSON). El servicio anterior usaba el de
 * body-parser por defecto (100 KB) y rechazaba con 413 tickets de más de ~75 KB, p. ej. con logo
 * (hallazgo del 10-nov). 10 MB alcanza para cualquier ticket con imágenes.
 */
const TAMANO_MAXIMO_PEDIDO = "10mb";
/** /agent/restart espera a que terminen los trabajos en curso, como mucho esto. */
const ESPERA_MAXIMA_REINICIO_MS = 5000;

const STATUS = Object.freeze({
  OK: 200,
  ENCOLADO: 202,
  PEDIDO_INVALIDO: 400,
  PROHIBIDO: 403,
  NO_ENCONTRADO: 404,
  ERROR: 500,
  SIN_CONEXION_IMPRESORA: 502,
  SIN_COLA: 503,
  SIN_CONFIRMACION: 504,
});

const STATUS_POR_RESULTADO = {
  [RESULTADO.IMPRESO]: STATUS.OK,
  [RESULTADO.FALLIDO]: STATUS.SIN_CONEXION_IMPRESORA,
  [RESULTADO.INCIERTO]: STATUS.SIN_CONFIRMACION,
};

/**
 * Lo que la nube puede cambiar por el heartbeat. Protección de la API local apagada por defecto; tiempos
 * de la cola por tipo ({ comanda: { autoMs, duroMs } }) vacíos = los mismos del POS.
 */
const configuracion = { exigirToken: false, restringirCors: false, tiemposCola: {} };

// ---------------------------------------------------------------------------------------------------
// LOG
// ---------------------------------------------------------------------------------------------------

const eventos = new RegistroEventos();
const log = (...mensaje) => {
  console.log(new Date().toISOString(), ...mensaje);
  eventos.agregar(comoTexto(mensaje));
};

// ---------------------------------------------------------------------------------------------------
// PIEZAS
// ---------------------------------------------------------------------------------------------------

const inicio = Date.now();
/** Para no actualizar en plena venta: la auto-actualización espera un rato sin impresiones. */
let ultimaImpresion = 0;
const marcarImpresion = () => {
  ultimaImpresion = Date.now();
};

const ipsLocales = () =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && !i.internal && (i.family === "IPv4" || i.family === 4))
    .map((i) => i.address)
    .sort();
let ipsActuales = ipsLocales();

const identidad = new IdentidadAgente(path.join(CARPETA_DATOS, "agente.json"), { log });
const serializador = new SerializadorPorImpresora();
const registro = new RegistroImpresoras(path.join(CARPETA_DATOS, "impresoras.json"));
/** @type {HeartbeatNube | null} se crea más abajo; las piezas de antes le avisan por acá */
let heartbeat = null;
const avisarANube = (tipo, datos) => {
  if (heartbeat) heartbeat.evento(tipo, datos);
};
const discovery = new Discovery({
  registro,
  log,
  alMoverse: ({ impresora, antes, despues }) =>
    avisarANube("printer_ip_changed", { CodImpresora: impresora.codImpresora, Mac: impresora.mac, IpAnterior: antes, IpNueva: despues }),
});
let ultimoRescate = 0;

const rescatar = () => {
  // OBS-05 (20-nov): la consulta de estado antes del envío ya marca "offline" y eso arranca una búsqueda;
  // el envío que la pide un instante después tiene que ESPERAR esa misma, no seguir de largo sin la IP nueva.
  if (discovery.enCurso) return discovery.enCurso;
  if (Date.now() - ultimoRescate <= ESPERA_ENTRE_RESCATES_MS) return Promise.resolve([]);
  ultimoRescate = Date.now();
  return discovery.ubicar({ forzarBarrido: true });
};

const ESTADOS_SIN_CONEXION = new Set([ESTADO.OFFLINE, ESTADO.NOT_FOUND]);
const monitor = new MonitorImpresoras({
  registro,
  serializador,
  log,
  // Trabada = contesta ping pero no acepta conexiones (QA 20-nov): /health lo dice con `enRed`.
  hacerPing: respondePing,
  alCambiar: ({ impresora, de, a }) => {
    // Se cayó: puede que haya cambiado de IP. Buscarla ya.
    if (ESTADOS_SIN_CONEXION.has(a)) rescatar();
    const evento = { CodImpresora: impresora.codImpresora, Ip: impresora.ip, De: de, A: a, FlushedJobs: 0 };
    // Volvió de una caída: descargar su cola y avisar cuántos salieron (la métrica principal del
    // proyecto: recuperaciones automáticas). "unknown → online" (arranque) no cuenta como recuperación.
    const volvioDeUnaCaida = a === ESTADO.ONLINE && de !== ESTADO.ONLINE && de !== ESTADO.DESCONOCIDO;
    if (volvioDeUnaCaida && cola) {
      cola.alVolver(impresora).then((impresos) => avisarANube("printer_state_changed", { ...evento, FlushedJobs: impresos }));
      return;
    }
    avisarANube("printer_state_changed", evento);
  },
});

// Cola persistente (brief §6.2.4). Solo la usan los pedidos con job_id. Si SQLite no abre, el servicio
// sigue y esos pedidos se imprimen al momento como los demás (nunca dejar de imprimir).
let cola = null;
try {
  cola = new ColaAgente({
    almacen: new AlmacenCola(path.join(CARPETA_DATOS, "queue.db"), { log }),
    registro,
    serializador,
    enviar: (t) => {
      marcarImpresion();
      return enviarSegunEstado(t.impresora, t);
    },
    monitor,
    log,
    ttlNube: () => configuracion.tiemposCola,
    alDescargar: ({ impresora, impresos }) => {
      log(`Recuperación automática: ${impresora.nombre || impresora.clave} imprimió ${impresos} pendiente(s) al volver`);
    },
  });
} catch (error) {
  console.error(new Date().toISOString(), "La cola no está disponible; se imprime al momento", error);
}

// Inventario del parque (brief §8 Fase 2): fabricante por OUI y modelo / serie por GS I. Viaja en el
// heartbeat. Pregunta solo con la cola vacía y sin impresiones en el último minuto.
const tablaOui = new TablaOui({ archivoCorrecciones: path.join(CARPETA_DATOS, "fabricantes-oui.json"), log });
const inventario = new InventarioImpresoras({
  archivo: path.join(CARPETA_DATOS, "inventario.json"),
  registro,
  monitor,
  serializador,
  tablaOui,
  estaOcupado: () => hayImpresionesEnCurso() || Date.now() - ultimaImpresion < SIN_IMPRESIONES_MS,
  log,
});

const impresorasConEstado = () =>
  registro.lista().map((imp) => ({ ...imp, ...monitor.estadoDe(imp), inventario: inventario.datosDe(imp) }));
const ipDelLocal = () => ipPrincipal(ipsActuales, registro.lista().map((i) => i.ip));

// HEARTBEAT (brief §6.2.6) contra la API de QA: Impresoras/Agentes/Heartbeat.

/** Estados en los que la impresora contestó por TCP (aunque tenga la tapa abierta). */
const ESTADOS_QUE_RESPONDEN = new Set([ESTADO.ONLINE, ESTADO.ERROR_TAPA, ESTADO.ERROR_PAPEL, ESTADO.ERROR]);

/** HeartbeatAgenteRequest de la API + lo que pide el brief (la API ignora lo que no conoce). */
function reporteParaNube() {
  const impresoras = registro
    .lista()
    .filter((i) => i.codImpresora) // la nube solo conoce las que tienen código
    .map((i) => {
      const e = monitor.estadoDe(i);
      return {
        CodImpresora: i.codImpresora,
        Ip: i.ip,
        Puerto: String(i.puerto),
        Mac: i.mac,
        Responde: ESTADOS_QUE_RESPONDEN.has(e.estado),
        LatenciaMs: e.latenciaMs ?? null,
        Error: e.estado === ESTADO.ONLINE ? null : e.estado,
        Estado: e.estado,
        Discovery: i.discovery,
        UltimaVez: i.vistaEn,
        ...inventario.datosDe(i),
      };
    });
  return {
    Version: VERSION,
    NombreEquipo: os.hostname(),
    IpLocal: ipDelLocal(),
    Puerto: PUERTO_SERVICIO,
    Impresoras: impresoras,
    IpsLocales: ipsActuales,
    UptimeSegundos: Math.round((Date.now() - inicio) / 1000),
    Modo: "service",
    Cola: cola ? cola.totales() : null,
    // Versión anterior y resultado de la última actualización (brief §6.2.1).
    ...(actualizador ? actualizador.resumen() : {}),
  };
}

/** HeartbeatAgenteRespuesta: la lista de impresoras a vigilar y, cuando la nube lo mande, configuración. */
function aplicarRespuestaNube(datos) {
  if (Array.isArray(datos.Impresoras)) {
    const olvidadas = registro.sincronizarConNube(datos.Impresoras, {
      conservar: (imp) => (cola ? cola.tienePendientes(imp.clave) : false),
    });
    for (const imp of olvidadas) {
      log(`La impresora ${imp.nombre || imp.clave} (${imp.ip}) ya no está en la configuración del local: se deja de vigilar`);
    }
  }
  if (typeof datos.ExigirToken === "boolean") configuracion.exigirToken = datos.ExigirToken;
  if (typeof datos.RestringirCors === "boolean") configuracion.restringirCors = datos.RestringirCors;
  if (datos.TiemposCola && typeof datos.TiemposCola === "object") configuracion.tiemposCola = datos.TiemposCola;
  if (Array.isArray(datos.FabricantesOui)) tablaOui.aplicarCorrecciones(datos.FabricantesOui);
  if (actualizador) actualizador.ofrecer(datos.Actualizacion || null);
}

heartbeat = new HeartbeatNube({ identidad, armarReporte: reporteParaNube, alResponder: aplicarRespuestaNube, log });

/** Hay algo en cola o imprimiéndose: no es momento de reiniciar para actualizar. */
function hayImpresionesEnCurso() {
  if (serializador.impresorasOcupadas > 0) return true;
  if (!cola) return false;
  const totales = cola.totales();
  return cola.procesando.size > 0 || (totales[ESTADO_TRABAJO.PENDIENTE] || 0) > 0 || (totales[ESTADO_TRABAJO.IMPRIMIENDO] || 0) > 0;
}

const actualizador = SUPERVISADO
  ? new Actualizador({
      raiz: process.env.YALO_AGENT_RAIZ,
      versionActual: VERSION,
      clavePublica: CLAVE_PUBLICA_ACTUALIZACIONES,
      estaOcupado: hayImpresionesEnCurso,
      msDesdeUltimaImpresion: () => Date.now() - ultimaImpresion,
      reiniciar: () => reiniciarCuandoTermine(),
      evento: avisarANube,
      log,
    })
  : null;

/** Busca por clave ("cod:12", "ip:10.0.30.243:9100") o por código de impresora ("12"). */
const buscarImpresora = (id) =>
  registro.impresoras.get(id) || (/^\d+$/.test(id) ? registro.buscarPorCodigo(Number(id)) : null);

/**
 * Imprime al momento en donde esté la impresora. Si no conecta y se conoce su MAC, la busca en la red
 * y, si se movió, reintenta UNA vez en la IP nueva (seguro: "fallido" = no se mandó nada).
 */
/**
 * BUG-10 (QA 19-nov): pregunta el estado justo antes de mandar; sin papel o con la tapa abierta no manda
 * nada y devuelve fallido con error sin_papel / tapa_abierta (ver envio-con-estado.js).
 */
async function enviarSegunEstado(impresora, trabajo) {
  if (!impresora) return enviarTrabajo(trabajo);
  const envio = await enviarRevisandoEstado(trabajo, {
    enviar: enviarTrabajo,
    consultar: consultarEstado,
    conocido: monitor.estadoDe(impresora),
  });
  if (envio.consulta) monitor.registrarConsulta(impresora, envio.consulta);
  return envio;
}

const imprimirAhora = (impresora, datos) =>
  serializador.ejecutar(impresora.clave, async () => {
    marcarImpresion();
    let envio = await enviarSegunEstado(impresora, { host: impresora.ip, puerto: impresora.puerto, datos });
    // Solo si no conectó: con papel o tapa la impresora está ahí, buscarla por MAC no cambia nada.
    if (envio.resultado === RESULTADO.FALLIDO && envio.error === ERROR.SIN_CONEXION && (impresora.mac || impresora.macAnterior)) {
      const ipAntes = impresora.ip;
      // OBS-05: primero la MAC anterior en la tabla ARP (rápido, sin freno); si no alcanza, la búsqueda completa.
      await discovery.recuperarConMacAnterior(impresora);
      if (impresora.ip === ipAntes) await rescatar();
      if (impresora.ip !== ipAntes) envio = await enviarSegunEstado(impresora, { host: impresora.ip, puerto: impresora.puerto, datos });
    }
    monitor.registrarEnvio(impresora, envio.resultado, envio.error);
    const capturarMac = !impresora.mac && impresora.discovery !== DISCOVERY.DEGRADADO;
    if (envio.resultado === RESULTADO.IMPRESO && capturarMac) discovery.ubicar(); // en segundo plano
    return envio;
  });

// ---------------------------------------------------------------------------------------------------
// SERVIDOR
// ---------------------------------------------------------------------------------------------------

const app = express();
const proteccion = crearProteccion(() => configuracion, () => identidad.tokenLocal);
app.use(proteccion.cors);
// OBS-14 (QA 19-nov): solo se atiende a esta PC. Las tablets imprimen directo con la APK y ningún local usa
// otra PC imprimiendo a través de esta (confirmado el 20-nov); antes cualquier equipo de la red podía imprimir.
app.use((req, res, next) => {
  if (esDeEstaPc(req.socket.remoteAddress, ipsActuales)) {
    next();
    return;
  }
  log(`Rechazado: ${req.method} ${req.path} desde ${ipDelCliente(req.socket.remoteAddress)} (solo se atiende a esta PC)`);
  res.status(STATUS.PROHIBIDO).send({ message: "Solo se permite desde esta PC" });
});
app.use(bodyParser.json({ limit: TAMANO_MAXIMO_PEDIDO }));
app.use(proteccion.token);

const soloDesdeEstaPc = (req, res, next) => {
  if (esLoopback(req.socket.remoteAddress)) {
    next();
    return;
  }
  res.status(STATUS.PROHIBIDO).send({ message: "Solo se permite desde esta PC" });
};

// HEALTH: lo que el POS necesita para reconocer al agente (SaludAgente en print-transport.types.ts).
app.get("/health", (req, res) => {
  const ahora = Date.now();
  const resumenImpresoras = impresorasConEstado().map((i) => ({
    id: i.clave,
    codImpresora: i.codImpresora,
    nombre: i.nombre,
    ip: i.ip,
    estado: i.estado,
    // Offline pero contesta ping: trabada (el POS dice "apágala y préndela" en vez de revisar cables).
    enRed: i.estado === ESTADO.OFFLINE && !!(i.detalle && i.detalle.enRed),
  }));
  res.status(STATUS.OK).send({
    servicio: NOMBRE_SERVICIO,
    version: VERSION,
    idAgente: identidad.idAgente,
    agent_id: identidad.idAgente,
    vinculado: identidad.vinculado,
    nombreEquipo: os.hostname(),
    ipLocal: ipDelLocal(),
    // D3: IP desde la que este agente ve a quien pregunta (tablet en otra red = otra /24).
    client_ip: ipDelCliente(req.socket.remoteAddress),
    ipsLocales: ipsActuales,
    lan_ips: ipsActuales,
    uptimeSegundos: Math.round((ahora - inicio) / 1000),
    uptime_s: Math.round((ahora - inicio) / 1000),
    impresoras: resumenImpresoras,
    cola: cola ? cola.totales() : null,
    nube: heartbeat.resumen(),
    actualizacion: actualizador ? actualizador.resumen() : null,
  });
});

// VINCULAR: el POS de esta PC pasa lo que le dio la API (Impresoras/Agentes/Vincular).
app.post("/vincular", soloDesdeEstaPc, (req, res) => {
  try {
    const token = identidad.vincular(req.body || {});
    log(`Agente vinculado a la nube: codAgente ${identidad.vinculo.codAgente} (${identidad.vinculo.apiUrl})`);
    res.status(STATUS.OK).send({ message: "OK", token });
    // Reportar enseguida: el POS espera ese primer reporte para que la nube active el servidor de
    // impresión de la caja y le devuelva la lista de impresoras al agente.
    heartbeat.ahora();
  } catch (error) {
    res.status(STATUS.PEDIDO_INVALIDO).send({ message: error.message });
  }
});

// PRINT
// Sin job_id: mismo contrato de siempre, con resultado real: 200 impreso / 502 no conectó / 504 sin
// confirmación. Con job_id: cola, 202 al instante (el mismo job_id otra vez → 200 con su estado).
app.post("/print", async (req, res) => {
  const { printerHost, printerPort, dataToPrint, printerMac, codImpresora, job_id: jobId } = req.body || {};
  const puerto = Number(printerPort);
  if (!printerHost || !Number.isInteger(puerto) || typeof dataToPrint !== "string") {
    res.status(STATUS.PEDIDO_INVALIDO).send({ message: "Faltan printerHost, printerPort o dataToPrint" });
    return;
  }
  // OBS-04: la prueba de Reconectar va a 0.0.0.0. Mismo 502 de siempre (el POS lo toma como "el servicio
  // contestó"), pero sin registrarla como impresora: antes quedaba una fantasma vigilada para siempre.
  if (!esIpDeImpresora(printerHost)) {
    res.status(STATUS.SIN_CONEXION_IMPRESORA).send({ message: "No es la IP de una impresora", error: ERROR.SIN_CONEXION });
    return;
  }
  const datos = Buffer.from(dataToPrint, "base64");
  if (jobId !== undefined && cola) {
    encolarPedido(req.body, datos, res);
    return;
  }
  const clave = `${printerHost}:${puerto}`;
  try {
    const { impresora } = registro.resolverDestino({ ip: printerHost, puerto, mac: printerMac, codImpresora: Number(codImpresora) || null });
    const envio = await imprimirAhora(impresora, datos);
    const redireccion = impresora.ip !== printerHost ? ` (se movió a ${impresora.ip})` : "";
    log(`/print ${clave}${redireccion} ${datos.length} bytes -> ${envio.resultado} en ${envio.ms} ms${envio.error ? ` (${envio.error})` : ""}`);
    if (envio.resultado === RESULTADO.IMPRESO) {
      res.status(STATUS.OK).send({ message: "Impresión exitosa" });
      return;
    }
    if (envio.resultado === RESULTADO.FALLIDO && !esErrorFisico(envio.error)) {
      // Mismo aviso en la PC que antes cuando no se podía conectar.
      showDialogInfoCMD(
        `Error al conectar con la impresora http://${printerHost}/${puerto}, verifica que el YALO Printer Service este conectado a la misma red que la impresora.`
      );
    }
    res.status(STATUS_POR_RESULTADO[envio.resultado]).send({ message: envio.detalle, error: envio.error });
  } catch (error) {
    console.error(new Date().toISOString(), `/print ${clave} error inesperado`, error);
    res.status(STATUS.ERROR).send({ message: String(error) });
  }
});

/** Pista para el POS de cuándo va a salir. */
function pistaDeSalida(trabajo, estadoImpresora) {
  if (trabajo.status !== ESTADO_TRABAJO.PENDIENTE) return null;
  if (estadoImpresora === ESTADO.ONLINE || estadoImpresora === ESTADO.DESCONOCIDO) return "inmediato";
  return "cuando_vuelva_la_impresora";
}

function respuestaTrabajo(trabajo) {
  const impresora = registro.impresoras.get(trabajo.printer_id);
  const estadoImpresora = impresora ? monitor.estadoDe(impresora).estado : ESTADO.DESCONOCIDO;
  return {
    job_id: trabajo.job_id,
    status: trabajo.status,
    printer_state: estadoImpresora,
    eta_hint: pistaDeSalida(trabajo, estadoImpresora),
    attempts: trabajo.attempts,
    last_error: trabajo.last_error,
  };
}

function encolarPedido(cuerpo, datos, res) {
  marcarImpresion();
  try {
    const { nuevo, trabajo } = cola.encolar({
      jobId: cuerpo.job_id,
      ip: cuerpo.printerHost,
      puerto: Number(cuerpo.printerPort),
      codImpresora: Number(cuerpo.codImpresora) || null,
      mac: cuerpo.printerMac,
      tipo: cuerpo.type,
      datos,
      creadoEn: cuerpo.created_at,
      origen: cuerpo.origin_device,
    });
    log(`/print job ${trabajo.job_id} (${trabajo.type}) ${nuevo ? "encolado" : `repetido, ya está ${trabajo.status}`}`);
    res.status(nuevo ? STATUS.ENCOLADO : STATUS.OK).send(respuestaTrabajo(trabajo));
  } catch (error) {
    res.status(STATUS.PEDIDO_INVALIDO).send({ message: error.message });
  }
}

// JOBS
const conCola = (manejador) => (req, res) => {
  if (!cola) {
    res.status(STATUS.SIN_COLA).send({ message: "La cola no está disponible en este equipo" });
    return;
  }
  manejador(req, res);
};

app.get("/jobs", conCola((req, res) => {
  const trabajos = cola.listar({ status: req.query.status, printer_id: req.query.printer_id, limite: req.query.limit });
  res.status(STATUS.OK).send({ trabajos, totales: cola.totales() });
}));

app.get("/jobs/:id", conCola((req, res) => {
  const trabajo = cola.obtener(req.params.id);
  if (!trabajo) {
    res.status(STATUS.NO_ENCONTRADO).send({ message: "No existe ese trabajo" });
    return;
  }
  res.status(STATUS.OK).send(respuestaTrabajo(trabajo));
}));

app.post("/jobs/flush", conCola(async (req, res) => {
  const impresos = await cola.descargar();
  res.status(STATUS.OK).send({ impresos, totales: cola.totales() });
}));

for (const [accion, metodo] of [["confirm", "confirmar"], ["discard", "descartar"]]) {
  app.post(`/jobs/:id/${accion}`, conCola((req, res) => {
    const trabajo = cola[metodo](req.params.id);
    if (!trabajo) {
      res.status(STATUS.NO_ENCONTRADO).send({ message: "No existe ese trabajo" });
      return;
    }
    log(`/jobs ${req.params.id} ${accion} -> ${trabajo.status}`);
    res.status(STATUS.OK).send(respuestaTrabajo(trabajo));
  }));
}

// PRINTERS
app.get("/printers", (req, res) => {
  res.status(STATUS.OK).send({ impresoras: impresorasConEstado() });
});

app.post("/printers/rediscover", async (req, res) => {
  const movidas = await discovery.ubicar({ forzarBarrido: true });
  res.status(STATUS.OK).send({
    movidas: movidas.map((m) => ({ id: m.impresora.clave, antes: m.antes, despues: m.despues })),
    impresoras: impresorasConEstado(),
  });
});

// TEST-PRINT: ticket con número de secuencia, nombre y corte; sin abrir la gaveta.
app.post("/test-print/:printerId", async (req, res) => {
  const impresora = buscarImpresora(req.params.printerId);
  if (!impresora) {
    res.status(STATUS.NO_ENCONTRADO).send({ message: "No se conoce esa impresora" });
    return;
  }
  const secuencia = identidad.siguienteSecuenciaPrueba();
  const datos = armarTicketPrueba({
    secuencia,
    nombre: impresora.nombre || impresora.clave,
    ip: impresora.ip,
    puerto: impresora.puerto,
    version: VERSION,
  });
  const envio = await imprimirAhora(impresora, datos);
  log(`/test-print ${impresora.clave} #${secuencia} -> ${envio.resultado}`);
  res.status(STATUS_POR_RESULTADO[envio.resultado]).send({ secuencia, resultado: envio.resultado, message: envio.detalle, error: envio.error });
});

// AGENT/RESTART: termina lo que está imprimiendo y sale; el servicio de Windows (nssm) lo levanta en ~5 s.
app.post("/agent/restart", soloDesdeEstaPc, (req, res) => {
  log("Reinicio pedido por /agent/restart");
  res.status(STATUS.ENCOLADO).send({ message: "Reiniciando" });
  reiniciarCuandoTermine();
});

function reiniciarCuandoTermine() {
  const limite = Date.now() + ESPERA_MAXIMA_REINICIO_MS;
  const revisar = () => {
    const ocupado = serializador.impresorasOcupadas > 0 || (cola && cola.procesando.size > 0);
    if (ocupado && Date.now() < limite) {
      setTimeout(revisar, 200);
      return;
    }
    log("Saliendo para reiniciar");
    process.exit(0);
  };
  revisar();
}

// LOGS
app.get("/logs", (req, res) => {
  res.status(STATUS.OK).send({ eventos: eventos.desde(req.query.since) });
});

// ---------------------------------------------------------------------------------------------------
// ARRANQUE
// ---------------------------------------------------------------------------------------------------

const servidor = app.listen(PUERTO_SERVICIO, HOST_TODAS_LAS_INTERFACES, () => {
  log(
    `YALO Printer Service ${VERSION} (agente ${identidad.idAgente}) escuchando en el puerto ${PUERTO_SERVICIO} de todas las interfaces:`,
    ["127.0.0.1", ...ipsActuales].map((ip) => `http://${ip}:${PUERTO_SERVICIO}`).join(", ")
  );
});
// Puerto ocupado u otro error al abrirlo: salir con error para que nssm lo vuelva a intentar, en vez de
// quedar vivo sin escuchar.
servidor.on("error", (error) => {
  console.error(new Date().toISOString(), "No se pudo abrir el puerto", PUERTO_SERVICIO, error);
  process.exit(1);
});

monitor.iniciar();
if (cola) cola.iniciar();
setInterval(() => discovery.ubicar(), INTERVALO_DISCOVERY_MS);
if (actualizador) actualizador.iniciar();
inventario.iniciar();
heartbeat.evento("agent_started", { Version: VERSION });
heartbeat.iniciar();

if (SUPERVISADO) {
  const idSupervisor = process.ppid;
  setInterval(() => {
    try {
      process.kill(idSupervisor, 0); // 0 = solo pregunta si existe
    } catch {
      log("El supervisor ya no existe; se sale para que el servicio arranque limpio");
      process.exit(0);
    }
  }, REVISAR_SUPERVISOR_MS).unref();
}

// CAMBIO DE RED: escucha en todas, así que no hace falta reiniciar. Se registra y se buscan las impresoras.
setInterval(() => {
  const ahora = ipsLocales();
  if (ahora.join(",") === ipsActuales.join(",")) return;
  const antes = ipsActuales;
  ipsActuales = ahora;
  log(`La red de la PC cambió: [${antes.join(", ") || "sin red"}] → [${ahora.join(", ") || "sin red"}]`);
  discovery.ubicar({ forzarBarrido: true });
  // La nube corrige el host del servidor de impresión de las cajas con la IP nueva (IpLocal).
  avisarANube("agent_ip_changed", { IpsAnteriores: antes, IpsNuevas: ahora, IpLocal: ipDelLocal() });
}, INTERVALO_REVISION_RED_MS);

// ---------------------------------------------------------------------------------------------------
// AVISO EN PANTALLA (igual que la versión anterior)
// ---------------------------------------------------------------------------------------------------

function showDialogInfoCMD(message) {
  const command = `echo ${message}`;
  exec.exec(
    `start "YaloPrinterService" cmd /c "${command} && timeout /t 10 > nul"`,
    { windowsHide: true },
    (error, stdout, stderr) => {
      if (error) {
        console.error(`Error: ${error.message}`);
        return;
      }
      if (stderr) {
        console.error(`stderr: ${stderr}`);
      }
    }
  );
}
