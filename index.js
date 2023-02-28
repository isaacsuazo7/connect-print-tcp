const Net = require("net");
// const EscPosEncoder = require("esc-pos-encoder");
const express = require("express");
const bodyParser = require('body-parser');
const cors = require("cors");
const ip = require("ip");

const app = express();
app.use(cors());
app.use(bodyParser.json());

app.post("/print", async (req, res) => {
  try {
    const {host, port, toPrint} = req.body;
    console.log(req.body);
    const uint8Array = new Uint8Array(Buffer.from(toPrint, 'base64'));
    await printTest(host, port, uint8Array);

    res.status(200).send({ message: "Impresión exitosa" });
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Error al imprimir" });
  }
});

async function printTest(host, port, uint8Array) {
  return new Promise((resolve, reject) => {
    const client = new Net.Socket();

    client.connect({ port: port, host: host }, () => {
      console.log(`TCP connection established with ${host}:${port}.`);

      client.write(
        uint8Array,
        () => {
          console.log("Impresión exitosa");
          client.end();
          resolve();
        },
        (err) => {
          console.log(err);
          client.end();
          reject(err);
        }
      );
    });

    client.on("error", (error) => {
      console.log(`Error de conexión con ${host}:${port}.`);
      client.end();
      reject(error);
    });
  });
}

const PORT = 3000;
const HOSTNAME = ip.address();

app.listen(PORT, HOSTNAME, () => {
  console.log(`Servidor ejecutandose en: http://${HOSTNAME}/${PORT}`);
});
