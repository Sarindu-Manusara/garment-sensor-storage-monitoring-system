const fs = require("node:fs");
const path = require("node:path");

const {
  inferAnomalyWarning,
  loadLatestSensorReading,
  toMlInferenceSnapshot,
  toTinymlSnapshot
} = require("../mlService");
const { normalizeStoredReading, toApiReading } = require("../sensorSchema");

const MAX_HISTORY_DAYS = 31;
const MAX_POINTS = 120;

const METRIC_DEFINITIONS = {
  temperature: {
    key: "temperature",
    label: "temperature",
    unit: "C",
    collection: "sensor"
  },
  humidity: {
    key: "humidity",
    label: "humidity",
    unit: "%",
    collection: "sensor"
  },
  lightLux: {
    key: "lightLux",
    label: "light",
    unit: "lx",
    collection: "sensor"
  },
  dustMgPerM3: {
    key: "dustMgPerM3",
    label: "dust",
    unit: "mg/m^3",
    collection: "sensor"
  },
  mq135AirQualityDeviation: {
    key: "mq135AirQualityDeviation",
    label: "gas deviation",
    unit: "%",
    collection: "sensor"
  },
  mq135Raw: {
    key: "mq135Raw",
    label: "mq135 raw",
    unit: "raw",
    collection: "sensor"
  },
  predictedHumidity: {
    key: "predictedHumidity",
    label: "predicted humidity",
    unit: "%",
    collection: "ml"
  },
  actualHumidity: {
    key: "actualHumidity",
    label: "actual humidity",
    unit: "%",
    collection: "ml"
  },
  anomalyScore: {
    key: "anomalyScore",
    label: "anomaly score",
    unit: "",
    collection: "ml"
  },
  warningConfidence: {
    key: "warningConfidence",
    label: "warning confidence",
    unit: "",
    collection: "ml"
  }
};

const METRIC_ALIASES = new Map([
  ["temperature", "temperature"],
  ["temp", "temperature"],
  ["humidity", "humidity"],
  ["humid", "humidity"],
  ["light", "lightLux"],
  ["lux", "lightLux"],
  ["lightlux", "lightLux"],
  ["dust", "dustMgPerM3"],
  ["air dust", "dustMgPerM3"],
  ["air quality", "mq135AirQualityDeviation"],
  ["gas", "mq135AirQualityDeviation"],
  ["gas deviation", "mq135AirQualityDeviation"],
  ["mq135", "mq135AirQualityDeviation"],
  ["mq135raw", "mq135Raw"],
  ["mq135 raw", "mq135Raw"],
  ["prediction", "predictedHumidity"],
  ["predicted humidity", "predictedHumidity"],
  ["actual humidity", "actualHumidity"],
  ["anomaly score", "anomalyScore"],
  ["warning confidence", "warningConfidence"]
]);

const INFLUENCE_TARGET_ALIASES = new Map([
  ["warning level", "warningLevel"],
  ["warning", "warningLevel"],
  ["anomaly score", "anomalyScore"],
  ["anomaly", "anomalyScore"],
  ["humidity", "humidity"],
  ["predicted humidity", "predictedHumidity"],
  ["prediction", "predictedHumidity"],
  ["forecast", "predictedHumidity"],
  ["prediction error", "predictionError"],
  ["forecast error", "predictionError"],
  ["health score", "healthScore"],
  ["storage health", "healthScore"]
]);

function sanitizeZone(value, fallback = "zone1") {
  const raw = String(value || fallback).trim().toLowerCase().replace(/\s+/g, "");
  if (raw === "all") {
    return "all";
  }

  const normalized = raw.startsWith("zone") ? raw : `zone${raw.replace(/^z/, "")}`;
  if (!/^zone[a-z0-9_-]+$/i.test(normalized)) {
    throw new Error("Zone must be a safe zone identifier such as zone1.");
  }

  return normalized;
}

