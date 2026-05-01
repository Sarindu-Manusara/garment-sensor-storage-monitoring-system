require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");

const express = require("express");

const { createAlertService } = require("./alertService");
const { startAlertMonitor } = require("./alertMonitor");
const { registerChatRoutes } = require("./chat/chatController");
const { createChatService } = require("./chat/chatService");
const { loadConfig } = require("./config");
const {
  buildMlPredictionDocument,
  inferAnomalyWarning,
  loadClosestMlDocument,
  loadClosestSensorReading,
  loadLatestSensorReading,
  saveMlPredictionDocument,
  summarizeToday,
  toApiReading,
  toMlInferenceSnapshot,
  toTinymlSnapshot
} = require("./mlService");
const { connectToDatabase } = require("./mongoCollection");
const {
  parseEventDetailQuery,
  parseHistoryRange,
  parseDeviceReadingPayload,
  parseLiveInferencePayload,
  parseTinymlPredictionPayload
} = require("./requestValidation");
const { buildMongoDocumentFromSample } = require("./mongoDocument");

function asyncRoute(handler) {
  return async (request, response) => {
    try {
      await handler(request, response);
    } catch (error) {
      console.error(error.stack || error.message);
      response.status(400).json({
        message: error.message || "Request failed."
      });
    }
  };
}

async function loadLatestZoneSnapshots(sensorCollection, limit = 200) {
  const documents = await sensorCollection
    .find()
    .sort({ timestamp: -1, _id: -1 })
    .limit(limit)
    .toArray();

  const latestByZone = new Map();
  for (const document of documents) {
    const reading = toApiReading(document);
    if (!latestByZone.has(reading.zone)) {
      latestByZone.set(reading.zone, reading);
    }
  }

  return Array.from(latestByZone.values());
}

async function createIndexes(sensorCollection, mlCollection, chatCollection = null, alertCollection = null) {
  const indexJobs = [
    sensorCollection.createIndex({ zone: 1, timestamp: -1 }),
    mlCollection.createIndex({ zone: 1, timestamp: -1 }),
    mlCollection.createIndex({ createdAt: -1 })
  ];

  if (chatCollection) {
    indexJobs.push(chatCollection.createIndex({ conversationId: 1, createdAt: 1 }));
  }

  if (alertCollection) {
    indexJobs.push(alertCollection.createIndex({ zone: 1, healthStatus: 1, createdAt: -1 }));
  }

  await Promise.all(indexJobs);
}

