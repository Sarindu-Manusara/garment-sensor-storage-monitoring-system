const {
  METRIC_DEFINITIONS,
  fetchMlSeries,
  fetchSensorSeries,
  formatTimestamp,
  getPresetRange,
  normalizeMetric,
  sanitizeZone,
  summarizeSeries,
  warningLevelToNumber
} = require("../utils");

function buildLineChart(points, metrics) {
  return {
    chartData: points,
    chartMeta: {
      type: "line",
      xKey: "timestamp",
      yKeys: metrics
    }
  };
}

function createHistoryTools(context) {
  const { config, sensorCollection, mlCollection } = context;

  return [
    {
      name: "get_sensor_history",
      description: "Return sensor metric history for a zone and time range.",
      parameters: {
        type: "object",
        properties: {
          zone: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
          metrics: {
            type: "array",
            items: { type: "string" }
          }
        },
        required: ["zone"]
      },
      async execute(args = {}) {
        const zone = sanitizeZone(args.zone, config.zone);
        const range = (args.from && args.to)
          ? { from: new Date(args.from), to: new Date(args.to), label: "the selected period" }
          : getPresetRange(args.preset || "today");
        const metrics = Array.isArray(args.metrics) && args.metrics.length > 0
          ? args.metrics.map((metric) => normalizeMetric(metric))
          : ["humidity"];

        const result = await fetchSensorSeries({
          sensorCollection,
          zone,
          from: range.from,
          to: range.to,
          metrics
        });
        const metricSummaries = {};
        for (const metric of metrics) {
          metricSummaries[metric] = summarizeSeries(result.points, metric);
        }

        return {
          zone,
          from: result.from,
          to: result.to,
          label: range.label,
          metrics,
          metricSummaries,
          ...buildLineChart(result.points, metrics)
        };
      }
    },
    {
      name: "get_ml_history",
      description: "Return ML output history for a zone and time range.",
      parameters: {
        type: "object",
        properties: {
          zone: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
          metrics: {
            type: "array",
            items: { type: "string" }
          }
        },
        required: ["zone"]
      },
      async execute(args = {}) {
        const zone = sanitizeZone(args.zone, config.zone);
        const range = (args.from && args.to)
          ? { from: new Date(args.from), to: new Date(args.to), label: "the selected period" }
          : getPresetRange(args.preset || "today");
        const metrics = Array.isArray(args.metrics) && args.metrics.length > 0
          ? args.metrics.map((metric) => normalizeMetric(metric))
          : ["anomalyScore"];

        const result = await fetchMlSeries({
          mlCollection,
          zone,
          from: range.from,
          to: range.to,
          metrics
        });
        const chartData = result.points.map((point) => ({
          ...point,
          warningLevelNumeric: point.warningLevel ? warningLevelToNumber(point.warningLevel) : undefined
        }));

        return {
          zone,
          from: result.from,
          to: result.to,
          label: range.label,
          metrics,
          metricSummaries: Object.fromEntries(metrics.map((metric) => [metric, summarizeSeries(result.points, metric)])),
          chartData,
          chartMeta: {
            type: "line",
            xKey: "timestamp",
            yKeys: metrics
          },
          latestTimestamp: chartData.length > 0 ? formatTimestamp(chartData[chartData.length - 1].timestamp) : null
        };
      }
    }
  ];
}

module.exports = {
  createHistoryTools
};

