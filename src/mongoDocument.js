const { average, deriveMq135Deviation } = require("./sensorSchema");

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function collectDhtValues(sensors, key) {
  const values = [];

  for (const sensorName of ["dht1", "dht2"]) {
    const dht = sensors?.[sensorName];
    if (!dht || dht.valid === false) {
      continue;
    }

    if (isFiniteNumber(dht[key])) {
      values.push(dht[key]);
    }
  }

  return values;
}

function toRiskScore(value, thresholds) {
  if (!isFiniteNumber(value) || !thresholds) {
    return 0;
  }

  if (value >= thresholds.high) {
    return 2;
  }

  if (value >= thresholds.medium) {
    return 1;
  }

  return 0;
}

function riskLevelFromScore(score) {
  if (score >= 2) {
    return "HIGH";
  }

  if (score === 1) {
    return "MEDIUM";
  }

  return "LOW";
}

function buildMongoDocument(parsedDocument, config) {
  const temperature = average(collectDhtValues(parsedDocument.sensors, "temperatureC"));
  const humidity = average(collectDhtValues(parsedDocument.sensors, "humidity"));
  const lightLux = isFiniteNumber(parsedDocument.sensors?.light?.lux)
    ? parsedDocument.sensors.light.lux
    : undefined;
  const dustMgPerM3 = isFiniteNumber(parsedDocument.sensors?.dust?.densityMgPerM3)
    ? parsedDocument.sensors.dust.densityMgPerM3
    : undefined;
  const mq135Raw = isFiniteNumber(parsedDocument.sensors?.mq135?.raw)
    ? parsedDocument.sensors.mq135.raw
    : undefined;
  const mq135AirQualityDeviation = isFiniteNumber(parsedDocument.sensors?.mq135?.airQualityDeviation)
    ? parsedDocument.sensors.mq135.airQualityDeviation
    : deriveMq135Deviation(mq135Raw, config.mq135BaselineRaw);

  const highestRiskScore = Math.max(
    toRiskScore(temperature, config.riskThresholds.temperature),
    toRiskScore(humidity, config.riskThresholds.humidity),
    toRiskScore(lightLux, config.riskThresholds.light),
    toRiskScore(dustMgPerM3, config.riskThresholds.dust),
    toRiskScore(mq135AirQualityDeviation, config.riskThresholds.gas)
  );

  return {
    timestamp: parsedDocument.collectedAt instanceof Date ? parsedDocument.collectedAt : new Date(),
    zone: config.zone,
    deviceId: parsedDocument.deviceId || config.deviceId,
    sourceFormat: parsedDocument.sourceFormat || "json",
    temperature: temperature ?? null,
    humidity: humidity ?? null,
    lightLux: lightLux ?? null,
    dustMgPerM3: dustMgPerM3 ?? null,
    mq135Raw: mq135Raw ?? null,
    mq135AirQualityDeviation: mq135AirQualityDeviation ?? null,
    light: lightLux ?? null,
    dust: dustMgPerM3 ?? null,
    risk_level: riskLevelFromScore(highestRiskScore)
  };
}

module.exports = {
  buildMongoDocument,
  riskLevelFromScore,
  toRiskScore
};
