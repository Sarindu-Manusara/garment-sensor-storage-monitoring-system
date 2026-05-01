require("dotenv").config();

const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

const { createAlertService } = require("./alertService");
const { loadConfig } = require("./config");
const { connectToDatabase } = require("./mongoCollection");
const { buildMongoDocument } = require("./mongoDocument");
const {
  buildMlPredictionDocument,
  inferAnomalyWarning,
  saveMlPredictionDocument
} = require("./mlService");
const { SensorStreamParser } = require("./sensorParser");

function extractTinyMlPayload(parsedDocument) {
  const tinyml = parsedDocument?.rawPayload?.tinyml;
  if (!tinyml || typeof tinyml !== "object") {
    return null;
  }

  const predictedHumidity = Number.parseFloat(tinyml.predictedHumidity);
  if (!tinyml.predictionValid || !Number.isFinite(predictedHumidity)) {
    return null;
  }

  return {
    predictedHumidity,
    inferenceLatencyMs: Number.isFinite(Number(tinyml.inferenceLatencyMs))
      ? Number(tinyml.inferenceLatencyMs)
      : null,
    modelVersion: String(tinyml.modelVersion || "").trim() || null
  };
}

async function main() {
  const config = loadConfig(process.env);

  const {
    mongoClient,
    sensorCollection,
    mlCollection,
    alertCollection
  } = await connectToDatabase(config);
  const alertService = createAlertService({
    config,
    alertCollection
  });

  console.log(`Connected to MongoDB collection ${config.mongodbDatabase}.${config.mongodbCollection}`);

  const serialPort = new SerialPort({
    path: config.serialPortPath,
    baudRate: config.serialBaudRate,
    autoOpen: false
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
  let reconnectTimer = null;
  let isShuttingDown = false;

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleSerialReconnect(reason) {
    if (isShuttingDown || reconnectTimer || serialPort.isOpen) {
      return;
    }

    const detail = reason ? ` (${reason})` : "";
    console.log(
      `Retrying serial connection to ${config.serialPortPath} in 3s${detail}`
    );

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openSerialPort();
    }, 3000);
  }

  function openSerialPort() {
    if (isShuttingDown || serialPort.isOpen) {
      return;
    }

    serialPort.open((error) => {
      if (!error) {
        return;
      }

      console.error(`Serial port open failed: ${error.message}`);
      if (/access denied/i.test(error.message)) {
        console.error(
          `Close Arduino Serial Monitor/Plotter or any app using ${config.serialPortPath}, then keep this ingester running. It will reconnect automatically.`
        );
      }
      scheduleSerialReconnect(error.message);
    });
  }

  async function persistDocument(document) {
    const mongoDocument = buildMongoDocument(document, config);
    const result = await sensorCollection.insertOne(mongoDocument);
    console.log(
      `Inserted ${mongoDocument.zone} reading with risk ${mongoDocument.risk_level} and _id ${result.insertedId}`
    );

    const tinymlPayload = extractTinyMlPayload(document);
    if (!tinymlPayload) {
      return;
    }

    const actualReading = {
      ...mongoDocument,
      _id: result.insertedId
    };
    const { result: inferenceResult } = await inferAnomalyWarning(
      config,
      sensorCollection,
      {
        timestamp: new Date(mongoDocument.timestamp).toISOString(),
        zone: mongoDocument.zone,
        temperature: mongoDocument.temperature,
        humidity: mongoDocument.humidity,
        lightLux: mongoDocument.lightLux,
        dustMgPerM3: mongoDocument.dustMgPerM3,
        mq135Raw: mongoDocument.mq135Raw,
        mq135AirQualityDeviation: mongoDocument.mq135AirQualityDeviation
      }
    );

    const mlDocument = buildMlPredictionDocument({
      zone: mongoDocument.zone,
      timestamp: mongoDocument.timestamp,
      actualReading,
      predictedHumidity: tinymlPayload.predictedHumidity,
      predictionHorizon: 1,
      inferenceLatencyMs: tinymlPayload.inferenceLatencyMs,
      tinymlModelVersion: tinymlPayload.modelVersion || config.tinymlModelVersion,
      inferenceResult,
      config
    });
    const saved = await saveMlPredictionDocument(mlCollection, mlDocument);
    console.log(
      `Stored serial TinyML prediction for ${mongoDocument.zone} at ${mongoDocument.timestamp.toISOString()} (${saved.operation})`
    );

    if (alertService) {
      await alertService.sendAlert({
        actualReading,
        inference: inferenceResult,
        source: "serial-tinyml"
      });
    }
  }

  async function handleLine(line) {
    const documents = sensorParser.processLine(line);

    for (const document of documents) {
      await persistDocument(document);
    }
  }

  serialPort.on("open", () => {
    clearReconnectTimer();
    console.log(`Listening on ${config.serialPortPath} @ ${config.serialBaudRate} baud`);
  });

  serialPort.on("error", (error) => {
    console.error(`Serial port error: ${error.message}`);
    scheduleSerialReconnect(error.message);
  });

  serialPort.on("close", () => {
    if (!isShuttingDown) {
      console.warn(`Serial port ${config.serialPortPath} closed`);
      scheduleSerialReconnect("port closed");
    }
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
    isShuttingDown = true;
    clearReconnectTimer();

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

  openSerialPort();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
