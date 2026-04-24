const test = require("node:test");
const assert = require("node:assert/strict");

const { buildApp } = require("../server");

class InMemoryCursor {
  constructor(documents) {
    this.documents = documents;
  }

  sort(sortSpec) {
    const entries = Object.entries(sortSpec);
    this.documents.sort((left, right) => {
      for (const [field, direction] of entries) {
        const leftValue = left[field];
        const rightValue = right[field];
        if (leftValue < rightValue) {
          return -1 * direction;
        }
        if (leftValue > rightValue) {
          return 1 * direction;
        }
      }
      return 0;
    });
    return this;
  }

  limit(limit) {
    this.documents = this.documents.slice(0, limit);
    return this;
  }

  async next() {
    return this.documents[0] || null;
  }

  async toArray() {
    return this.documents.slice();
  }
}

class InMemoryCollection {
  constructor(documents = []) {
    this.documents = documents.slice();
  }

  createIndex() {
    return Promise.resolve();
  }

  find(query = {}) {
    const filtered = this.documents.filter((document) => {
      for (const [field, value] of Object.entries(query)) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          if (value.$gte && document[field] < value.$gte) {
            return false;
          }
          if (value.$lte && document[field] > value.$lte) {
            return false;
          }
          continue;
        }

        if (document[field] !== value) {
          return false;
        }
      }
      return true;
    });
    return new InMemoryCursor(filtered);
  }

  async insertOne(document) {
    const stored = {
      _id: String(this.documents.length + 1),
      ...document
    };
    this.documents.push(stored);
    return { insertedId: stored._id };
  }
}

test("ML routes accept inference and latest/history responses", async () => {
  const sensorCollection = new InMemoryCollection([
    {
      _id: "sensor-1",
      zone: "zone1",
      timestamp: new Date("2026-04-21T10:54:10.605Z"),
      temperature: 31.8,
      humidity: 68.9,
      lightLux: 62.5,
      dustMgPerM3: 0.12988,
      mq135Raw: 2831,
      mq135AirQualityDeviation: 2.202166
    }
  ]);
  const mlCollection = new InMemoryCollection([]);

  const app = buildApp({
    config: {
      backendModelVersion: "backend-ml-v1",
      mq135BaselineRaw: 2800
    },
    sensorCollection,
    mlCollection,
    hasBuiltFrontend: false,
    frontendDistPath: "",
    inferService: async () => ({
      result: {
        anomalyFlag: true,
        anomalyScore: 0.87,
        anomalyReasons: ["humidity_spike", "gas_proxy_high"],
        warningLevel: "high",
        warningConfidence: 0.91,
        modelVersion: {
          anomaly: "backend-ml-v1",
          warning: "backend-ml-v1"
        }
      }
    }),
    summaryLoader: async () => ({
      anomalyCountToday: 1,
      avgHumidityPredictionError: 0.9,
      currentWarningState: "high"
    })
  });

  const server = app.listen(0);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const inferResponse = await fetch(`${baseUrl}/api/ml/anomaly-warning/infer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timestamp: "2026-04-21T10:54:10.605Z",
        temperature: 31.8,
        humidity: 68.9,
        lightLux: 62.5,
        dustMgPerM3: 0.12988,
        mq135Raw: 2831,
        mq135AirQualityDeviation: 2.202166,
        zone: "zone1"
      })
    });
    assert.equal(inferResponse.status, 200);
    const inferPayload = await inferResponse.json();
    assert.equal(inferPayload.warningLevel, "high");
    assert.equal(inferPayload.anomalyFlag, true);

    const latestResponse = await fetch(`${baseUrl}/api/ml/latest?zone=zone1`);
    assert.equal(latestResponse.status, 200);
    const latestPayload = await latestResponse.json();
    assert.equal(latestPayload.actual.zone, "zone1");
    assert.equal(latestPayload.inference.warningLevel, "high");

    const historyResponse = await fetch(`${baseUrl}/api/ml/history?from=2026-04-21T00:00:00.000Z&to=2026-04-21T23:59:59.000Z&zone=zone1`);
    assert.equal(historyResponse.status, 200);
    const historyPayload = await historyResponse.json();
    assert.equal(historyPayload.series.actualHumidity.length, 1);
    assert.equal(historyPayload.series.warningLevel.length, 1);

    const eventDetailResponse = await fetch(`${baseUrl}/api/ml/event-detail?zone=zone1&timestamp=2026-04-21T10:54:10.605Z`);
    assert.equal(eventDetailResponse.status, 200);
    const eventDetailPayload = await eventDetailResponse.json();
    assert.equal(eventDetailPayload.zone, "zone1");
    assert.equal(eventDetailPayload.source, "stored-ml");
    assert.equal(eventDetailPayload.actualReading.zone, "zone1");
    assert.equal(eventDetailPayload.inference.warningLevel, "high");
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});
