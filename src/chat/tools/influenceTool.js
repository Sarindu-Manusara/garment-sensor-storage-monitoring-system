const { normalizeStoredReading } = require("../../sensorSchema");
const {
  computeHealthScore,
  formatNumber,
  getPresetRange,
  normalizeInfluenceTarget,
  pearsonCorrelation,
  sanitizeZone,
  warningLevelToNumber
} = require("../utils");

const FEATURE_DEFINITIONS = [
  { key: "temperature", label: "temperature", unit: "C" },
  { key: "humidity", label: "humidity", unit: "%" },
  { key: "lightLux", label: "light", unit: "lx" },
  { key: "dustMgPerM3", label: "dust proxy", unit: "mg/m^3" },
  { key: "mq135AirQualityDeviation", label: "gas deviation", unit: "%" }
];

function findClosestSensor(sensorRows, timestamp) {
  if (!sensorRows.length) {
    return null;
  }

  const target = new Date(timestamp).getTime();
  let closest = null;
  let smallestDelta = Number.POSITIVE_INFINITY;

  for (const row of sensorRows) {
    const delta = Math.abs(new Date(row.timestamp).getTime() - target);
    if (delta < smallestDelta) {
      smallestDelta = delta;
      closest = row;
    }
  }

  return closest;
}

function buildMergedRows(sensorRows, mlRows, config) {
  return mlRows.map((mlRow) => {
    const sensor = findClosestSensor(sensorRows, mlRow.timestamp);
    const actualHumidity = Number.isFinite(mlRow.actualHumidity) ? mlRow.actualHumidity : sensor?.humidity ?? null;
    const predictionError = Number.isFinite(mlRow.predictedHumidity) && Number.isFinite(actualHumidity)
      ? Math.abs(mlRow.predictedHumidity - actualHumidity)
      : null;
    const mlStatus = {
      warningLevel: mlRow.warningLevel,
      anomalyFlag: mlRow.anomalyFlag,
      anomalyScore: mlRow.anomalyScore
    };

    return {
      timestamp: mlRow.timestamp,
      temperature: sensor?.temperature ?? null,
      humidity: sensor?.humidity ?? actualHumidity,
      lightLux: sensor?.lightLux ?? null,
      dustMgPerM3: sensor?.dustMgPerM3 ?? null,
      mq135AirQualityDeviation: sensor?.mq135AirQualityDeviation ?? null,
      predictedHumidity: mlRow.predictedHumidity ?? null,
      actualHumidity,
      anomalyScore: mlRow.anomalyScore ?? null,
      warningLevel: mlRow.warningLevel ?? null,
      warningLevelNumeric: warningLevelToNumber(mlRow.warningLevel),
      warningConfidence: mlRow.warningConfidence ?? null,
      predictionError,
      healthScore: computeHealthScore({
        actual: sensor,
        mlStatus,
        thresholds: config.riskThresholds
      })
    };
  });
}

function selectObservations(target, sensorRows, mergedRows) {
  if (target === "humidity") {
    return sensorRows.map((row) => ({
      timestamp: row.timestamp,
      targetValue: row.humidity,
      temperature: row.temperature,
      lightLux: row.lightLux,
      dustMgPerM3: row.dustMgPerM3,
      mq135AirQualityDeviation: row.mq135AirQualityDeviation
    }));
  }

  return mergedRows.map((row) => {
    let targetValue = null;
    if (target === "warningLevel") {
      targetValue = row.warningLevelNumeric;
    } else if (target === "anomalyScore") {
      targetValue = row.anomalyScore;
    } else if (target === "predictedHumidity") {
      targetValue = row.predictedHumidity;
    } else if (target === "predictionError") {
      targetValue = row.predictionError;
    } else if (target === "healthScore") {
      targetValue = row.healthScore;
    }

    return {
      timestamp: row.timestamp,
      targetValue,
      temperature: row.temperature,
      humidity: row.humidity,
      lightLux: row.lightLux,
      dustMgPerM3: row.dustMgPerM3,
      mq135AirQualityDeviation: row.mq135AirQualityDeviation
    };
  });
}