function normalizeMetric(value, fallback = "humidity") {
  if (!value) {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (METRIC_DEFINITIONS[normalized]) {
    return normalized;
  }

  for (const [alias, metric] of METRIC_ALIASES.entries()) {
    if (normalized === alias || normalized.includes(alias)) {
      return metric;
    }
  }

  throw new Error(`Unsupported metric: ${value}`);
}

function detectMetricFromText(text, fallback = "humidity") {
  const normalizedText = String(text || "").toLowerCase();
  for (const [alias, metric] of METRIC_ALIASES.entries()) {
    if (normalizedText.includes(alias)) {
      return metric;
    }
  }
  return fallback;
}

function detectZoneFromText(text, fallback = "zone1") {
  const normalizedText = String(text || "").toLowerCase();
  const match = normalizedText.match(/\bzone\s*([a-z0-9_-]+)\b/i) || normalizedText.match(/\b(zone[a-z0-9_-]+)\b/i);
  if (!match) {
    return sanitizeZone(fallback);
  }

  return sanitizeZone(match[1] ? `zone${String(match[1]).replace(/^zone/i, "")}` : match[0]);
}

function detectRangePresetFromText(text, fallback = null) {
  const normalizedText = String(text || "").toLowerCase();
  const presets = [
    "today",
    "yesterday",
    "this afternoon",
    "this morning",
    "last 24 hours",
    "this week",
    "last week",
    "last 7 days",
    "last 30 days"
  ];

  for (const preset of presets) {
    if (normalizedText.includes(preset)) {
      return preset;
    }
  }

  return fallback;
}

function normalizeInfluenceTarget(value, fallback = "warningLevel") {
  if (!value) {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (INFLUENCE_TARGET_ALIASES.has(normalized)) {
    return INFLUENCE_TARGET_ALIASES.get(normalized);
  }

  for (const [alias, target] of INFLUENCE_TARGET_ALIASES.entries()) {
    if (normalized.includes(alias)) {
      return target;
    }
  }

  throw new Error(`Unsupported influence target: ${value}`);
}

function detectInfluenceTargetFromText(text, fallback = "warningLevel") {
  const normalizedText = String(text || "").toLowerCase();
  for (const [alias, target] of INFLUENCE_TARGET_ALIASES.entries()) {
    if (normalizedText.includes(alias)) {
      return target;
    }
  }
  return fallback;
}

function getPresetRange(preset, now = new Date()) {
  const reference = new Date(now);
  const start = new Date(reference);
  const end = new Date(reference);
  const normalized = String(preset || "today").trim().toLowerCase();

  if (normalized === "today") {
    start.setHours(0, 0, 0, 0);
    return { from: start, to: end, label: "today" };
  }

  if (normalized === "yesterday") {
    start.setDate(start.getDate() - 1);
    start.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() - 1);
    end.setHours(23, 59, 59, 999);
    return { from: start, to: end, label: "yesterday" };
  }

  if (normalized === "this afternoon") {
    start.setHours(12, 0, 0, 0);
    if (end < start) {
      end.setHours(18, 0, 0, 0);
    }
    return { from: start, to: end, label: "this afternoon" };
  }

  if (normalized === "this morning") {
    start.setHours(6, 0, 0, 0);
    end.setHours(Math.min(end.getHours(), 11), end.getMinutes(), end.getSeconds(), end.getMilliseconds());
    return { from: start, to: end, label: "this morning" };
  }

  if (normalized === "last 24 hours") {
    start.setHours(start.getHours() - 24);
    return { from: start, to: end, label: "the last 24 hours" };
  }

  if (normalized === "this week") {
    const day = start.getDay();
    const diff = day === 0 ? 6 : day - 1;
    start.setDate(start.getDate() - diff);
    start.setHours(0, 0, 0, 0);
    return { from: start, to: end, label: "this week" };
  }

  if (normalized === "last week") {
    const currentWeek = getPresetRange("this week", reference);
    const previousFrom = new Date(currentWeek.from);
    previousFrom.setDate(previousFrom.getDate() - 7);
    const previousTo = new Date(currentWeek.from);
    previousTo.setMilliseconds(-1);
    return { from: previousFrom, to: previousTo, label: "last week" };
  }

  if (normalized === "last 7 days") {
    start.setDate(start.getDate() - 7);
    return { from: start, to: end, label: "the last 7 days" };
  }

  if (normalized === "last 30 days") {
    start.setDate(start.getDate() - 30);
    return { from: start, to: end, label: "the last 30 days" };
  }

  return getPresetRange("today", now);
}

function clampRange(from, to) {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error("Invalid date range.");
  }
  if (start > end) {
    throw new Error("Date range start must be before the end.");
  }

  const maxSpanMs = MAX_HISTORY_DAYS * 24 * 60 * 60 * 1000;
  if ((end.getTime() - start.getTime()) > maxSpanMs) {
    start.setTime(end.getTime() - maxSpanMs);
  }

  return {
    from: start,
    to: end
  };
}

