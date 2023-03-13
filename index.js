const net = require("net");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const ip = require("ip");
const network = require("network");
const exec = require("child_process");
const expressSanitizer = require("express-sanitizer");

const app = express();
const hostPort = 3000;
let hostname = ip.address();

const https = require("https");
const fs = require("fs");
const { send } = require("process");

const options = {
  key: fs.readFileSync("./config/localhost.decrypted.key"),
  cert: fs.readFileSync("./config/localhost.crt"),
};


// Mount express-sanitizer middleware here
app.use(expressSanitizer());

// Server static html file to check if the server is working 
app.use("/", express.static("public"));

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
      const error = `Error al conectar con la impresora http://${printerHost}/${printerPort}, verifica que el YALO Printer Service este conectado a la misma red que la impresora.`;
      showDialogInfoCMD(error);
      reject(error);
    });

    client.connect({ port: printerPort, host: printerHost }, () => {
      console.log(
        `Conexión TCP establecida en http://${printerHost}/${printerPort}.`
      );
      client.write(dataToPrint, () => {
        client.end();
        resolve();
      });
    });
  });
};

// START SERVER

const startServer = () => {


  app.get('/',(req, res, next) =>{
    res.status(200),send('corriendo');
  })
  

  const server = https.createServer(options, app);
  server.listen(hostPort, () =>{
    console.log('corriendo')
  } )
  // app.listen(hostPort, hostname, () => {
  //   console.log(`Servidor ejecutándose en: https://${hostname}:${hostPort}`);
  //   showDialogInfoCMD(
  //     `YALO Printer Service se esta ejecutando en la red https://${hostname}/${hostPort} , verifica que esta sea la red correcta.`
  //   );
  // });

  // server  =   https.createServer(options, app).listen(hostPort, () => {
  //   console.log(`HTTPS server started on port 8080`);
  // });

 // console.log(server)

  
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
        `YALO Printer Servicese detuvo ya que no tiene conexión a la red.`
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
