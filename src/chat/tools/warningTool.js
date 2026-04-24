const {
  average,
  getPresetRange,
  loadLatestMlStatus,
  loadLatestZoneStatus,
  numberToWarningLevel,
  sanitizeZone,
  topCounts,
  warningLevelToNumber
} = require("../utils");

function createWarningTools(context) {
  const { config, sensorCollection, mlCollection } = context;

  return [
    {
      name: "get_warning_summary",
      description: "Return warning-level counts and averages for a zone and time range.",
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
          warningLevel: { $exists: true, $ne: null }
        }).sort({ timestamp: 1, _id: 1 }).toArray();

        const numericLevels = rows.map((row) => warningLevelToNumber(row.warningLevel));
        const dominant = topCounts(rows.map((row) => row.warningLevel), 1)[0];

        return {
          zone,
          label: range.label,
          from: range.from,
          to: range.to,
          count: rows.length,
          dominantWarningLevel: dominant?.value || "unknown",
          averageWarningLevelNumeric: average(numericLevels),
          averageWarningLevel: rows.length > 0 ? numberToWarningLevel(average(numericLevels)) : "unknown",
          averageConfidence: average(rows.map((row) => row.warningConfidence)),
          chartData: rows.map((row) => ({
            timestamp: row.timestamp,
            warningLevel: row.warningLevel,
            warningLevelNumeric: warningLevelToNumber(row.warningLevel),
            warningConfidence: row.warningConfidence ?? null
          })),
          chartMeta: {
            type: "line",
            xKey: "timestamp",
            yKeys: ["warningLevelNumeric"]
          }
        };
      }
    },
    {
      name: "explain_current_warning",
      description: "Explain the current warning level for a zone.",
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

        if (!latestReading || !latestMl.data) {
          return {
            zone,
            found: false,
            explanation: `Current warning details are unavailable for ${zone}.`
          };
        }

        const contributors = [];
        if ((latestReading.humidity ?? 0) >= config.riskThresholds.humidity.high) {
          contributors.push({
            metric: "humidity",
            actual: latestReading.humidity,
            threshold: config.riskThresholds.humidity.high,
            severity: "high"
          });
        } else if ((latestReading.humidity ?? 0) >= config.riskThresholds.humidity.medium) {
          contributors.push({
            metric: "humidity",
            actual: latestReading.humidity,
            threshold: config.riskThresholds.humidity.medium,
            severity: "medium"
          });
        }

        if ((latestReading.dustMgPerM3 ?? 0) >= config.riskThresholds.dust.high) {
          contributors.push({
            metric: "dust",
            actual: latestReading.dustMgPerM3,
            threshold: config.riskThresholds.dust.high,
            severity: "high"
          });
        } else if ((latestReading.dustMgPerM3 ?? 0) >= config.riskThresholds.dust.medium) {
          contributors.push({
            metric: "dust",
            actual: latestReading.dustMgPerM3,
            threshold: config.riskThresholds.dust.medium,
            severity: "medium"
          });
        }

        if ((latestReading.mq135AirQualityDeviation ?? 0) >= config.riskThresholds.gas.high) {
          contributors.push({
            metric: "gas deviation",
            actual: latestReading.mq135AirQualityDeviation,
            threshold: config.riskThresholds.gas.high,
            severity: "high"
          });
        } else if ((latestReading.mq135AirQualityDeviation ?? 0) >= config.riskThresholds.gas.medium) {
          contributors.push({
            metric: "gas deviation",
            actual: latestReading.mq135AirQualityDeviation,
            threshold: config.riskThresholds.gas.medium,
            severity: "medium"
          });
        }

        return {
          zone,
          found: true,
          warningLevel: latestMl.data.warningLevel,
          warningConfidence: latestMl.data.warningConfidence,
          healthScore: latestMl.data.healthScore,
          contributors,
          thresholds: config.riskThresholds,
          explanation: contributors.length > 0
            ? `${zone} is ${latestMl.data.warningLevel} because ${contributors.map((item) => `${item.metric} is above the ${item.severity} threshold`).join(" and ")}.`
            : `${zone} is ${latestMl.data.warningLevel} based on the current backend classifier output.`
        };
      }
    }
  ];
}

module.exports = {
  createWarningTools
};

