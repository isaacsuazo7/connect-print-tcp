const net = require("net");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const ip = require("ip");
const network = require("network");
const exec = require("child_process");
const app = express();
const hostPort = 3000;
let hostname = ip.address();

app.use(cors());
app.use(bodyParser.json());

// POST PRINT

app.post("/print", async (req, res) => {
  try {
    const { printerHost, printerPort, dataToPrint } = req.body;
    const uint8Array = new Uint8Array(Buffer.from(dataToPrint, "base64"));
    await resolvePrint(printerHost, printerPort, uint8Array);
    res.status(200).send({ message: "Impresión exitosa" });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: error });
  }
});

// CONNECT TCP PRINTER AND PRINT

// const print = async (printerHost, printerPort, dataToPrint) => {
//   return new Promise((resolve, reject) => {
//     const client = new net.Socket();

//     client.on("error", (err) => {
//       const error = `Error al conectar con la impresora http://${printerHost}/${printerPort}, verifica que el YALO Printer Service este conectado a la misma red que la impresora.`;
//       showDialogInfoCMD(error);
//       reject(error);
//     });

//     client.connect({ port: printerPort, host: printerHost }, () => {
//       console.log(
//         `Conexión TCP establecida en http://${printerHost}/${printerPort}.`
//       );
//       client.write(dataToPrint, () => {
//         client.end();
//         resolve();
//       });
//     });
//   });
// };

const resolvePrint = (printerHost, printerPort, dataToPrint) => {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();

    const id = setTimeout(() => {
      clearTimeout(id);
      socket.destroy();
      reject("TIMED OUT");
      return;
    }, 10000);

    socket.connect({ port: printerPort, host: printerHost }, () => {
      socket.write(dataToPrint, () => {
        socket.end();
        resolve();
      });
    });

    socket.on("drain", () => {
      clearTimeout(id); 
      socket.destroy();
      resolve();
      console.log('DRAIN');
      return;
    });

    socket.on("end", () => {
      clearTimeout(id); 
      socket.destroy();
      resolve();
      console.log('END');
      return;
    });

    socket.on("error", err => {
      const error = `Error al conectar con la impresora http://${printerHost}/${printerPort}, verifica que el YALO Printer Service este conectado a la misma red que la impresora.`;
      showDialogInfoCMD(error);
      reject(error);
      return;
    });

    socket.on("close", () => {
      resolve();
      return;
    });
  });
};

// START SERVER

const startServer = () => {
  server = app.listen(hostPort, hostname, () => {
    console.log(`Servidor ejecutándose en: http://${hostname}:${hostPort}`);
    showDialogInfoCMD(
      `YALO Printer Service se esta ejecutando en la red http://${hostname}:${hostPort} , verifica que esta sea la red correcta.`
    );
  });
};

startServer();

// RESTART SERVER

const restartServer = () => {
  if (server) {
    server.close(() => {
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
      showDialogInfoCMD(
        `YALO Printer Services se detuvo ya que no tiene conexión a la red.`
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

const showDialogInfoCMD = (message) => {
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
        return;
      }
    }
  );
};
