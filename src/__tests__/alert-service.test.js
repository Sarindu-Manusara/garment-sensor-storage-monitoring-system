const test = require("node:test");
const assert = require("node:assert/strict");

const { createAlertService, deriveHealthStatus } = require("../alertService");
const { processLatestReadingsOnce } = require("../alertMonitor");
const { InMemoryCollection } = require("./helpers/inMemoryMongo");

function buildConfig(overrides = {}) {
  return {
    zone: "zone1",
    publicDashboardUrl: "https://example.com/dashboard",
    waapiEnabled: true,
    waapiBaseUrl: "https://waapi.app/api/v1/instances",
    waapiInstanceId: "instance-123",
    waapiApiToken: "token-123",
    waapiChatIds: ["1234567890@c.us"],
    waapiRecipientPhones: [],
    waapiAlertCooldownMinutes: 30,
    waapiSendWarningAlerts: true,
    waapiSendDangerAlerts: true,
    riskThresholds: {
      temperature: { medium: 28, high: 30 },
      humidity: { medium: 60, high: 70 },
      light: { medium: 150, high: 300 },
      dust: { medium: 0.03, high: 0.045 },
      gas: { medium: 0.75, high: 1.5 }
    },
    backendModelVersion: "backend-ml-v1",
    ...overrides
  };
}

test("deriveHealthStatus prioritizes backend warning output and thresholds", () => {
  const config = buildConfig();

  assert.equal(deriveHealthStatus({
    actualReading: {
      humidity: 42,
      mq135AirQualityDeviation: 0.1
    },
    inference: {
      warningLevel: "high"
    },
    thresholds: config.riskThresholds
  }), "danger");

  assert.equal(deriveHealthStatus({
    actualReading: {
      humidity: 66,
      mq135AirQualityDeviation: 0.1,
      dustMgPerM3: 0.02
    },
    inference: null,
    thresholds: config.riskThresholds
  }), "warning");
});

test("WAAPI alert service sends once and deduplicates repeated warning state", async () => {
  const alertCollection = new InMemoryCollection([]);
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({
      url,
      options
    });

    return {
      ok: true,
      async json() {
        return {
          id: "message-1"
        };
      }
    };
  };
  const alertService = createAlertService({
    config: buildConfig(),
    alertCollection,
    fetchImpl
  });

  const payload = {
    actualReading: {
      zone: "zone1",
      timestamp: new Date("2026-04-25T02:30:00.000Z"),
      humidity: 73.8,
      dustMgPerM3: 0.052,
      mq135AirQualityDeviation: 1.91
    },
    inference: {
      warningLevel: "high",
      warningConfidence: 0.94,
      anomalyFlag: true,
      anomalyScore: 0.88,
      anomalyReasons: ["humidity_spike", "gas_proxy_high"]
    }
  };

  const first = await alertService.sendAlert(payload);
  assert.equal(first.sent, true);
  assert.equal(first.healthStatus, "danger");
  assert.equal(requests.length, 1);
  assert.equal(alertCollection.documents.length, 1);

  const second = await alertService.sendAlert(payload);
  assert.equal(second.sent, false);
  assert.equal(second.deduplicated, true);
  assert.equal(requests.length, 1);
});

test("live monitor persists inference for new readings and triggers alert delivery", async () => {
  const sensorCollection = new InMemoryCollection([
    {
      _id: "sensor-1",
      zone: "zone1",
      timestamp: new Date("2026-04-25T03:00:00.000Z"),
      temperature: 31.2,
      humidity: 74.1,
      lightLux: 81,
      dustMgPerM3: 0.049,
      mq135Raw: 2830,
      mq135AirQualityDeviation: 1.82
    }
  ]);
  const mlCollection = new InMemoryCollection([]);
  const alertCollection = new InMemoryCollection([]);
  const sentAlerts = [];
  const alertService = {
    async sendAlert(payload) {
      sentAlerts.push(payload);
      return {
        sent: true,
        healthStatus: "danger"
      };
    }
  };
  const state = {
    lastProcessedByZone: new Map()
  };

  const processed = await processLatestReadingsOnce({
    config: buildConfig(),
    sensorCollection,
    mlCollection,
    alertService,
    inferService: async () => ({
      result: {
        anomalyFlag: true,
        anomalyScore: 0.92,
        anomalyReasons: ["humidity_spike"],
        warningLevel: "high",
        warningConfidence: 0.97,
        modelVersion: {
          warning: "backend-ml-v1"
        }
      }
    }),
    state
  });

  assert.equal(processed.length, 1);
  assert.equal(processed[0].zone, "zone1");
  assert.equal(mlCollection.documents.length, 1);
  assert.equal(mlCollection.documents[0].warningLevel, "high");
  assert.equal(sentAlerts.length, 1);
  assert.equal(alertCollection.documents.length, 0);

  const secondPass = await processLatestReadingsOnce({
    config: buildConfig(),
    sensorCollection,
    mlCollection,
    alertService,
    inferService: async () => {
      throw new Error("should not re-run inference for the same reading");
    },
    state
  });

  assert.equal(secondPass.length, 0);
});