function getTargetLabel(target) {
  if (target === "warningLevel") {
    return "warning level";
  }
  if (target === "anomalyScore") {
    return "anomaly score";
  }
  if (target === "predictedHumidity") {
    return "predicted humidity";
  }
  if (target === "predictionError") {
    return "prediction error";
  }
  if (target === "healthScore") {
    return "health score";
  }
  return "humidity";
}

function analyzeFactors(observations, target) {
  const validRows = observations.filter((row) => Number.isFinite(row.targetValue));
  if (validRows.length < 3) {
    return {
      pointCount: validRows.length,
      topFactors: []
    };
  }

  const features = FEATURE_DEFINITIONS.filter((feature) => !(target === "humidity" && feature.key === "humidity"));
  const targetValues = validRows.map((row) => row.targetValue);

  const topFactors = features
    .map((feature) => {
      const correlation = pearsonCorrelation(
        validRows.map((row) => row[feature.key]),
        targetValues
      );
      if (!Number.isFinite(correlation)) {
        return null;
      }

      return {
        factor: feature.key,
        label: feature.label,
        unit: feature.unit,
        correlation: Number(correlation.toFixed(4)),
        strength: Number(Math.abs(correlation).toFixed(4)),
        direction: correlation >= 0 ? "positive" : "negative",
        interpretation: `${feature.label} moved ${correlation >= 0 ? "with" : "against"} the target in this range.`
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.strength - left.strength)
    .slice(0, 4);

  return {
    pointCount: validRows.length,
    topFactors
  };
}

function buildInfluenceSummary(zone, label, targetLabel, topFactors, pointCount) {
  if (!topFactors.length) {
    return `There is not enough matched live history to estimate which factors tracked ${targetLabel} in ${zone} for ${label}.`;
  }

  const factorText = topFactors
    .slice(0, 2)
    .map((factor) => `${factor.label} (${factor.direction}, strength ${formatNumber(factor.strength, 2)})`)
    .join(" and ");

  return `Across ${pointCount} matched records in ${zone} for ${label}, ${factorText} tracked ${targetLabel} most strongly. This is a correlation view, not a causal model.`;
}

function createInfluenceTools(context) {
  const { config, sensorCollection, mlCollection } = context;

  return [
    {
      name: "analyze_metric_influences",
      description: "Estimate which live sensor factors track a target metric or model output most strongly.",
      parameters: {
        type: "object",
        properties: {
          zone: { type: "string" },
          target: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
          preset: { type: "string" }
        },
        required: ["zone", "target"]
      },
      async execute(args = {}) {
        const zone = sanitizeZone(args.zone, config.zone);
        const target = normalizeInfluenceTarget(args.target, "warningLevel");
        const range = (args.from && args.to)
          ? { from: new Date(args.from), to: new Date(args.to), label: "the selected period" }
          : getPresetRange(args.preset || "today");

        const [sensorRows, mlRows] = await Promise.all([
          sensorCollection.find({
            zone,
            timestamp: { $gte: range.from, $lte: range.to }
          }).sort({ timestamp: 1, _id: 1 }).toArray(),
          mlCollection.find({
            zone,
            timestamp: { $gte: range.from, $lte: range.to }
          }).sort({ timestamp: 1, _id: 1 }).toArray()
        ]);

        const normalizedSensors = sensorRows.map((row) => normalizeStoredReading(row));
        const mergedRows = buildMergedRows(normalizedSensors, mlRows, config);
        const observations = selectObservations(target, normalizedSensors, mergedRows);
        const analysis = analyzeFactors(observations, target);
        const targetLabel = getTargetLabel(target);

        return {
          zone,
          target,
          targetLabel,
          label: range.label,
          pointCount: analysis.pointCount,
          topFactors: analysis.topFactors,
          summary: buildInfluenceSummary(zone, range.label, targetLabel, analysis.topFactors, analysis.pointCount),
          chartData: analysis.topFactors.map((factor) => ({
            factor: factor.label,
            strength: factor.strength
          })),
          chartMeta: {
            type: "bar",
            xKey: "factor",
            yKeys: ["strength"]
          },
          tableData: analysis.topFactors.map((factor) => ({
            factor: factor.label,
            direction: factor.direction,
            strength: factor.strength,
            interpretation: factor.interpretation
          })),
          tableMeta: {
            columns: ["factor", "direction", "strength", "interpretation"]
          }
        };
      }
    }
  ];
}

module.exports = {
  createInfluenceTools
};
