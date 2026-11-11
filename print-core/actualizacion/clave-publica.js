"use strict";
// Clave pública con la que el agente verifica las versiones que publica la nube. La privada NO está en
// este repo: la guarda quien publica versiones (ver scripts/publicar-version.js). Si se cambia esta
// clave, los agentes ya instalados solo aceptan versiones firmadas con la anterior: hay que publicar una
// versión intermedia, firmada con la vieja, que traiga la nueva clave.
const CLAVE_PUBLICA_ACTUALIZACIONES = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAJ8tvSmjgxFE2WOi0+fGaI5ktWfuCg4J1Y/345/27eRU=
-----END PUBLIC KEY-----
`;

module.exports = { CLAVE_PUBLICA_ACTUALIZACIONES };
