const {
  fetchMlSeries,
  getPresetRange,
  loadLatestMlDocument,
  sanitizeZone,
  toTinymlSnapshot
} = require("../utils");

function createPredictionTools(context) {
  const { config, mlCollection } = context;

  return [
    {
      name: "get_tinyml_prediction",
      description: "Return the latest TinyML humidity prediction for a zone.",
      parameters: {
        type: "object",
        properties: {
          zone: { type: "string" }
        },
        required: ["zone"]
      },
      async execute(args = {}) {
        const zone = sanitizeZone(args.zone, config.zone);
        const latest = await loadLatestMlDocument(mlCollection, zone, true);
        const snapshot = toTinymlSnapshot(latest);
        return {
          zone,
          found: Boolean(snapshot),
          ...snapshot
        };
      }
    },
    {
      name: "get_prediction_history",
      description: "Return predicted vs actual humidity history for a zone.",
      parameters: {
        type: "object",
        properties: {
          zone: { type: "string" },
          from: { type: "string" },
          to: { type: "string" }
        },
        required: ["zone"]
      },
      async execute(args = {}) {
        const zone = sanitizeZone(args.zone, config.zone);
        const range = (args.from && args.to)
          ? { from: new Date(args.from), to: new Date(args.to), label: "the selected period" }
          : getPresetRange(args.preset || "today");
        const result = await fetchMlSeries({
          mlCollection,
          zone,
          from: range.from,
          to: range.to,
          metrics: ["predictedHumidity", "actualHumidity"]
        });

        return {
          zone,
          from: result.from,
          to: result.to,
          label: range.label,
          chartData: result.points,
          chartMeta: {
            type: "line",
            xKey: "timestamp",
            yKeys: ["actualHumidity", "predictedHumidity"]
          }
        };
      }
    }
  ];
}

module.exports = {
  createPredictionTools
};

