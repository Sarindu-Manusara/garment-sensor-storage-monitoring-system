const {
  formatTimestamp,
  loadLatestMlStatus,
  loadLatestZoneStatus,
  readRecentZoneRows,
  sanitizeZone,
  sortWarningRows
} = require("../utils");

function createLatestStatusTools(context) {
  const { config, sensorCollection, mlCollection } = context;

  return [
    {
      name: "get_latest_zone_status",
      description: "Return the latest live sensor reading for a zone.",
      parameters: {
        type: "object",
        properties: {
          zone: { type: "string" }
        },
        required: ["zone"]
      },
      async execute(args = {}) {
        const zone = sanitizeZone(args.zone, config.zone);
        const latest = await loadLatestZoneStatus({ sensorCollection, zone });
        if (!latest) {
          return {
            zone,
            found: false,
            message: `No live sensor reading is available for ${zone}.`
          };
        }

        return {
          zone,
          found: true,
          timestamp: latest.timestamp,
          displayTimestamp: formatTimestamp(latest.timestamp),
          temperature: latest.temperature,
          humidity: latest.humidity,
          lightLux: latest.lightLux,
          dustMgPerM3: latest.dustMgPerM3,
          mq135Raw: latest.mq135Raw,
          mq135AirQualityDeviation: latest.mq135AirQualityDeviation
        };
      }
    },
    {
      name: "get_latest_all_zones",
      description: "Return the latest live and ML status for every zone.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      },
      async execute() {
        const zones = await readRecentZoneRows(sensorCollection);
        const rows = [];
        for (const zoneRow of zones) {
          const mlStatus = await loadLatestMlStatus({
            config,
            sensorCollection,
            mlCollection,
            zone: zoneRow.zone,
            allowLiveInference: true
          });
          rows.push({
            zone: zoneRow.zone,
            timestamp: zoneRow.timestamp,
            humidity: zoneRow.humidity,
            temperature: zoneRow.temperature,
            dustMgPerM3: zoneRow.dustMgPerM3,
            mq135AirQualityDeviation: zoneRow.mq135AirQualityDeviation,
            warningLevel: mlStatus.data?.warningLevel || "unknown",
            warningConfidence: mlStatus.data?.warningConfidence ?? null,
            anomalyFlag: mlStatus.data?.anomalyFlag ?? false,
            anomalyScore: mlStatus.data?.anomalyScore ?? null
          });
        }

        const sortedRows = sortWarningRows(rows);
        return {
          rows: sortedRows,
          highestWarningZone: sortedRows[0] || null,
          tableData: sortedRows,
          tableMeta: {
            columns: ["zone", "humidity", "temperature", "warningLevel", "anomalyFlag", "anomalyScore"]
          }
        };
      }
    }
  ];
}

module.exports = {
  createLatestStatusTools
};

