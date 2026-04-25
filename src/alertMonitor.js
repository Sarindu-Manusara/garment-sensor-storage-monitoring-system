const {
  buildMlPredictionDocument,
  inferAnomalyWarning,
  mergeMlPredictionDocument,
  saveMlPredictionDocument
} = require("./mlService");
const { normalizeStoredReading } = require("./sensorSchema");

function readingToSample(reading) {
  return {
    timestamp: new Date(reading.timestamp).toISOString(),
    zone: reading.zone,
    temperature: reading.temperature,
    humidity: reading.humidity,
    lightLux: reading.lightLux,
    dustMgPerM3: reading.dustMgPerM3,
    mq135Raw: reading.mq135Raw,
    mq135AirQualityDeviation: reading.mq135AirQualityDeviation
  };
}

async function loadLatestZoneReadings(sensorCollection, limit = 500) {
  const documents = await sensorCollection
    .find()
    .sort({ timestamp: -1, _id: -1 })
    .limit(limit)
    .toArray();

  const latestByZone = new Map();
  for (const document of documents) {
    const normalized = normalizeStoredReading(document);
    if (!latestByZone.has(normalized.zone)) {
      latestByZone.set(normalized.zone, normalized);
    }
  }

  return Array.from(latestByZone.values());
}

async function processLatestReadingsOnce({
  config,
  sensorCollection,
  mlCollection,
  alertService = null,
  inferService = inferAnomalyWarning,
  state = { lastProcessedByZone: new Map() }
}) {
  const latestReadings = await loadLatestZoneReadings(sensorCollection);
  const processed = [];

  for (const reading of latestReadings) {
    const zone = reading.zone;
    const timestampMs = new Date(reading.timestamp).getTime();
    const lastProcessedMs = state.lastProcessedByZone.get(zone);

    if (Number.isFinite(lastProcessedMs) && timestampMs <= lastProcessedMs) {
      continue;
    }

    const sample = readingToSample(reading);
    const existingDocument = await mlCollection
      .find({
        zone,
        timestamp: new Date(sample.timestamp)
      })
      .sort({ createdAt: -1, _id: -1 })
      .limit(1)
      .next();

    const hasStoredInference = existingDocument
      && (
        existingDocument.warningLevel !== undefined
        || existingDocument.anomalyFlag !== undefined
        || existingDocument.anomalyScore !== undefined
      );

    let inferenceResult = hasStoredInference
      ? mergeMlPredictionDocument(existingDocument, {}).inference
      : null;

    if (!inferenceResult) {
      const inference = await inferService(config, sensorCollection, sample);
      inferenceResult = inference.result;
    }

    const document = buildMlPredictionDocument({
      zone,
      timestamp: sample.timestamp,
      actualReading: reading,
      inferenceResult,
      config
    });

    const saved = await saveMlPredictionDocument(mlCollection, document);
    let alertResult = null;
    if (alertService) {
      alertResult = await alertService.sendAlert({
        actualReading: reading,
        inference: inferenceResult,
        source: "live-monitor"
      });
    }

    state.lastProcessedByZone.set(zone, timestampMs);
    processed.push({
      zone,
      timestamp: sample.timestamp,
      operation: saved.operation,
      healthStatus: alertResult?.healthStatus || "safe",
      alertSent: Boolean(alertResult?.sent)
    });
  }

  return processed;
}

function startAlertMonitor({
  config,
  sensorCollection,
  mlCollection,
  alertService = null,
  inferService = inferAnomalyWarning,
  intervalMs = 15000
}) {
  const state = {
    lastProcessedByZone: new Map()
  };
  let timer = null;
  let stopped = false;
  let running = Promise.resolve();

  const runCycle = async () => {
    const results = await processLatestReadingsOnce({
      config,
      sensorCollection,
      mlCollection,
      alertService,
      inferService,
      state
    });

    for (const result of results) {
      console.log(
        `Live monitor processed ${result.zone} at ${result.timestamp} (${result.operation}); alert sent: ${result.alertSent}`
      );
    }

    return results;
  };

  const schedule = () => {
    if (stopped) {
      return;
    }

    timer = setTimeout(() => {
      running = runCycle()
        .catch((error) => {
          console.error(`Live ML monitor failed: ${error.message}`);
        })
        .finally(() => {
          schedule();
        });
    }, intervalMs);
  };

  running = runCycle().catch((error) => {
    console.error(`Live ML monitor failed during startup: ${error.message}`);
  }).finally(() => {
    schedule();
  });

  return {
    async flush() {
      await running;
      return processLatestReadingsOnce({
        config,
        sensorCollection,
        mlCollection,
        alertService,
        inferService,
        state
      });
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }
  };
}

module.exports = {
  loadLatestZoneReadings,
  processLatestReadingsOnce,
  startAlertMonitor
};
