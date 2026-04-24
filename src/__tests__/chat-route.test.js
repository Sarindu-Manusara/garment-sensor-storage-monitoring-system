const test = require("node:test");
const assert = require("node:assert/strict");

const { createChatService } = require("../chat/chatService");
const { buildApp } = require("../server");
const { InMemoryCollection } = require("./helpers/inMemoryMongo");

function buildConfig() {
  return {
    zone: "zone1",
    backendModelVersion: "backend-ml-v1",
    riskThresholds: {
      humidity: { medium: 60, high: 70 },
      dust: { medium: 0.03, high: 0.045 },
      gas: { medium: 0.75, high: 1.5 }
    },
    chatLlmProvider: "local",
    chatLlmTimeoutMs: 5000
  };
}

function buildCollections() {
  return {
    sensorCollection: new InMemoryCollection([
      {
        _id: "sensor-yesterday",
        zone: "zone1",
        timestamp: new Date("2026-04-20T09:00:00.000Z"),
        temperature: 29.5,
        humidity: 61.2,
        lightLux: 52,
        dustMgPerM3: 0.041,
        mq135Raw: 2812,
        mq135AirQualityDeviation: 0.65
      },
      {
        _id: "sensor-today-1",
        zone: "zone1",
        timestamp: new Date("2026-04-21T09:00:00.000Z"),
        temperature: 30.2,
        humidity: 68.3,
        lightLux: 55,
        dustMgPerM3: 0.071,
        mq135Raw: 2842,
        mq135AirQualityDeviation: 1.2
      },
      {
        _id: "sensor-today-2",
        zone: "zone1",
        timestamp: new Date("2026-04-21T14:10:00.000Z"),
        temperature: 31.4,
        humidity: 74.1,
        lightLux: 63,
        dustMgPerM3: 0.109,
        mq135Raw: 2875,
        mq135AirQualityDeviation: 1.86
      },
      {
        _id: "sensor-zone2",
        zone: "zone2",
        timestamp: new Date("2026-04-21T14:05:00.000Z"),
        temperature: 27.2,
        humidity: 58.9,
        lightLux: 48,
        dustMgPerM3: 0.021,
        mq135Raw: 2790,
        mq135AirQualityDeviation: 0.22
      }
    ]),
    mlCollection: new InMemoryCollection([
      {
        _id: "ml-zone1",
        zone: "zone1",
        timestamp: new Date("2026-04-21T14:10:00.000Z"),
        actualHumidity: 74.1,
        predictedHumidity: 72.8,
        anomalyFlag: true,
        anomalyScore: 0.92,
        anomalyReasons: ["humidity_spike", "gas_proxy_high"],
        warningLevel: "high",
        warningConfidence: 0.93,
        tinymlModelVersion: "tinyml-humidity-v1",
        backendModelVersion: "backend-ml-v1"
      },
      {
        _id: "ml-zone2",
        zone: "zone2",
        timestamp: new Date("2026-04-21T14:05:00.000Z"),
        actualHumidity: 58.9,
        predictedHumidity: 59.4,
        anomalyFlag: false,
        anomalyScore: 0.14,
        anomalyReasons: [],
        warningLevel: "low",
        warningConfidence: 0.82,
        tinymlModelVersion: "tinyml-humidity-v1",
        backendModelVersion: "backend-ml-v1"
      }
    ]),
    chatCollection: new InMemoryCollection([])
  };
}

test("chat routes return grounded answers, history, and clear conversation", async () => {
  const config = buildConfig();
  const { sensorCollection, mlCollection, chatCollection } = buildCollections();
  const chatService = createChatService({
    config,
    sensorCollection,
    mlCollection,
    chatCollection
  });

  const app = buildApp({
    config,
    sensorCollection,
    mlCollection,
    chatService,
    hasBuiltFrontend: false,
    frontendDistPath: ""
  });

  const server = app.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const firstResponse = await fetch(`${baseUrl}/api/chat/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Why is zone1 warning level high?",
        zone: "zone1"
      })
    });
    assert.equal(firstResponse.status, 200);
    const firstPayload = await firstResponse.json();
    assert.ok(firstPayload.conversationId);
    assert.match(firstPayload.answer, /zone1 is high/i);
    assert.equal(firstPayload.toolCalls[0].name, "explain_current_warning");

    const secondResponse = await fetch(`${baseUrl}/api/chat/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Show humidity trend for last 7 days",
        zone: "zone1",
        conversationId: firstPayload.conversationId
      })
    });
    assert.equal(secondResponse.status, 200);
    const secondPayload = await secondResponse.json();
    assert.equal(secondPayload.chartMeta.type, "line");
    assert.ok(secondPayload.chartData.length >= 1);

    const guidanceResponse = await fetch(`${baseUrl}/api/chat/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Guide me through the dashboard for anomaly investigation",
        zone: "zone1",
        conversationId: firstPayload.conversationId
      })
    });
    assert.equal(guidanceResponse.status, 200);
    const guidancePayload = await guidanceResponse.json();
    assert.equal(guidancePayload.toolCalls[0].name, "get_dashboard_guidance");
    assert.ok(guidancePayload.tableData.length >= 3);

    const historyResponse = await fetch(`${baseUrl}/api/chat/history?conversationId=${firstPayload.conversationId}`);
    assert.equal(historyResponse.status, 200);
    const historyPayload = await historyResponse.json();
    assert.equal(historyPayload.messages.length, 6);

    const clearResponse = await fetch(`${baseUrl}/api/chat/history?conversationId=${firstPayload.conversationId}`, {
      method: "DELETE"
    });
    assert.equal(clearResponse.status, 200);
    const clearPayload = await clearResponse.json();
    assert.equal(clearPayload.cleared, true);
    assert.equal(clearPayload.deletedCount, 6);
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