function average(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  if (valid.length === 0) {
    return null;
  }

  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function pearsonCorrelation(leftValues, rightValues) {
  const pairs = [];
  const length = Math.min(leftValues.length, rightValues.length);
  for (let index = 0; index < length; index += 1) {
    const left = Number(leftValues[index]);
    const right = Number(rightValues[index]);
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      continue;
    }
    pairs.push([left, right]);
  }

  if (pairs.length < 3) {
    return null;
  }

  const leftMean = average(pairs.map(([value]) => value));
  const rightMean = average(pairs.map(([, value]) => value));
  if (!Number.isFinite(leftMean) || !Number.isFinite(rightMean)) {
    return null;
  }

  let numerator = 0;
  let leftVariance = 0;
  let rightVariance = 0;

  for (const [left, right] of pairs) {
    const leftDelta = left - leftMean;
    const rightDelta = right - rightMean;
    numerator += leftDelta * rightDelta;
    leftVariance += leftDelta ** 2;
    rightVariance += rightDelta ** 2;
  }

  const denominator = Math.sqrt(leftVariance * rightVariance);
  if (!Number.isFinite(denominator) || denominator === 0) {
    return null;
  }

  return numerator / denominator;
}

function formatNumber(value, decimals = 1) {
  if (!Number.isFinite(value)) {
    return "unavailable";
  }

  return Number(value).toFixed(decimals);
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "an unknown time";
  }

  return date.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function summarizeSeries(points, key) {
  const values = points
    .map((point) => point[key])
    .filter((value) => Number.isFinite(value));

  if (values.length === 0) {
    return {
      count: 0,
      min: null,
      max: null,
      average: null,
      latest: null
    };
  }

  return {
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    average: average(values),
    latest: values[values.length - 1]
  };
}

function samplePoints(points, maxPoints = MAX_POINTS) {
  if (points.length <= maxPoints) {
    return points;
  }

  const step = Math.ceil(points.length / maxPoints);
  return points.filter((_, index) => index % step === 0);
}

function warningLevelToNumber(level) {
  const normalized = String(level || "").trim().toLowerCase();
  if (normalized === "high") {
    return 3;
  }
  if (normalized === "medium") {
    return 2;
  }
  if (normalized === "low") {
    return 1;
  }
  return 0;
}

function numberToWarningLevel(value) {
  if (value >= 2.5) {
    return "high";
  }
  if (value >= 1.5) {
    return "medium";
  }
  return "low";
}

function sortWarningRows(rows) {
  return rows.slice().sort((left, right) => {
    const warningDiff = warningLevelToNumber(right.warningLevel) - warningLevelToNumber(left.warningLevel);
    if (warningDiff !== 0) {
      return warningDiff;
    }

    return (right.anomalyScore || 0) - (left.anomalyScore || 0);
  });
}

async function loadLatestMlDocument(mlCollection, zone, includePredictionOnly = false) {
  const query = zone ? { zone } : {};
  if (includePredictionOnly) {
    query.predictedHumidity = { $ne: null };
  }

  return mlCollection
    .find(query)
    .sort({ timestamp: -1, _id: -1 })
    .limit(1)
    .next();
}

