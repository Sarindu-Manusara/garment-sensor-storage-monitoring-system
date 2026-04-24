require("dotenv").config();

const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

const { loadConfig } = require("./config");
const { connectToCollection } = require("./mongoCollection");
const { buildMongoDocument } = require("./mongoDocument");
const { SensorStreamParser } = require("./sensorParser");

async function main() {
  const config = loadConfig(process.env);

  const { mongoClient, collection } = await connectToCollection(config);

  console.log(`Connected to MongoDB collection ${config.mongodbDatabase}.${config.mongodbCollection}`);

  const serialPort = new SerialPort({
    path: config.serialPortPath,
    baudRate: config.serialBaudRate,
    autoOpen: true
  });

  const lineParser = serialPort.pipe(
    new ReadlineParser({
      delimiter: config.serialDelimiter
    })
  );

  const sensorParser = new SensorStreamParser({
    defaultDeviceId: config.deviceId
  });

  let writeQueue = Promise.resolve();

  async function persistDocument(document) {
    const mongoDocument = buildMongoDocument(document, config);
    const result = await collection.insertOne(mongoDocument);
    console.log(
      `Inserted ${mongoDocument.zone} reading with risk ${mongoDocument.risk_level} and _id ${result.insertedId}`
    );
  }

  async function handleLine(line) {
    const documents = sensorParser.processLine(line);

    for (const document of documents) {
      await persistDocument(document);
    }
  }

  serialPort.on("open", () => {
    console.log(`Listening on ${config.serialPortPath} @ ${config.serialBaudRate} baud`);
  });

  serialPort.on("error", (error) => {
    console.error(`Serial port error: ${error.message}`);
  });

  lineParser.on("data", (line) => {
    writeQueue = writeQueue
      .then(() => handleLine(line))
      .catch((error) => {
        console.error(`Failed to process serial data: ${error.message}`);
      });
  });

  async function shutdown(signal) {
    console.log(`Received ${signal}, closing connections...`);

    try {
      await writeQueue;

      const pendingDocuments = sensorParser.flush();
      for (const document of pendingDocuments) {
        await persistDocument(document);
      }

      if (serialPort.isOpen) {
        await new Promise((resolve, reject) => {
          serialPort.close((error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        });
      }

      await mongoClient.close();
      process.exit(0);
    } catch (error) {
      console.error(`Shutdown failed: ${error.message}`);
      process.exit(1);
    }
  }

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
