function toFiniteNumber(value) {
  const parsed = typeof value === "string" ? Number.parseFloat(value) : value;
  return Number.isFinite(parsed) ? parsed : null;
}

function average(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  if (valid.length === 0) {
    return null;
  }

  const total = valid.reduce((sum, value) => sum + value, 0);
  return Number((total / valid.length).toFixed(3));
}

function normalizeTimestamp(value) {
  if (!value) {
    return new Date();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function deriveMq135Deviation(rawValue, baseline) {
  if (!Number.isFinite(rawValue)) {
    return null;
  }

  const denominator = Number.isFinite(baseline) && baseline !== 0 ? baseline : 1;
  return Number((((rawValue - denominator) / denominator) * 10).toFixed(6));
}

function normalizeStoredReading(document = {}) {
  const dht1 = document.sensors?.dht1 || {};
  const dht2 = document.sensors?.dht2 || {};
  const mq135 = document.sensors?.mq135 || {};

  const temperature = toFiniteNumber(document.temperature)
    ?? average([toFiniteNumber(dht1.temperatureC), toFiniteNumber(dht2.temperatureC)]);
  const humidity = toFiniteNumber(document.humidity)
    ?? average([toFiniteNumber(dht1.humidity), toFiniteNumber(dht2.humidity)]);
  const lightLux = toFiniteNumber(document.lightLux)
    ?? toFiniteNumber(document.light)
    ?? toFiniteNumber(document.sensors?.light?.lux);
  const dustMgPerM3 = toFiniteNumber(document.dustMgPerM3)
    ?? toFiniteNumber(document.dust)
    ?? toFiniteNumber(document.sensors?.dust?.densityMgPerM3);
  const mq135Raw = toFiniteNumber(document.mq135Raw)
    ?? toFiniteNumber(mq135.raw);
  const mq135AirQualityDeviation = toFiniteNumber(document.mq135AirQualityDeviation)
    ?? toFiniteNumber(mq135.airQualityDeviation);

  return {
    ...document,
    timestamp: normalizeTimestamp(document.timestamp || document.collectedAt),
    zone: document.zone || document.rawPayload?.zone || "zone1",
    temperature,
    humidity,
    lightLux,
    dustMgPerM3,
    mq135Raw,
    mq135AirQualityDeviation,
    light: lightLux,
    dust: dustMgPerM3
  };
}

function toApiReading(document = {}) {
  const normalized = normalizeStoredReading(document);

  return {
    id: document._id ? String(document._id) : undefined,
    timestamp: normalized.timestamp,
    zone: normalized.zone,
    temperature: normalized.temperature,
    humidity: normalized.humidity,
    lightLux: normalized.lightLux,
    dustMgPerM3: normalized.dustMgPerM3,
    mq135Raw: normalized.mq135Raw,
    mq135AirQualityDeviation: normalized.mq135AirQualityDeviation,
    light: normalized.light,
    dust: normalized.dust,
    risk_level: document.risk_level || null
  };
}

module.exports = {
  average,
  deriveMq135Deviation,
  normalizeStoredReading,
  normalizeTimestamp,
  toApiReading,
  toFiniteNumber
};