function computeHealthScore({ actual, mlStatus, thresholds }) {
  const warningLevel = String(mlStatus?.warningLevel || "").toLowerCase();
  if (warningLevel === "high") {
    return 38;
  }
  if (warningLevel === "medium") {
    return 67;
  }
  if (mlStatus?.anomalyFlag) {
    return mlStatus.anomalyScore >= 0.75 ? 48 : 71;
  }

  if (!actual) {
    return null;
  }

  if ((actual.humidity ?? 0) >= thresholds.humidity.high || (actual.mq135AirQualityDeviation ?? 0) >= thresholds.gas.high) {
    return 42;
  }
  if ((actual.humidity ?? 0) >= thresholds.humidity.medium || (actual.dustMgPerM3 ?? 0) >= thresholds.dust.medium) {
    return 68;
  }

  return 93;
}

async function loadLatestMlStatus({ config, sensorCollection, mlCollection, zone, allowLiveInference = true }) {
  const latestDocument = await loadLatestMlDocument(mlCollection, zone);
  if (latestDocument) {
    return {
      source: "stored",
      data: {
        ...toMlInferenceSnapshot(latestDocument, config.backendModelVersion),
        healthScore: computeHealthScore({
          actual: latestDocument.actualHumidity ? {
            humidity: latestDocument.actualHumidity,
            dustMgPerM3: null,
            mq135AirQualityDeviation: null
          } : null,
          mlStatus: toMlInferenceSnapshot(latestDocument, config.backendModelVersion),
          thresholds: config.riskThresholds
        }),
        timestamp: latestDocument.timestamp
      },
      document: latestDocument
    };
  }

  if (!allowLiveInference) {
    return {
      source: "unavailable",
      data: null,
      document: null
    };
  }

  const latestReading = await loadLatestSensorReading(sensorCollection, zone);
  if (!latestReading) {
    return {
      source: "unavailable",
      data: null,
      document: null
    };
  }

  const { result } = await inferAnomalyWarning(config, sensorCollection, {
    timestamp: new Date(latestReading.timestamp).toISOString(),
    zone: latestReading.zone,
    temperature: latestReading.temperature,
    humidity: latestReading.humidity,
    lightLux: latestReading.lightLux,
    dustMgPerM3: latestReading.dustMgPerM3,
    mq135Raw: latestReading.mq135Raw,
    mq135AirQualityDeviation: latestReading.mq135AirQualityDeviation
  });
  const data = {
    anomalyFlag: result.anomalyFlag,
    anomalyScore: result.anomalyScore,
    anomalyReasons: result.anomalyReasons,
    warningLevel: result.warningLevel,
    warningConfidence: result.warningConfidence,
    modelVersion: result.modelVersion?.warning || config.backendModelVersion,
    healthScore: computeHealthScore({
      actual: latestReading,
      mlStatus: result,
      thresholds: config.riskThresholds
    }),
    timestamp: latestReading.timestamp
  };

  return {
    source: "live-inferred",
    data,
    document: null
  };
}

async function loadLatestZoneStatus({ sensorCollection, zone }) {
  const latest = await loadLatestSensorReading(sensorCollection, zone);
  return latest ? toApiReading(normalizeStoredReading(latest)) : null;
}

async function readRecentZoneRows(sensorCollection, limit = 500) {
  const documents = await sensorCollection
    .find()
    .sort({ timestamp: -1, _id: -1 })
    .limit(limit)
    .toArray();

  const latestByZone = new Map();
  for (const document of documents) {
    const normalized = normalizeStoredReading(document);
    if (!latestByZone.has(normalized.zone)) {
      latestByZone.set(normalized.zone, toApiReading(normalized));
    }
  }

  return Array.from(latestByZone.values());
}

