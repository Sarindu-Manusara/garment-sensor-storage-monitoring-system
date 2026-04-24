function asFiniteNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requireFiniteNumber(value, label) {
  const parsed = asFiniteNumber(value);
  if (parsed === null) {
    throw new Error(`${label} must be a finite number.`);
  }

  return parsed;
}

function requireIsoTimestamp(value, label = "timestamp") {
  if (!value) {
    throw new Error(`${label} is required.`);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} must be a valid ISO timestamp.`);
  }

  return parsed;
}

function parseOptionalConversationId(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const normalized = String(value).trim();
  if (!/^[a-zA-Z0-9_-]{4,120}$/.test(normalized)) {
    throw new Error("conversationId must be a safe identifier.");
  }

  return normalized;
}

function parseLiveInferencePayload(payload = {}) {
  const timestamp = requireIsoTimestamp(payload.timestamp);
  const sample = {
    timestamp: timestamp.toISOString(),
    zone: String(payload.zone || "zone1").trim() || "zone1",
    temperature: asFiniteNumber(payload.temperature),
    humidity: asFiniteNumber(payload.humidity),
    lightLux: asFiniteNumber(payload.lightLux ?? payload.light),
    dustMgPerM3: asFiniteNumber(payload.dustMgPerM3 ?? payload.dust),
    mq135Raw: asFiniteNumber(payload.mq135Raw),
    mq135AirQualityDeviation: asFiniteNumber(payload.mq135AirQualityDeviation)
  };

  if (Object.values(sample).slice(2).every((value) => value === null)) {
    throw new Error("At least one sensor value is required.");
  }

  return sample;
}

function parseTinymlPredictionPayload(payload = {}) {
  const timestamp = requireIsoTimestamp(payload.timestamp);
  const predictionHorizon = Number.parseInt(payload.predictionHorizon ?? "1", 10);
  if (!Number.isInteger(predictionHorizon) || predictionHorizon <= 0) {
    throw new Error("predictionHorizon must be a positive integer.");
  }

  return {
    timestamp: timestamp.toISOString(),
    zone: String(payload.zone || "zone1").trim() || "zone1",
    predictedHumidity: requireFiniteNumber(payload.predictedHumidity, "predictedHumidity"),
    predictionHorizon,
    inferenceLatencyMs: requireFiniteNumber(payload.inferenceLatencyMs ?? 0, "inferenceLatencyMs"),
    modelVersion: String(payload.modelVersion || "tinyml-humidity-v1").trim() || "tinyml-humidity-v1"
  };
}

function parseHistoryRange(query = {}) {
  const now = new Date();
  const to = query.to ? requireIsoTimestamp(query.to, "to") : now;
  const from = query.from
    ? requireIsoTimestamp(query.from, "from")
    : new Date(to.getTime() - (24 * 60 * 60 * 1000));

  if (from > to) {
    throw new Error("from must be before to.");
  }

  return {
    from,
    to,
    zone: String(query.zone || "zone1").trim() || "zone1"
  };
}

function parseSafeZone(value, fallback = "zone1") {
  const normalized = String(value || fallback).trim().toLowerCase().replace(/\s+/g, "");
  if (!/^zone[a-z0-9_-]+$/i.test(normalized)) {
    throw new Error("zone must be a safe zone identifier such as zone1.");
  }
  return normalized;
}

function parseEventDetailQuery(query = {}) {
  return {
    zone: parseSafeZone(query.zone || "zone1"),
    timestamp: requireIsoTimestamp(query.timestamp).toISOString()
  };
}

function parseChatMessagePayload(payload = {}) {
  const message = String(payload.message || "").trim();
  if (!message) {
    throw new Error("message is required.");
  }
  if (message.length > 2000) {
    throw new Error("message must be 2000 characters or fewer.");
  }

  return {
    message,
    conversationId: parseOptionalConversationId(payload.conversationId),
    zone: payload.zone ? String(payload.zone).trim() : undefined
  };
}

function parseConversationQuery(query = {}) {
  const conversationId = parseOptionalConversationId(query.conversationId);
  if (!conversationId) {
    throw new Error("conversationId is required.");
  }

  return {
    conversationId
  };
}

module.exports = {
  asFiniteNumber,
  parseChatMessagePayload,
  parseConversationQuery,
  parseEventDetailQuery,
  parseHistoryRange,
  parseLiveInferencePayload,
  parseTinymlPredictionPayload,
  requireIsoTimestamp
};
