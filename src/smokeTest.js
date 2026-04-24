const assert = require("node:assert/strict");

const { buildMongoDocument } = require("./mongoDocument");
const { SensorStreamParser } = require("./sensorParser");

function main() {
  const config = {
    zone: "zone1",
    riskThresholds: {
      temperature: { medium: 28, high: 30 },
      humidity: { medium: 60, high: 70 },
      light: { medium: 150, high: 300 },
      dust: { medium: 0.03, high: 0.045 },
      gas: { medium: 0.75, high: 1.5 }
    },
    mq135BaselineRaw: 2800
  };

  const parser = new SensorStreamParser({
    defaultDeviceId: "smoke-device"
  });

  const jsonDocuments = parser.processLine(
    JSON.stringify({
      deviceId: "esp32-json",
      timestamp: "2026-03-15T10:00:00.000Z",
      dht1: {
        valid: true,
        temperatureC: 29.4,
        humidity: 62.1
      },
      dht2: {
        valid: true,
        temperatureC: 30.1,
        humidity: 59.8
      },
      dust: {
        raw: 1720,
        voltage: 1.386,
        densityMgPerM3: 0.136
      },
      light: {
        lux: 432.5
      },
      mq135: {
        raw: 2831,
        airQualityDeviation: 0.110714
      }
    })
  );

  assert.equal(jsonDocuments.length, 1);
  assert.equal(jsonDocuments[0].sourceFormat, "json");
  assert.equal(jsonDocuments[0].sensors.dht1.temperatureC, 29.4);
  assert.equal(jsonDocuments[0].sensors.light.lux, 432.5);
  assert.equal(jsonDocuments[0].sensors.mq135.raw, 2831);

  const mappedJsonDocument = buildMongoDocument(jsonDocuments[0], config);
  assert.equal(mappedJsonDocument.zone, "zone1");
  assert.equal(mappedJsonDocument.temperature, 29.75);
  assert.equal(mappedJsonDocument.humidity, 60.95);
  assert.equal(mappedJsonDocument.light, 432.5);
  assert.equal(mappedJsonDocument.dust, 0.136);
  assert.equal(mappedJsonDocument.mq135Raw, 2831);
  assert.equal(mappedJsonDocument.risk_level, "HIGH");
  assert.ok(mappedJsonDocument.timestamp instanceof Date);

  const legacyLines = [
    "--------------------------------------------------",
    "Integrated Sensor Report",
    "[Dust Sensor]",
    "Dust Output Voltage: 1.386 V",
    "Dust Density Est.  : 0.136 mg/m^3",
    "[BH1750 Light Sensor]",
    "Light Intensity: 432.5 lx",
    "[DHT22#1]",
    "Temperature: 29.4 C",
    "[DHT22#2]",
    "Humidity   : 59.8 %",
    "--------------------------------------------------"
  ];

  const legacyDocuments = [];
  for (const line of legacyLines) {
    legacyDocuments.push(...parser.processLine(line));
  }

  assert.equal(legacyDocuments.length, 1);
  assert.equal(legacyDocuments[0].sourceFormat, "legacy-report");
  assert.equal(legacyDocuments[0].sensors.dust.voltage, 1.386);
  assert.equal(legacyDocuments[0].sensors.dht2.humidity, 59.8);

  const mappedLegacyDocument = buildMongoDocument(legacyDocuments[0], config);
  assert.equal(mappedLegacyDocument.zone, "zone1");
  assert.equal(mappedLegacyDocument.temperature, 29.4);
  assert.equal(mappedLegacyDocument.humidity, 59.8);
  assert.equal(mappedLegacyDocument.risk_level, "HIGH");

  console.log("Smoke test passed.");
}

main();