async function fetchSensorSeries({ sensorCollection, zone, from, to, metrics }) {
  const range = clampRange(from, to);
  const rows = await sensorCollection
    .find({
      zone,
      timestamp: { $gte: range.from, $lte: range.to }
    })
    .sort({ timestamp: 1, _id: 1 })
    .toArray();

  const normalizedMetrics = metrics.map((metric) => normalizeMetric(metric));
  const points = rows.map((row) => {
    const normalized = normalizeStoredReading(row);
    const point = { timestamp: normalized.timestamp };
    for (const metric of normalizedMetrics) {
      point[metric] = normalized[metric] ?? null;
    }
    return point;
  });

  return {
    from: range.from,
    to: range.to,
    metrics: normalizedMetrics,
    points: samplePoints(points)
  };
}

async function fetchMlSeries({ mlCollection, zone, from, to, metrics }) {
  const range = clampRange(from, to);
  const rows = await mlCollection
    .find({
      zone,
      timestamp: { $gte: range.from, $lte: range.to }
    })
    .sort({ timestamp: 1, _id: 1 })
    .toArray();

  const normalizedMetrics = metrics.map((metric) => normalizeMetric(metric));
  const points = rows.map((row) => {
    const point = { timestamp: row.timestamp };
    for (const metric of normalizedMetrics) {
      point[metric] = row[metric] ?? null;
    }
    return point;
  });

  return {
    from: range.from,
    to: range.to,
    metrics: normalizedMetrics,
    points: samplePoints(points)
  };
}

function buildComparisonInterpretation(metric, delta, percentChange) {
  const label = METRIC_DEFINITIONS[metric]?.label || metric;
  if (!Number.isFinite(delta)) {
    return `There is not enough data to compare ${label} between the requested periods.`;
  }
  if (Math.abs(delta) < 0.0001) {
    return `${label} was essentially unchanged between the two periods.`;
  }

  const direction = delta > 0 ? "higher" : "lower";
  return `${label} was ${formatNumber(Math.abs(delta), 2)} ${METRIC_DEFINITIONS[metric]?.unit || ""}`.trim()
    + ` ${direction}, which is a ${formatNumber(Math.abs(percentChange), 1)}% change.`;
}

function topCounts(values, limit = 3) {
  const counts = new Map();
  for (const value of values) {
    if (!value) {
      continue;
    }
    counts.set(value, (counts.get(value) || 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function resolveDocPaths() {
  return [
    path.resolve(__dirname, "..", "..", "README.md"),
    path.resolve(__dirname, "..", "..", ".env.example"),
    path.resolve(__dirname, "..", "..", "arduino", "esp32_mongo_ready", "esp32_mongo_ready.ino")
  ];
}

function searchTextSnippets(query, limit = 3) {
  const terms = String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
  if (terms.length === 0) {
    return [];
  }

  const matches = [];
  for (const filePath of resolveDocPaths()) {
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const sections = content.split(/\n#{1,3}\s+/).filter(Boolean);
    for (const section of sections) {
      const haystack = section.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      if (score === 0) {
        continue;
      }

      matches.push({
        filePath: path.basename(filePath),
        score,
        snippet: section.slice(0, 420).trim()
      });
    }
  }

  return matches
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

module.exports = {
  MAX_HISTORY_DAYS,
  METRIC_DEFINITIONS,
  average,
  buildComparisonInterpretation,
  clampRange,
  computeHealthScore,
  detectInfluenceTargetFromText,
  detectMetricFromText,
  detectRangePresetFromText,
  detectZoneFromText,
  fetchMlSeries,
  fetchSensorSeries,
  formatNumber,
  formatTimestamp,
  getPresetRange,
  loadLatestMlDocument,
  loadLatestMlStatus,
  loadLatestZoneStatus,
  normalizeMetric,
  normalizeInfluenceTarget,
  numberToWarningLevel,
  pearsonCorrelation,
  readRecentZoneRows,
  samplePoints,
  sanitizeZone,
  searchTextSnippets,
  sortWarningRows,
  summarizeSeries,
  topCounts,
  toTinymlSnapshot,
  warningLevelToNumber
};
