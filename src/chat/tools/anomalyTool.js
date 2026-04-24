const {
  formatTimestamp,
  getPresetRange,
  loadLatestMlStatus,
  loadLatestZoneStatus,
  sanitizeZone,
  topCounts
} = require("../utils");

function createAnomalyTools(context) {
  const { config, sensorCollection, mlCollection } = context;

  return [
    {
      name: "get_latest_ml_status",
      description: "Return the latest anomaly and warning status for a zone.",
      parameters: {
        type: "object",
        properties: {
          zone: { type: "string" }
        },
        required: ["zone"]
      },
      async execute(args = {}) {
        const zone = sanitizeZone(args.zone, config.zone);
        const latest = await loadLatestMlStatus({
          config,
          sensorCollection,
          mlCollection,
          zone,
          allowLiveInference: true
        });

        return {
          zone,
          source: latest.source,
          found: Boolean(latest.data),
          ...latest.data
        };
      }
    },
    {
      name: "get_anomaly_summary",
      description: "Return anomaly counts and top anomaly reasons for a zone and time range.",
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
        const rows = await mlCollection.find({
          zone,
          timestamp: { $gte: range.from, $lte: range.to },
          anomalyFlag: true
        }).sort({ timestamp: -1, _id: -1 }).toArray();

        const worst = rows
          .filter((row) => Number.isFinite(row.anomalyScore))
          .sort((left, right) => right.anomalyScore - left.anomalyScore)[0];
        const reasons = topCounts(rows.flatMap((row) => row.anomalyReasons || []), 5);

        return {
          zone,
          label: range.label,
          from: range.from,
          to: range.to,
          anomalyCount: rows.length,
          mostCommonReasons: reasons,
          worstAnomalyScore: worst?.anomalyScore ?? null,
          topAnomalies: rows.slice(0, 8).map((row) => ({
            timestamp: row.timestamp,
            displayTimestamp: formatTimestamp(row.timestamp),
            anomalyScore: row.anomalyScore ?? null,
            anomalyReasons: row.anomalyReasons || []
          }))
        };
      }
    },
    {
      name: "explain_current_anomaly",
      description: "Explain the currently active anomaly for a zone using live sensor and ML data.",
      parameters: {
        type: "object",
        properties: {
          zone: { type: "string" }
        },
        required: ["zone"]
      },
      async execute(args = {}) {
        const zone = sanitizeZone(args.zone, config.zone);
        const [latestReading, latestMl] = await Promise.all([
          loadLatestZoneStatus({ sensorCollection, zone }),
          loadLatestMlStatus({
            config,
            sensorCollection,
            mlCollection,
            zone,
            allowLiveInference: true
          })
        ]);

        if (!latestMl.data) {
          return {
            zone,
            found: false,
            explanation: `No anomaly status is available for ${zone}.`
          };
        }

        const reasons = latestMl.data.anomalyReasons || [];
        return {
          zone,
          found: true,
          anomalyFlag: latestMl.data.anomalyFlag,
          anomalyScore: latestMl.data.anomalyScore,
          anomalyReasons: reasons,
          timestamp: latestMl.data.timestamp || latestReading?.timestamp || null,
          explanation: latestMl.data.anomalyFlag
            ? `The current anomaly in ${zone} is driven by ${reasons.length > 0 ? reasons.join(", ") : "an elevated anomaly score"}.`
            : `There is no active anomaly in ${zone} right now.`,
          supportingMetrics: latestReading ? {
            humidity: latestReading.humidity,
            dustMgPerM3: latestReading.dustMgPerM3,
            mq135AirQualityDeviation: latestReading.mq135AirQualityDeviation
          } : null
        };
      }
    }
  ];
}

module.exports = {
  createAnomalyTools
};

