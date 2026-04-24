const test = require("node:test");
const assert = require("node:assert/strict");

const { createChatService } = require("../chat/chatService");
const { createToolRegistry } = require("../chat/toolRegistry");
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
        _id: "sensor-yesterday-1",
        zone: "zone1",
        timestamp: new Date("2026-04-20T08:00:00.000Z"),
        temperature: 29.0,
        humidity: 60.0,
        lightLux: 45,
        dustMgPerM3: 0.03,
        mq135Raw: 2805,
        mq135AirQualityDeviation: 0.41
      },
      {
        _id: "sensor-yesterday-2",
        zone: "zone1",
        timestamp: new Date("2026-04-20T16:00:00.000Z"),
        temperature: 28.8,
        humidity: 62.0,
        lightLux: 51,
        dustMgPerM3: 0.033,
        mq135Raw: 2810,
        mq135AirQualityDeviation: 0.48
      },
      {
        _id: "sensor-today-1",
        zone: "zone1",
        timestamp: new Date("2026-04-21T08:00:00.000Z"),
        temperature: 30.0,
        humidity: 68.0,
        lightLux: 52,
        dustMgPerM3: 0.062,
        mq135Raw: 2840,
        mq135AirQualityDeviation: 1.05
      },
      {
        _id: "sensor-today-2",
        zone: "zone1",
        timestamp: new Date("2026-04-21T15:00:00.000Z"),
        temperature: 31.1,
        humidity: 75.0,
        lightLux: 67,
        dustMgPerM3: 0.12,
        mq135Raw: 2879,
        mq135AirQualityDeviation: 1.94
      }
    ]),
    mlCollection: new InMemoryCollection([
      {
        _id: "ml-today-1",
        zone: "zone1",
        timestamp: new Date("2026-04-20T16:00:00.000Z"),
        actualHumidity: 62.0,
        predictedHumidity: 61.4,
        anomalyFlag: false,
        anomalyScore: 0.18,
        anomalyReasons: [],
        warningLevel: "low",
        warningConfidence: 0.68
      },
      {
        _id: "ml-today-2",
        zone: "zone1",
        timestamp: new Date("2026-04-21T08:00:00.000Z"),
        actualHumidity: 68.0,
        predictedHumidity: 67.3,
        anomalyFlag: false,
        anomalyScore: 0.22,
        anomalyReasons: [],
        warningLevel: "medium",
        warningConfidence: 0.74
      },
      {
        _id: "ml-today-3",
        zone: "zone1",
        timestamp: new Date("2026-04-21T15:00:00.000Z"),
        actualHumidity: 75.0,
        predictedHumidity: 73.6,
        anomalyFlag: true,
        anomalyScore: 0.88,
        anomalyReasons: ["humidity_spike"],
        warningLevel: "high",
        warningConfidence: 0.91
      }
    ]),
    chatCollection: new InMemoryCollection([])
  };
}

test("comparison tool returns clean structured bar-chart data", async () => {
  const config = buildConfig();
  const { sensorCollection, mlCollection } = buildCollections();
  const registry = createToolRegistry({
    config,
    sensorCollection,
    mlCollection
  });

  const result = await registry.executeToolCall({
    name: "compare_metric_between_periods",
    args: {
      zone: "zone1",
      metric: "humidity",
      fromA: "2026-04-21T00:00:00.000Z",
      toA: "2026-04-21T23:59:59.999Z",
      fromB: "2026-04-20T00:00:00.000Z",
      toB: "2026-04-20T23:59:59.999Z"
    }
  });

  assert.equal(result.result.chartMeta.type, "bar");
  assert.equal(result.result.chartData.length, 2);
  assert.ok(result.result.averageA > result.result.averageB);
  assert.match(result.result.interpretation, /higher/i);
});

test("chat service returns chart-ready history for trend questions", async () => {
  const config = buildConfig();
  const { sensorCollection, mlCollection, chatCollection } = buildCollections();
  const chatService = createChatService({
    config,
    sensorCollection,
    mlCollection,
    chatCollection
  });

  const response = await chatService.sendMessage({
    message: "Show humidity trend for last 7 days",
    zone: "zone1"
  });

  assert.equal(response.chartMeta.type, "line");
  assert.ok(response.chartData.length >= 1);
  assert.match(response.answer, /humidity/i);
});

test("dashboard guidance returns structured navigation help", async () => {
  const config = buildConfig();
  const { sensorCollection, mlCollection, chatCollection } = buildCollections();
  const chatService = createChatService({
    config,
    sensorCollection,
    mlCollection,
    chatCollection
  });

  const response = await chatService.sendMessage({
    message: "Guide me through the dashboard for anomaly investigation",
    zone: "zone1"
  });

  assert.equal(response.toolCalls[0].name, "get_dashboard_guidance");
  assert.ok(response.tableData.length >= 3);
  assert.match(response.answer, /Start with ML Insights/i);
});

test("influence analysis returns ranked factor strengths", async () => {
  const config = buildConfig();
  const { sensorCollection, mlCollection } = buildCollections();
  const registry = createToolRegistry({
    config,
    sensorCollection,
    mlCollection
  });

  const result = await registry.executeToolCall({
    name: "analyze_metric_influences",
    args: {
      zone: "zone1",
      target: "warning level",
      from: "2026-04-20T00:00:00.000Z",
      to: "2026-04-21T23:59:59.999Z"
    }
  });

  assert.equal(result.result.chartMeta.type, "bar");
  assert.ok(result.result.pointCount >= 3);
  assert.ok(result.result.topFactors.length >= 1);
  assert.match(result.result.summary, /correlation view/i);
});

test("chat service falls back clearly when live data is missing", async () => {
  const config = buildConfig();
  const chatService = createChatService({
    config,
    sensorCollection: new InMemoryCollection([]),
    mlCollection: new InMemoryCollection([]),
    chatCollection: new InMemoryCollection([])
  });

  const response = await chatService.sendMessage({
    message: "What is the current humidity in zone1?",
    zone: "zone1"
  });

  assert.match(response.answer, /no live sensor reading/i);
  assert.equal(response.chartData, null);
});
