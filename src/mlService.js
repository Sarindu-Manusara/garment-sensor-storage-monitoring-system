const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { normalizeStoredReading, toApiReading } = require("./sensorSchema");

function mapReadingToMlSample(reading) {
  const normalized = normalizeStoredReading(reading);
  return {
    timestamp: new Date(normalized.timestamp).toISOString(),
    zone: normalized.zone,
    temperature: normalized.temperature,
    humidity: normalized.humidity,
    lightLux: normalized.lightLux,
    dustMgPerM3: normalized.dustMgPerM3,
    mq135Raw: normalized.mq135Raw,
    mq135AirQualityDeviation: normalized.mq135AirQualityDeviation
  };
}

function buildPythonBinCandidates(config) {
  return Array.from(new Set([
    config.pythonBin,
    process.platform === "win32" ? "py" : "python3",
    "python",
    "python3"
  ].filter(Boolean)));
}

function runPythonProcess(command, scriptPath, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [scriptPath], {
      cwd: path.resolve(__dirname, ".."),
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      const enrichedError = new Error(error.message);
      enrichedError.code = error.code;
      enrichedError.command = command;
      reject(enrichedError);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        const failure = new Error(stderr || `Python ML process exited with code ${code}.`);
        failure.code = code;
        failure.command = command;
        reject(failure);
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Failed to parse Python ML response: ${error.message}`));
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

async function runPythonMlInference(config, payload) {
  const candidateScriptPaths = [
    path.resolve(__dirname, "..", "backend", "ml", "inference", "live_infer.py")
  ];
  const scriptPath = candidateScriptPaths.find((candidate) => fs.existsSync(candidate));

  if (!scriptPath) {
    const checked = candidateScriptPaths.join(", ");
    return Promise.reject(new Error(`Python ML inference entrypoint was not found. Checked: ${checked}`));
  }

  const candidateBins = buildPythonBinCandidates(config);
  let lastError = null;

  for (const command of candidateBins) {
    try {
      return await runPythonProcess(command, scriptPath, payload);
    } catch (error) {
      lastError = error;
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  const checkedBins = candidateBins.join(", ");
  throw new Error(
    `Python runtime was not found. Checked commands: ${checkedBins}. Set PYTHON_BIN to a valid Python executable.`
  );
}

async function loadSensorHistory(sensorCollection, zone, timestamp, limit = 24) {
  const cursor = sensorCollection
    .find({
      zone,
      timestamp: { $lte: new Date(timestamp) }
    })
    .sort({ timestamp: -1, _id: -1 })
    .limit(limit);

  const documents = await cursor.toArray();
  return documents.reverse().map(mapReadingToMlSample);
}

async function loadLatestSensorReading(sensorCollection, zone, timestamp) {
  const query = {
    zone
  };

  if (timestamp) {
    query.timestamp = { $lte: new Date(timestamp) };
  }

  const document = await sensorCollection
    .find(query)
    .sort({ timestamp: -1, _id: -1 })
    .limit(1)
    .next();

  return document ? normalizeStoredReading(document) : null;
}

async function loadClosestDocument(collection, queryBase, timestamp) {
  const target = new Date(timestamp);
  if (Number.isNaN(target.getTime())) {
    throw new Error("timestamp must be a valid ISO timestamp.");
  }

  const [previous, next] = await Promise.all([
    collection
      .find({
        ...queryBase,
        timestamp: { $lte: target }
      })
      .sort({ timestamp: -1, _id: -1 })
      .limit(1)
      .next(),
    collection
      .find({
        ...queryBase,
        timestamp: { $gte: target }
      })
      .sort({ timestamp: 1, _id: 1 })
      .limit(1)
      .next()
  ]);

  if (!previous) {
    return next || null;
  }
  if (!next) {
    return previous;
  }

  const previousDelta = Math.abs(new Date(previous.timestamp).getTime() - target.getTime());
  const nextDelta = Math.abs(new Date(next.timestamp).getTime() - target.getTime());
  return previousDelta <= nextDelta ? previous : next;
}

async function loadClosestSensorReading(sensorCollection, zone, timestamp) {
  const document = await loadClosestDocument(sensorCollection, { zone }, timestamp);
  return document ? normalizeStoredReading(document) : null;
}

async function loadClosestMlDocument(mlCollection, zone, timestamp, includePredictionOnly = false) {
  const query = { zone };
  if (includePredictionOnly) {
    query.predictedHumidity = { $ne: null };
  }

  return loadClosestDocument(mlCollection, query, timestamp);
}

async function inferAnomalyWarning(config, sensorCollection, sample) {
  const history = await loadSensorHistory(sensorCollection, sample.zone, sample.timestamp, 24);
  const result = await runPythonMlInference(config, {
    sample,
    history,
    mq135Baseline: config.mq135BaselineRaw
  });

  return {
    history,
    result
  };
}

function buildMlPredictionDocument({
  zone,
  timestamp,
  actualReading,
  predictedHumidity,
  predictionHorizon,
  inferenceLatencyMs,
  tinymlModelVersion,
  inferenceResult,
  config
}) {
  return {
    zone,
    timestamp: new Date(timestamp),
    actualHumidity: actualReading?.humidity ?? null,
    predictedHumidity: predictedHumidity ?? null,
    predictionHorizon: predictionHorizon ?? null,
    tinymlModelVersion: tinymlModelVersion ?? null,
    inferenceLatencyMs: inferenceLatencyMs ?? null,
    anomalyFlag: inferenceResult?.anomalyFlag ?? null,
    anomalyScore: inferenceResult?.anomalyScore ?? null,
    anomalyReasons: inferenceResult?.anomalyReasons ?? [],
    warningLevel: inferenceResult?.warningLevel ?? null,
    warningConfidence: inferenceResult?.warningConfidence ?? null,
    backendModelVersion: inferenceResult?.modelVersion?.warning || config.backendModelVersion,
    createdAt: new Date()
  };
}

function mergeMlPredictionDocument(existingDocument = null, nextDocument = {}) {
  const source = existingDocument || {};
  const merged = {
    ...source,
    ...nextDocument
  };

  for (const [key, value] of Object.entries(nextDocument)) {
    if (value === undefined) {
      delete merged[key];
      continue;
    }

    if (value === null) {
      if (source[key] === undefined) {
        merged[key] = null;
      } else {
        merged[key] = source[key];
      }
      continue;
    }

    if (Array.isArray(value) && value.length === 0 && Array.isArray(source[key]) && source[key].length > 0) {
      merged[key] = source[key];
      continue;
    }

    merged[key] = value;
  }

  return {
    document: merged,
    inference: {
      anomalyFlag: merged.anomalyFlag ?? false,
      anomalyScore: merged.anomalyScore ?? 0,
      anomalyReasons: merged.anomalyReasons ?? [],
      warningLevel: merged.warningLevel ?? "low",
      warningConfidence: merged.warningConfidence ?? 0,
      modelVersion: merged.backendModelVersion
        ? { warning: merged.backendModelVersion }
        : merged.modelVersion
    }
  };
}

async function saveMlPredictionDocument(mlCollection, document) {
  const timestamp = document.timestamp instanceof Date ? document.timestamp : new Date(document.timestamp);
  const existingDocument = await mlCollection
    .find({
      zone: document.zone,
      timestamp
    })
    .sort({ createdAt: -1, _id: -1 })
    .limit(1)
    .next();

  if (!existingDocument) {
    const inserted = {
      ...document,
      timestamp
    };
    const result = await mlCollection.insertOne(inserted);
    return {
      operation: "inserted",
      document: {
        _id: result.insertedId,
        ...inserted
      }
    };
  }

  const merged = mergeMlPredictionDocument(existingDocument, {
    ...document,
    timestamp,
    createdAt: existingDocument.createdAt || document.createdAt || new Date()
  }).document;

  if (typeof mlCollection.updateOne === "function") {
    await mlCollection.updateOne(
      { _id: existingDocument._id },
      {
        $set: {
          ...merged,
          updatedAt: new Date()
        }
      }
    );
  } else if (Array.isArray(mlCollection.documents)) {
    const index = mlCollection.documents.findIndex((candidate) => String(candidate._id) === String(existingDocument._id));
    if (index >= 0) {
      mlCollection.documents[index] = {
        ...mlCollection.documents[index],
        ...merged,
        updatedAt: new Date()
      };
    }
  }

  return {
    operation: "updated",
    document: {
      ...existingDocument,
      ...merged,
      updatedAt: new Date()
    }
  };
}

async function summarizeToday(mlCollection, zone) {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);

  const todayDocs = await mlCollection.find({
    zone,
    timestamp: { $gte: start }
  }).toArray();

  const anomalyCountToday = todayDocs.filter((document) => document.anomalyFlag).length;
  const predictionErrors = todayDocs
    .filter((document) => Number.isFinite(document.actualHumidity) && Number.isFinite(document.predictedHumidity))
    .map((document) => Math.abs(document.actualHumidity - document.predictedHumidity));
  const avgHumidityPredictionError = predictionErrors.length > 0
    ? Number((predictionErrors.reduce((sum, value) => sum + value, 0) / predictionErrors.length).toFixed(3))
    : null;
  const latestWarning = todayDocs
    .filter((document) => document.warningLevel)
    .sort((left, right) => new Date(right.timestamp) - new Date(left.timestamp))[0];

  return {
    anomalyCountToday,
    avgHumidityPredictionError,
    currentWarningState: latestWarning?.warningLevel || "unknown"
  };
}

function toTinymlSnapshot(document) {
  if (!document || !Number.isFinite(document.predictedHumidity)) {
    return null;
  }

  return {
    timestamp: document.timestamp,
    zone: document.zone,
    actualHumidity: document.actualHumidity,
    predictedHumidity: document.predictedHumidity,
    predictionHorizon: document.predictionHorizon,
    inferenceLatencyMs: document.inferenceLatencyMs,
    modelVersion: document.tinymlModelVersion,
    source: "ESP32 TinyML"
  };
}

function toMlInferenceSnapshot(source, fallbackVersion) {
  if (!source) {
    return null;
  }

  return {
    anomalyFlag: source.anomalyFlag ?? false,
    anomalyScore: source.anomalyScore ?? 0,
    anomalyReasons: source.anomalyReasons ?? [],
    warningLevel: source.warningLevel ?? "low",
    warningConfidence: source.warningConfidence ?? 0,
    modelVersion: source.modelVersion?.warning || source.backendModelVersion || fallbackVersion
  };
}

module.exports = {
  buildMlPredictionDocument,
  inferAnomalyWarning,
  loadClosestMlDocument,
  loadClosestSensorReading,
  loadLatestSensorReading,
  loadSensorHistory,
  mapReadingToMlSample,
  mergeMlPredictionDocument,
  saveMlPredictionDocument,
  summarizeToday,
  toApiReading,
  toMlInferenceSnapshot,
  toTinymlSnapshot
};