function buildApp({
  config,
  sensorCollection,
  mlCollection,
  alertService = null,
  chatService = null,
  frontendDistPath,
  hasBuiltFrontend,
  inferService = inferAnomalyWarning,
  latestReadingLoader = loadLatestSensorReading,
  summaryLoader = summarizeToday
}) {
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.use((request, response, next) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }

    next();
  });

  app.get("/api/health", (_request, response) => {
    response.json({
      status: "ok",
      service: "garment-motoring-api",
      checkedAt: new Date(),
      liveMlMonitorEnabled: Boolean(config.liveMlMonitorEnabled),
      waapiEnabled: Boolean(config.waapiEnabled)
    });
  });

  app.get("/api/readings/latest", asyncRoute(async (_request, response) => {
    const zone = String(_request.query.zone || "").trim();
    const latest = await sensorCollection
      .find(zone ? { zone } : {})
      .sort({ timestamp: -1, _id: -1 })
      .limit(1)
      .next();

    if (!latest) {
      response.status(404).json({
        message: zone
          ? `No sensor readings found yet for ${zone}.`
          : "No sensor readings found yet."
      });
      return;
    }

    response.json({
      reading: toApiReading(latest),
      fetchedAt: new Date()
    });
  }));

  app.get("/api/readings/recent", asyncRoute(async (request, response) => {
    const rawLimit = Number.parseInt(request.query.limit, 10);
    const limit = Number.isInteger(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, 96)
      : 12;
    const zone = String(request.query.zone || "").trim();

    const readings = await sensorCollection
      .find(zone ? { zone } : {})
      .sort({ timestamp: -1, _id: -1 })
      .limit(limit)
      .toArray();

    response.json({
      readings: readings.map(toApiReading),
      fetchedAt: new Date()
    });
  }));

  app.get("/api/dashboard", asyncRoute(async (request, response) => {
    const requestedZone = String(request.query.zone || "").trim();
    const rawLimit = Number.parseInt(request.query.limit, 10);
    const limit = Number.isInteger(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, 48)
      : 12;

    const zones = await loadLatestZoneSnapshots(sensorCollection, 500);
    const selectedZone = requestedZone || zones[0]?.zone || config.zone;

    const [latest, recent] = await Promise.all([
      sensorCollection
        .find({ zone: selectedZone })
        .sort({ timestamp: -1, _id: -1 })
        .limit(1)
        .next(),
      sensorCollection
        .find({ zone: selectedZone })
        .sort({ timestamp: -1, _id: -1 })
        .limit(limit)
        .toArray()
    ]);

    response.json({
      selectedZone,
      latest: latest ? toApiReading(latest) : null,
      recent: recent.map(toApiReading),
      zones,
      fetchedAt: new Date()
    });
  }));

  app.get("/api/readings/zones", asyncRoute(async (request, response) => {
    const rawLimit = Number.parseInt(request.query.limit, 10);
    const limit = Number.isInteger(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, 500)
      : 200;
    const zones = await loadLatestZoneSnapshots(sensorCollection, limit);

    response.json({
      zones,
      fetchedAt: new Date()
    });
  }));

  app.post("/api/readings/device", asyncRoute(async (request, response) => {
    const payload = parseDeviceReadingPayload(request.body);
    const sensorDocument = buildMongoDocumentFromSample(payload, config);
    const sensorInsert = await sensorCollection.insertOne(sensorDocument);
    const actualReading = {
      _id: sensorInsert.insertedId,
      ...sensorDocument
    };

    const { result } = await inferService(config, sensorCollection, {
      timestamp: payload.timestamp,
      zone: payload.zone,
      temperature: payload.temperature,
      humidity: payload.humidity,
      lightLux: payload.lightLux,
      dustMgPerM3: payload.dustMgPerM3,
      mq135Raw: payload.mq135Raw,
      mq135AirQualityDeviation: payload.mq135AirQualityDeviation
    });

    const mlDocument = buildMlPredictionDocument({
      zone: payload.zone,
      timestamp: payload.timestamp,
      actualReading,
      predictedHumidity: payload.predictedHumidity,
      predictionHorizon: payload.predictionHorizon,
      inferenceLatencyMs: payload.inferenceLatencyMs,
      tinymlModelVersion: payload.modelVersion,
      inferenceResult: result,
      config
    });

    const saved = await saveMlPredictionDocument(mlCollection, mlDocument);
    if (alertService) {
      await alertService.sendAlert({
        actualReading,
        inference: result,
        source: payload.predictedHumidity !== null ? "device-direct-with-tinyml" : "device-direct"
      });
    }
    console.log(
      `Stored direct device reading for ${payload.zone} at ${payload.timestamp}${payload.predictedHumidity !== null ? " with TinyML prediction" : ""}`
    );

    response.status(201).json({
      stored: true,
      reading: toApiReading(actualReading),
      tinyml: toTinymlSnapshot(saved.document),
      inference: toMlInferenceSnapshot(saved.document, config.backendModelVersion),
      fetchedAt: new Date()
    });
  }));

  app.post("/api/ml/anomaly-warning/infer", asyncRoute(async (request, response) => {
    const sample = parseLiveInferencePayload(request.body);
    const { result } = await inferService(config, sensorCollection, sample);

    const document = buildMlPredictionDocument({
      zone: sample.zone,
      timestamp: sample.timestamp,
      actualReading: sample,
      inferenceResult: result,
      config
    });

    const saved = await saveMlPredictionDocument(mlCollection, document);
    if (alertService) {
      await alertService.sendAlert({
        actualReading: sample,
        inference: result,
        source: "api-infer"
      });
    }
    console.log(`Stored backend ML inference for ${sample.zone} at ${sample.timestamp} (${saved.operation})`);

    response.json({
      anomalyFlag: result.anomalyFlag,
      anomalyScore: result.anomalyScore,
      anomalyReasons: result.anomalyReasons,
      warningLevel: result.warningLevel,
      warningConfidence: result.warningConfidence,
      modelVersion: config.backendModelVersion,
      modelVersions: result.modelVersion
    });
  }));

  app.post("/api/ml/tinyml-prediction", asyncRoute(async (request, response) => {
    const payload = parseTinymlPredictionPayload(request.body);
    const actualReading = await latestReadingLoader(sensorCollection, payload.zone, payload.timestamp);

    let inferenceResult = null;
    if (actualReading) {
      const sample = {
        timestamp: new Date(actualReading.timestamp).toISOString(),
        zone: actualReading.zone,
        temperature: actualReading.temperature,
        humidity: actualReading.humidity,
        lightLux: actualReading.lightLux,
        dustMgPerM3: actualReading.dustMgPerM3,
        mq135Raw: actualReading.mq135Raw,
        mq135AirQualityDeviation: actualReading.mq135AirQualityDeviation
      };
      const inference = await inferService(config, sensorCollection, sample);
      inferenceResult = inference.result;
    }

    const document = buildMlPredictionDocument({
      zone: payload.zone,
      timestamp: payload.timestamp,
      actualReading,
      predictedHumidity: payload.predictedHumidity,
      predictionHorizon: payload.predictionHorizon,
      inferenceLatencyMs: payload.inferenceLatencyMs,
      tinymlModelVersion: payload.modelVersion,
      inferenceResult,
      config
    });

    const saved = await saveMlPredictionDocument(mlCollection, document);
    if (alertService && inferenceResult) {
      await alertService.sendAlert({
        actualReading,
        inference: inferenceResult,
        source: "tinyml-upload"
      });
    }
    console.log(`Stored TinyML prediction for ${payload.zone} at ${payload.timestamp} (${saved.operation})`);

    response.status(201).json({
      stored: true,
      prediction: toTinymlSnapshot(document),
      anomaly: inferenceResult ? {
        anomalyFlag: inferenceResult.anomalyFlag,
        anomalyScore: inferenceResult.anomalyScore,
        anomalyReasons: inferenceResult.anomalyReasons
      } : null,
      warning: inferenceResult ? {
        warningLevel: inferenceResult.warningLevel,
        warningConfidence: inferenceResult.warningConfidence
      } : null
    });
  }));

  app.get("/api/ml/latest", asyncRoute(async (request, response) => {
    const zone = String(request.query.zone || "zone1").trim() || "zone1";
    const [latestReading, latestPrediction, latestInferenceDocument] = await Promise.all([
      latestReadingLoader(sensorCollection, zone),
      mlCollection.find({
        zone,
        predictedHumidity: { $ne: null }
      }).sort({ timestamp: -1, _id: -1 }).limit(1).next(),
      mlCollection.find({ zone }).sort({ timestamp: -1, _id: -1 }).limit(1).next()
    ]);

    let transientInference = null;
    if (!latestInferenceDocument && latestReading) {
      transientInference = (await inferService(config, sensorCollection, {
        timestamp: new Date(latestReading.timestamp).toISOString(),
        zone: latestReading.zone,
        temperature: latestReading.temperature,
        humidity: latestReading.humidity,
        lightLux: latestReading.lightLux,
        dustMgPerM3: latestReading.dustMgPerM3,
        mq135Raw: latestReading.mq135Raw,
        mq135AirQualityDeviation: latestReading.mq135AirQualityDeviation
      })).result;
    }

    const summary = await summaryLoader(mlCollection, zone);

    response.json({
      actual: latestReading ? toApiReading(latestReading) : null,
      tinyml: latestPrediction ? toTinymlSnapshot(latestPrediction) : null,
      inference: latestInferenceDocument
        ? toMlInferenceSnapshot(latestInferenceDocument, config.backendModelVersion)
        : toMlInferenceSnapshot(transientInference, config.backendModelVersion),
      summary,
      fetchedAt: new Date()
    });
  }));

  app.get("/api/ml/history", asyncRoute(async (request, response) => {
    const { from, to, zone } = parseHistoryRange(request.query);
    const [sensorReadings, predictionDocs] = await Promise.all([
      sensorCollection.find({
        zone,
        timestamp: { $gte: from, $lte: to }
      }).sort({ timestamp: 1, _id: 1 }).toArray(),
      mlCollection.find({
        zone,
        timestamp: { $gte: from, $lte: to }
      }).sort({ timestamp: 1, _id: 1 }).toArray()
    ]);

    response.json({
      zone,
      from,
      to,
      series: {
        actualHumidity: sensorReadings.map((document) => ({
          timestamp: document.timestamp,
          value: document.humidity ?? null
        })),
        predictedHumidity: predictionDocs
          .filter((document) => Number.isFinite(document.predictedHumidity))
          .map((document) => ({
            timestamp: document.timestamp,
            value: document.predictedHumidity,
            actualHumidity: document.actualHumidity ?? null
          })),
        anomalyScore: predictionDocs
          .filter((document) => Number.isFinite(document.anomalyScore))
          .map((document) => ({
            timestamp: document.timestamp,
            value: document.anomalyScore,
            flag: Boolean(document.anomalyFlag),
            reasons: document.anomalyReasons || []
          })),
        warningLevel: predictionDocs
          .filter((document) => document.warningLevel)
          .map((document) => ({
            timestamp: document.timestamp,
            value: document.warningLevel,
            confidence: document.warningConfidence ?? 0
          }))
      },
      summary: await summaryLoader(mlCollection, zone),
      fetchedAt: new Date()
    });
  }));

  app.get("/api/ml/event-detail", asyncRoute(async (request, response) => {
    const { zone, timestamp } = parseEventDetailQuery(request.query);
    const [closestReading, closestPredictionDocument] = await Promise.all([
      loadClosestSensorReading(sensorCollection, zone, timestamp),
      loadClosestMlDocument(mlCollection, zone, timestamp)
    ]);

    let inference = null;
    let tinyml = null;
    let matchedTimestamp = closestReading?.timestamp || closestPredictionDocument?.timestamp || null;
    let source = "none";

    if (closestPredictionDocument) {
      inference = toMlInferenceSnapshot(closestPredictionDocument, config.backendModelVersion);
      tinyml = toTinymlSnapshot(closestPredictionDocument);
      matchedTimestamp = closestPredictionDocument.timestamp;
      source = "stored-ml";
    } else if (closestReading) {
      const transient = await inferService(config, sensorCollection, {
        timestamp: new Date(closestReading.timestamp).toISOString(),
        zone: closestReading.zone,
        temperature: closestReading.temperature,
        humidity: closestReading.humidity,
        lightLux: closestReading.lightLux,
        dustMgPerM3: closestReading.dustMgPerM3,
        mq135Raw: closestReading.mq135Raw,
        mq135AirQualityDeviation: closestReading.mq135AirQualityDeviation
      });
      inference = toMlInferenceSnapshot(transient.result, config.backendModelVersion);
      matchedTimestamp = closestReading.timestamp;
      source = "live-inferred";
    }

    if (!closestReading && !closestPredictionDocument) {
      response.status(404).json({
        message: `No event detail is available for ${zone} near ${timestamp}.`
      });
      return;
    }

    const actualReading = closestReading ? toApiReading(closestReading) : null;
    const actualHumidity = tinyml?.actualHumidity ?? actualReading?.humidity ?? null;
    const predictionDelta = Number.isFinite(tinyml?.predictedHumidity) && Number.isFinite(actualHumidity)
      ? Number((tinyml.predictedHumidity - actualHumidity).toFixed(3))
      : null;

    response.json({
      zone,
      requestedTimestamp: timestamp,
      matchedTimestamp,
      source,
      actualReading,
      tinyml,
      inference,
      predictionDelta,
      fetchedAt: new Date()
    });
  }));

  if (chatService) {
    registerChatRoutes(app, chatService, asyncRoute);
  }

  if (hasBuiltFrontend) {
    app.use(express.static(frontendDistPath));

    app.get(/^\/(?!api\/).*/, (request, response, next) => {
      if (request.path.startsWith("/api/")) {
        next();
        return;
      }

      response.sendFile(path.join(frontendDistPath, "index.html"));
    });
  }

  return app;
}

