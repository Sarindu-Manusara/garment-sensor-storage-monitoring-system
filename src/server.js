require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");

const express = require("express");

const { registerChatRoutes } = require("./chat/chatController");
const { createChatService } = require("./chat/chatService");
const { loadConfig } = require("./config");
const {
  buildMlPredictionDocument,
  inferAnomalyWarning,
  loadClosestMlDocument,
  loadClosestSensorReading,
  loadLatestSensorReading,
  summarizeToday,
  toApiReading,
  toMlInferenceSnapshot,
  toTinymlSnapshot
} = require("./mlService");
const { connectToDatabase } = require("./mongoCollection");
const {
  parseEventDetailQuery,
  parseHistoryRange,
  parseLiveInferencePayload,
  parseTinymlPredictionPayload
} = require("./requestValidation");

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

async function createIndexes(sensorCollection, mlCollection, chatCollection = null) {
  const indexJobs = [
    sensorCollection.createIndex({ zone: 1, timestamp: -1 }),
    mlCollection.createIndex({ zone: 1, timestamp: -1 }),
    mlCollection.createIndex({ createdAt: -1 })
  ];

  if (chatCollection) {
    indexJobs.push(chatCollection.createIndex({ conversationId: 1, createdAt: 1 }));
  }

  await Promise.all(indexJobs);
}

function buildApp({
  config,
  sensorCollection,
  mlCollection,
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
      checkedAt: new Date()
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

  app.get("/api/readings/zones", asyncRoute(async (request, response) => {
    const rawLimit = Number.parseInt(request.query.limit, 10);
    const limit = Number.isInteger(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, 500)
      : 200;

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

    response.json({
      zones: Array.from(latestByZone.values()),
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

    await mlCollection.insertOne(document);
    console.log(`Stored backend ML inference for ${sample.zone} at ${sample.timestamp}`);

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

    await mlCollection.insertOne(document);
    console.log(`Stored TinyML prediction for ${payload.zone} at ${payload.timestamp}`);

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
  const apiPort = Number.parseInt(process.env.API_PORT || "3001", 10);
  const { mongoClient, sensorCollection, mlCollection, chatCollection } = await connectToDatabase(config);
  await createIndexes(sensorCollection, mlCollection, chatCollection);

  const frontendDistPath = path.resolve(__dirname, "..", "frontend", "dist");
  const hasBuiltFrontend = fs.existsSync(frontendDistPath);
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
    chatService,
    frontendDistPath,
    hasBuiltFrontend
  });

  const server = app.listen(apiPort, () => {
    console.log(`API server listening on http://localhost:${apiPort}`);
    console.log(`Using MongoDB collections ${config.mongodbDatabase}.${config.mongodbCollection} and ${config.mongodbMlCollection}`);
    if (hasBuiltFrontend) {
      console.log(`Serving frontend from ${frontendDistPath}`);
    }
  });

  async function shutdown(signal) {
    console.log(`Received ${signal}, closing API server...`);

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
