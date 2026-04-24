function toFiniteNumber(value) {
  const number = typeof value === "string" ? Number.parseFloat(value) : value;
  return Number.isFinite(number) ? number : undefined;
}

function sanitizeObject(object) {
  const sanitized = {};

  for (const [key, value] of Object.entries(object)) {
    if (value === undefined) {
      continue;
    }

    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      const nested = sanitizeObject(value);
      if (Object.keys(nested).length > 0) {
        sanitized[key] = nested;
      }
      continue;
    }

    sanitized[key] = value;
  }

  return sanitized;
}

function parseTimestamp(value) {
  if (value === undefined || value === null || value === "") {
    return new Date();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function normalizeDhtPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  return sanitizeObject({
    valid: typeof payload.valid === "boolean" ? payload.valid : undefined,
    temperatureC: toFiniteNumber(payload.temperatureC),
    humidity: toFiniteNumber(payload.humidity)
  });
}

function normalizeDustPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  return sanitizeObject({
    raw: toFiniteNumber(payload.raw),
    voltage: toFiniteNumber(payload.voltage),
    densityMgPerM3: toFiniteNumber(payload.densityMgPerM3)
  });
}

function normalizeLightPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  return sanitizeObject({
    lux: toFiniteNumber(payload.lux)
  });
}

function normalizeMq135Payload(payload) {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  return sanitizeObject({
    raw: toFiniteNumber(payload.raw),
    airQualityDeviation: toFiniteNumber(payload.airQualityDeviation)
  });
}

function hasSensorData(sensors) {
  return Object.values(sensors).some((value) => value && Object.keys(value).length > 0);
}

class SensorStreamParser {
  constructor(options = {}) {
    this.defaultDeviceId = options.defaultDeviceId || "esp32-garment-1";
    this.resetLegacyReport();
  }

  processLine(line) {
    const trimmed = line.trim();
    if (!trimmed) {
      return [];
    }

    const jsonDocument = this.tryParseJsonDocument(trimmed);
    if (jsonDocument) {
      return [jsonDocument];
    }

    const legacyDocument = this.processLegacyLine(trimmed);
    return legacyDocument ? [legacyDocument] : [];
  }

  flush() {
    const document = this.finalizeLegacyReport();
    return document ? [document] : [];
  }

  tryParseJsonDocument(line) {
    if (!line.startsWith("{") || !line.endsWith("}")) {
      return null;
    }

    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      return null;
    }

    const sensors = sanitizeObject({
      dht1: normalizeDhtPayload(payload.dht1),
      dht2: normalizeDhtPayload(payload.dht2),
      dust: normalizeDustPayload(payload.dust),
      light: normalizeLightPayload(payload.light),
      mq135: normalizeMq135Payload(payload.mq135)
    });

    if (!hasSensorData(sensors)) {
      return null;
    }

    return {
      deviceId: payload.deviceId || this.defaultDeviceId,
      sourceFormat: "json",
      collectedAt: parseTimestamp(payload.collectedAt || payload.timestamp),
      ingestedAt: new Date(),
      sensors,
      rawPayload: payload
    };
  }

  resetLegacyReport() {
    this.legacyReport = {
      active: false,
      currentSection: null,
      rawLines: [],
      data: {
        dust: {},
        light: {},
        dht1: {},
        dht2: {}
      }
    };
  }

  processLegacyLine(line) {
    if (line === "Integrated Sensor Report") {
      const pendingDocument = this.finalizeLegacyReport();
      this.legacyReport.active = true;
      this.legacyReport.currentSection = null;
      this.legacyReport.rawLines.push(line);
      return pendingDocument;
    }

    if (!this.legacyReport.active) {
      return null;
    }

    if (/^-+$/.test(line)) {
      return this.finalizeLegacyReport();
    }

    this.legacyReport.rawLines.push(line);

    if (line === "[Dust Sensor]") {
      this.legacyReport.currentSection = "dust";
      return null;
    }

    if (line === "[BH1750 Light Sensor]") {
      this.legacyReport.currentSection = "light";
      return null;
    }

    if (line === "[DHT22#1]") {
      this.legacyReport.currentSection = "dht1";
      return null;
    }

    if (line === "[DHT22#2]") {
      this.legacyReport.currentSection = "dht2";
      return null;
    }

    const voltageMatch = line.match(/^Dust Output Voltage:\s*([-+]?\d*\.?\d+)/i);
    if (voltageMatch) {
      this.legacyReport.data.dust.voltage = toFiniteNumber(voltageMatch[1]);
      return null;
    }

    const densityMatch = line.match(/^Dust Density Est\.\s*:\s*([-+]?\d*\.?\d+)/i);
    if (densityMatch) {
      this.legacyReport.data.dust.densityMgPerM3 = toFiniteNumber(densityMatch[1]);
      return null;
    }

    const lightMatch = line.match(/^Light Intensity:\s*([-+]?\d*\.?\d+)/i);
    if (lightMatch) {
      this.legacyReport.data.light.lux = toFiniteNumber(lightMatch[1]);
      return null;
    }

    const temperatureMatch = line.match(/^Temperature:\s*([-+]?\d*\.?\d+)/i);
    if (temperatureMatch && this.legacyReport.currentSection) {
      this.legacyReport.data[this.legacyReport.currentSection].temperatureC = toFiniteNumber(temperatureMatch[1]);
      return null;
    }

    const humidityMatch = line.match(/^Humidity\s*:\s*([-+]?\d*\.?\d+)/i);
    if (humidityMatch && this.legacyReport.currentSection) {
      this.legacyReport.data[this.legacyReport.currentSection].humidity = toFiniteNumber(humidityMatch[1]);
    }

    return null;
  }

  finalizeLegacyReport() {
    if (!this.legacyReport.active) {
      return null;
    }

    const sensors = sanitizeObject(this.legacyReport.data);
    const rawReport = this.legacyReport.rawLines.slice();
    this.resetLegacyReport();

    if (!hasSensorData(sensors)) {
      return null;
    }

    return {
      deviceId: this.defaultDeviceId,
      sourceFormat: "legacy-report",
      collectedAt: new Date(),
      ingestedAt: new Date(),
      sensors,
      rawReport
    };
  }
}

module.exports = {
  SensorStreamParser
};