async function main() {
  const config = loadConfig(process.env, { requireSerial: false });
  const apiPort = Number.parseInt(process.env.PORT || process.env.API_PORT || "3001", 10);
  const { mongoClient, sensorCollection, mlCollection, chatCollection, alertCollection } = await connectToDatabase(config);
  await createIndexes(sensorCollection, mlCollection, chatCollection, alertCollection);

  const frontendDistPath = path.resolve(__dirname, "..", "frontend", "dist");
  const hasBuiltFrontend = fs.existsSync(frontendDistPath);
  const alertService = createAlertService({
    config,
    alertCollection
  });
  const chatService = createChatService({
    config,
    sensorCollection,
    mlCollection,
    chatCollection
  });

  const app = buildApp({
    config,
    sensorCollection,
    mlCollection,
    alertService,
    chatService,
    frontendDistPath,
    hasBuiltFrontend
  });

  const alertMonitor = config.liveMlMonitorEnabled
    ? startAlertMonitor({
      config,
      sensorCollection,
      mlCollection,
      alertService,
      intervalMs: config.liveMlMonitorIntervalMs
    })
    : null;

  const server = app.listen(apiPort, () => {
    console.log(`API server listening on http://localhost:${apiPort}`);
    console.log(`Using MongoDB collections ${config.mongodbDatabase}.${config.mongodbCollection} and ${config.mongodbMlCollection}`);
    if (hasBuiltFrontend) {
      console.log(`Serving frontend from ${frontendDistPath}`);
    }
    if (config.liveMlMonitorEnabled) {
      console.log(`Live ML monitor enabled with ${config.liveMlMonitorIntervalMs}ms polling`);
    }
  });

  async function shutdown(signal) {
    console.log(`Received ${signal}, closing API server...`);
    if (alertMonitor) {
      alertMonitor.stop();
    }

    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    await mongoClient.close();
    process.exit(0);
  }

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = {
  buildApp,
  createIndexes,
  main
};
