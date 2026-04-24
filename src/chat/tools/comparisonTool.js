const {
  average,
  buildComparisonInterpretation,
  fetchMlSeries,
  fetchSensorSeries,
  normalizeMetric,
  sanitizeZone
} = require("../utils");

function createComparisonTools(context) {
  const { config, sensorCollection, mlCollection } = context;

  return [
    {
      name: "compare_metric_between_periods",
      description: "Compare a metric across two time ranges for a zone.",
      parameters: {
        type: "object",
        properties: {
          zone: { type: "string" },
          metric: { type: "string" },
          fromA: { type: "string" },
          toA: { type: "string" },
          fromB: { type: "string" },
          toB: { type: "string" }
        },
        required: ["zone", "metric", "fromA", "toA", "fromB", "toB"]
      },
      async execute(args = {}) {
        const zone = sanitizeZone(args.zone, config.zone);
        const metric = normalizeMetric(args.metric);
        const collection = metric === "predictedHumidity" || metric === "actualHumidity" || metric === "anomalyScore" || metric === "warningConfidence"
          ? "ml"
          : "sensor";

        const fetcher = collection === "ml" ? fetchMlSeries : fetchSensorSeries;
        const first = await fetcher({
          [collection === "ml" ? "mlCollection" : "sensorCollection"]: collection === "ml" ? mlCollection : sensorCollection,
          zone,
          from: new Date(args.fromA),
          to: new Date(args.toA),
          metrics: [metric]
        });
        const second = await fetcher({
          [collection === "ml" ? "mlCollection" : "sensorCollection"]: collection === "ml" ? mlCollection : sensorCollection,
          zone,
          from: new Date(args.fromB),
          to: new Date(args.toB),
          metrics: [metric]
        });

        const averageA = average(first.points.map((point) => point[metric]));
        const averageB = average(second.points.map((point) => point[metric]));
        const difference = Number.isFinite(averageA) && Number.isFinite(averageB) ? averageA - averageB : null;
        const percentageChange = Number.isFinite(difference) && Number.isFinite(averageB) && averageB !== 0
          ? (difference / averageB) * 100
          : null;

        return {
          zone,
          metric,
          averageA,
          averageB,
          difference,
          percentageChange,
          interpretation: buildComparisonInterpretation(metric, difference, percentageChange),
          chartData: [
            { period: "A", average: averageA },
            { period: "B", average: averageB }
          ],
          chartMeta: {
            type: "bar",
            xKey: "period",
            yKeys: ["average"]
          }
        };
      }
    }
  ];
}

module.exports = {
  createComparisonTools
};

