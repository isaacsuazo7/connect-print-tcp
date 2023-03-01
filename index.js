const net = require("net");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const ip = require("ip");
const network = require("network");
var dialog = require("dialog-node");

const app = express();
const hostPort = 3000;
let hostname = ip.address();

let dialogActive = false;

app.use(cors());
app.use(bodyParser.json());

// POST PRINT

app.post("/print", async (req, res) => {
  try {
    const { printerHost, printerPort, dataToPrint } = req.body;
    const uint8Array = new Uint8Array(Buffer.from(dataToPrint, "base64"));
    await print(printerHost, printerPort, uint8Array);
    res.status(200).send({ message: "Impresión exitosa" });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: error });
  }
});

// CONNECT TCP PRINTER AND PRINT

const print = async (printerHost, printerPort, dataToPrint) => {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();

    client.on("error", (err) => {
      const error = `Error al conectar con la impresora http://${printerHost}/${printerPort}, verifica que el Servicio de red de Impresoras YALO este conectado a la misma red que la impresora.`;
      showDialogError("Error", error);
      reject(error);
    });

    client.connect({ port: printerPort, host: printerHost }, () => {
      console.log(
        `Conexión TCP establecida en http://${printerHost}/${printerPort}.`
      );

      client.write(dataToPrint, () => {
        console.log("Impresión exitosa");
        client.end();
        resolve();
      });
    });
  });
};

// START SERVER

const startServer = () => {
  server = app.listen(hostPort, hostname, () => {
    console.log(`Servidor ejecutándose en: http://${hostname}:${hostPort}`);
    showDialogInfo(
      `Servicio de red de Impresoras YALO`,
      `El servicio de red de impresoras YALO se esta ejecutando en la red http://${hostname}/${hostPort} , verifica que esta sea la red correcta.`
    );
  });
};

startServer();

// RESTART SERVER

const restartServer = () => {
  if (server) {
    server.close(() => {
      console.log("Servicio de red de Impresoras YALO reiniciado.");
      startServer();
    });
  } else {
    startServer();
  }
};

setInterval(() => {
  network.get_active_interface((err, iface) => {
    if (err) {
      console.error(err);
      showDialogError(
        "Servicio de red de Impresoras YALO",
        "Servicio de red de Impresoras YALO se detuvo ya que no tiene conexión a la red."
      );
      return;
    }

    if (hostname !== iface.ip_address) {
      console.log(
        `Current HOSTNAME ${hostname} === Current IP ADDRESS ${iface.ip_address}`
      );
      hostname = iface.ip_address;
      restartServer();
    }
  });
}, 15000);

// Dialogs

const showDialogInfo = (title, message) => {
  if (!dialogActive) {
    dialogActive = true;
    dialog.info(message, title, 0, () => dialogActive = false);
  }
};

const showDialogError = (title, message) => {
  if (!dialogActive) {
    dialogActive = true;
    dialog.error(message, title, 0, () => dialogActive = false);
  }
};
