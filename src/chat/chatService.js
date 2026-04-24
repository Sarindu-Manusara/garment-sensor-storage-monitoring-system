const { randomUUID } = require("node:crypto");

const { createLlmProvider } = require("./llmProvider");
const { buildSystemPrompt } = require("./prompts/systemPrompt");
const { createToolRegistry } = require("./toolRegistry");
const {
  detectInfluenceTargetFromText,
  detectMetricFromText,
  detectRangePresetFromText,
  detectZoneFromText,
  formatNumber,
  formatTimestamp,
  getPresetRange,
  sanitizeZone
} = require("./utils");

const HISTORY_LIMIT = 12;

function createChatService({
  config,
  sensorCollection,
  mlCollection,
  chatCollection,
  logger = console,
  llmProvider = createLlmProvider(config, logger),
  toolRegistry = createToolRegistry({ config, sensorCollection, mlCollection })
}) {
  async function loadConversation(conversationId, limit = HISTORY_LIMIT) {
    if (!chatCollection || !conversationId) {
      return [];
    }

    const rows = await chatCollection
      .find({ conversationId })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .toArray();

    return rows.reverse();
  }

  async function persistMessage(document) {
    if (!chatCollection) {
      return;
    }

    await chatCollection.insertOne({
      ...document,
      createdAt: document.createdAt || new Date()
    });
  }

  function deriveContext(message, zone, history) {
    const lastAssistantContext = [...history]
      .reverse()
      .find((row) => row.role === "assistant" && row.metadata?.context)?.metadata?.context || {};
    const lastZone = [...history].reverse().find((row) => row.zone)?.zone;

    const resolvedZone = sanitizeZone(
      zone || detectZoneFromText(message, lastAssistantContext.zone || lastZone || config.zone)
    );
    const resolvedMetric = detectMetricFromText(message, lastAssistantContext.metric || "humidity");
    const resolvedPreset = detectRangePresetFromText(message, lastAssistantContext.preset || null);

    return {
      zone: resolvedZone,
      metric: resolvedMetric,
      preset: resolvedPreset,
      lastAssistantContext
    };
  }

  function resolveComparisonRanges(message) {
    const normalized = String(message || "").toLowerCase();
    if (normalized.includes("this week") && normalized.includes("last week")) {
      return {
        presetA: "this week",
        presetB: "last week"
      };
    }

    if (normalized.includes("last 24 hours")) {
      return {
        presetA: "last 24 hours",
        presetB: "yesterday"
      };
    }

    return {
      presetA: "today",
      presetB: "yesterday"
    };
  }

  function buildToolPlan(message, context) {
    const normalized = String(message || "").toLowerCase();
    const intentFlags = {
      wantsAllZones: /(which zone|highest warning|all zones|all zone|overall zones)/.test(normalized),
      wantsComparison: /\bcompare\b|\bvs\b|\bversus\b|difference/.test(normalized),
      wantsGuidance: /\bguide\b|dashboard|where should i start|how do i use|how do i explore|what should i look at|how should i investigate|navigate/.test(normalized),
      wantsInfluence: /\bfactor\b|\bfactors\b|influence|affect|affects|drivers|drives|contributes most|impact most/.test(normalized),
      wantsPrediction: /tinyml|predicted humidity|prediction/.test(normalized),
      wantsAnomaly: /anomaly|anomalies|anomaly score/.test(normalized),
      wantsWarning: /warning level|warning\b/.test(normalized),
      wantsHistory: /trend|history|over time|today|yesterday|this week|last week|last 24 hours|this afternoon|this morning|last 7 days|last 30 days|maximum|max\b|average|timeline/.test(normalized),
      wantsExplain: /\bwhy\b|what does|how does|explain|mean\b/.test(normalized),
      wantsThresholds: /threshold|safe range|safe humidity|safe level|health score|mq135airqualitydeviation/.test(normalized)
    };

    if (intentFlags.wantsAllZones) {
      return {
        intent: "all-zones-status",
        toolCalls: [{ name: "get_latest_all_zones", args: {} }]
      };
    }

    if (intentFlags.wantsComparison) {
      const { presetA, presetB } = resolveComparisonRanges(message);
      const rangeA = getPresetRange(presetA);
      const rangeB = getPresetRange(presetB);
      return {
        intent: "comparison",
        toolCalls: [
          {
            name: "compare_metric_between_periods",
            args: {
              zone: context.zone,
              metric: context.metric,
              fromA: rangeA.from.toISOString(),
              toA: rangeA.to.toISOString(),
              fromB: rangeB.from.toISOString(),
              toB: rangeB.to.toISOString()
            }
          }
        ],
        context: {
          preset: presetA,
          comparisonPreset: presetB
        }
      };
    }

    if (intentFlags.wantsInfluence) {
      return {
        intent: "factor-analysis",
        toolCalls: [
          {
            name: "analyze_metric_influences",
            args: {
              zone: context.zone,
              target: detectInfluenceTargetFromText(message, "warningLevel"),
              preset: context.preset || "last 7 days"
            }
          }
        ]
      };
    }

    if (intentFlags.wantsGuidance) {
      return {
        intent: "dashboard-guidance",
        toolCalls: [
          {
            name: "get_dashboard_guidance",
            args: {
              zone: context.zone,
              topic: message
            }
          }
        ]
      };
    }

    if (intentFlags.wantsExplain && intentFlags.wantsWarning) {
      return {
        intent: "explain-warning",
        toolCalls: [{ name: "explain_current_warning", args: { zone: context.zone } }]
      };
    }

    if (intentFlags.wantsExplain && intentFlags.wantsAnomaly) {
      return {
        intent: "explain-anomaly",
        toolCalls: [{ name: "explain_current_anomaly", args: { zone: context.zone } }]
      };
    }

    if (intentFlags.wantsPrediction && intentFlags.wantsHistory) {
      return {
        intent: "prediction-history",
        toolCalls: [{ name: "get_prediction_history", args: { zone: context.zone, preset: context.preset || "today" } }]
      };
    }

    if (intentFlags.wantsPrediction && intentFlags.wantsExplain) {
      return {
        intent: "tinyml-explanation",
        toolCalls: [{ name: "get_threshold_config", args: {} }]
      };
    }

    if (intentFlags.wantsAnomaly && /how many|count|summary|today|yesterday|this week|last week|last 24 hours/.test(normalized)) {
      return {
        intent: "anomaly-summary",
        toolCalls: [{ name: "get_anomaly_summary", args: { zone: context.zone, preset: context.preset || "today" } }]
      };
    }

    if (intentFlags.wantsWarning && /average|today|yesterday|this week|last week|this afternoon|timeline|history/.test(normalized)) {
      return {
        intent: "warning-summary",
        toolCalls: [{ name: "get_warning_summary", args: { zone: context.zone, preset: context.preset || "today" } }]
      };
    }

    if (intentFlags.wantsThresholds || intentFlags.wantsExplain) {
      return {
        intent: "docs-thresholds",
        toolCalls: [
          { name: "get_threshold_config", args: {} },
          { name: "search_docs", args: { query: message } }
        ]
      };
    }

    if (intentFlags.wantsHistory) {
      const toolName = context.metric === "predictedHumidity" || context.metric === "actualHumidity" || context.metric === "anomalyScore" || context.metric === "warningConfidence"
        ? "get_ml_history"
        : "get_sensor_history";
      return {
        intent: "history",
        toolCalls: [{ name: toolName, args: { zone: context.zone, preset: context.preset || "today", metrics: [context.metric] } }]
      };
    }

    if (intentFlags.wantsPrediction) {
      return {
        intent: "latest-prediction",
        toolCalls: [{ name: "get_tinyml_prediction", args: { zone: context.zone } }]
      };
    }

    if (intentFlags.wantsAnomaly || intentFlags.wantsWarning) {
      return {
        intent: "latest-ml-status",
        toolCalls: [{ name: "get_latest_ml_status", args: { zone: context.zone } }]
      };
    }

    if (/air quality|gas/.test(normalized)) {
      return {
        intent: "air-quality-status",
        toolCalls: [
          { name: "get_latest_zone_status", args: { zone: context.zone } },
          { name: "get_latest_ml_status", args: { zone: context.zone } }
        ]
      };
    }

    return {
      intent: "latest-zone-status",
      toolCalls: [{ name: "get_latest_zone_status", args: { zone: context.zone } }]
    };
  }

  function findToolResult(executions, name) {
    return executions.find((entry) => entry.name === name)?.result || null;
  }

  function buildSuggestedQuestions(intent, zone, metric) {
    const normalizedMetric = metric === "mq135AirQualityDeviation" ? "air quality" : metric.replace(/([A-Z])/g, " $1").toLowerCase();
    switch (intent) {
      case "latest-zone-status":
      case "air-quality-status":
      case "latest-ml-status":
        return [
          `Show ${zone} ${normalizedMetric} trend for today`,
          `Explain the current warning for ${zone}`,
          `Compare ${zone} ${normalizedMetric} with yesterday`
        ];
      case "history":
      case "comparison":
        return [
          `How many anomalies happened in ${zone} today?`,
          `Explain the current warning for ${zone}`,
          `Show predicted vs actual humidity for ${zone}`
        ];
      case "dashboard-guidance":
        return [
          `What is the current warning level in ${zone}?`,
          `Show humidity trend for ${zone} today`,
          `What factors influence warning level the most in ${zone}?`
        ];
      case "factor-analysis":
        return [
          `Guide me through investigating ${zone} on the dashboard`,
          `Show anomaly score history for ${zone} today`,
          `Explain the current warning for ${zone}`
        ];
      case "anomaly-summary":
      case "explain-anomaly":
        return [
          `What is the latest warning level in ${zone}?`,
          `Show anomaly score history for ${zone} today`,
          `What does the anomaly pipeline use?`
        ];
      case "warning-summary":
      case "explain-warning":
        return [
          `Show humidity trend for ${zone} today`,
          `Was a TinyML prediction uploaded for ${zone}?`,
          "What is the safe humidity threshold?"
        ];
      case "latest-prediction":
      case "prediction-history":
      case "tinyml-explanation":
        return [
          `Show predicted vs actual humidity for ${zone} today`,
          `What is the current humidity in ${zone}?`,
          "How does the TinyML humidity prediction work?"
        ];
      default:
        return [
          `What is the current humidity in ${zone}?`,
          `How many anomalies happened in ${zone} today?`,
          "What does mq135AirQualityDeviation mean?"
        ];
    }
  }

  function answerForHistory(message, result, metric) {
    if (!result || !result.metricSummaries?.[metric]) {
      return "Historical data is unavailable for that request.";
    }

    const summary = result.metricSummaries[metric];
    const label = metric === "mq135AirQualityDeviation" ? "gas deviation" : metric.replace(/([A-Z])/g, " $1").toLowerCase();
    const unit = metric === "lightLux"
      ? " lx"
      : metric === "dustMgPerM3"
        ? " mg/m^3"
        : metric.includes("humidity") || metric.includes("Deviation")
          ? "%"
          : "";
    const normalized = String(message || "").toLowerCase();

    if (summary.count === 0) {
      return `No ${label} data is available for ${result.zone} in ${result.label}.`;
    }

    if (/\bmax\b|maximum|peak/.test(normalized)) {
      return `The maximum ${label} in ${result.zone} during ${result.label} was ${formatNumber(summary.max, 2)}${unit}.`;
    }

    if (/\baverage\b|mean/.test(normalized)) {
      return `The average ${label} in ${result.zone} during ${result.label} was ${formatNumber(summary.average, 2)}${unit}.`;
    }

    return `${result.zone} ${label} ranged from ${formatNumber(summary.min, 2)}${unit} to ${formatNumber(summary.max, 2)}${unit} during ${result.label}, with a latest value of ${formatNumber(summary.latest, 2)}${unit}.`;
  }

  function answerForMlHistory(result, metric) {
    if (!result?.metricSummaries?.[metric]) {
      return "ML history is unavailable for that request.";
    }

    const summary = result.metricSummaries[metric];
    if (summary.count === 0) {
      return `No ${metric} history is available for ${result.zone} in ${result.label}.`;
    }

    if (metric === "anomalyScore") {
      return `${result.zone} anomaly score ranged from ${formatNumber(summary.min, 2)} to ${formatNumber(summary.max, 2)} in ${result.label}, with the latest point recorded at ${result.latestTimestamp || "an unknown time"}.`;
    }

    return `${result.zone} ${metric.replace(/([A-Z])/g, " $1").toLowerCase()} history is available for ${result.label}.`;
  }

  function composeDraftAnswer({ message, plan, toolExecutions, context }) {
    const primary = toolExecutions[0]?.result;
    const latestStatus = findToolResult(toolExecutions, "get_latest_zone_status");
    const latestMl = findToolResult(toolExecutions, "get_latest_ml_status");
    const thresholdConfig = findToolResult(toolExecutions, "get_threshold_config");
    const docResults = findToolResult(toolExecutions, "search_docs");

    switch (plan.intent) {
      case "all-zones-status": {
        if (!primary?.highestWarningZone) {
          return "No zone status data is available yet.";
        }
        const highest = primary.highestWarningZone;
        return `${highest.zone} currently has the highest warning level at ${String(highest.warningLevel || "unknown").toUpperCase()} with anomaly score ${formatNumber(highest.anomalyScore, 2)}.`;
      }
      case "dashboard-guidance":
        if (!primary?.steps?.length) {
          return `I could not build a dashboard guidance path for ${context.zone}.`;
        }
        return `${primary.summary} Start with ${primary.steps[0].section}, then move to ${primary.steps[1]?.section || "the next linked section"} to continue the investigation.`;
      case "factor-analysis":
        if (!primary?.topFactors?.length) {
          return primary?.summary || `There is not enough matched history to estimate the strongest drivers for ${context.zone}.`;
        }
        return `${primary.summary} The strongest factor in this window was ${primary.topFactors[0].label}, followed by ${primary.topFactors[1]?.label || "the next available signal"}.`;
      case "comparison":
        if (!primary) {
          return "I could not compare those periods because the metric data is unavailable.";
        }
        return `${primary.zone} ${primary.interpretation}`;
      case "explain-warning":
        return primary?.explanation || `Current warning details are unavailable for ${context.zone}.`;
      case "explain-anomaly":
        return primary?.explanation || `Current anomaly details are unavailable for ${context.zone}.`;
      case "prediction-history": {
        const points = primary?.chartData || [];
        if (points.length === 0) {
          return `No TinyML prediction history is available for ${context.zone} in ${primary?.label || "that range"}.`;
        }
        return `${context.zone} has ${points.length} predicted-versus-actual humidity points for ${primary.label}. The chart shows how closely the ESP32 prediction tracked the actual humidity.`;
      }
      case "tinyml-explanation":
        return thresholdConfig?.explanations?.tinymlPrediction || "TinyML prediction details are unavailable.";
      case "anomaly-summary":
        if (!primary) {
          return `No anomaly summary is available for ${context.zone}.`;
        }
        return `${primary.anomalyCount} anomalies were recorded for ${context.zone} in ${primary.label}. The worst anomaly score was ${formatNumber(primary.worstAnomalyScore, 2)}${primary.mostCommonReasons?.length ? `, most often driven by ${primary.mostCommonReasons.map((item) => item.value).join(", ")}.` : "."}`;
      case "warning-summary":
        if (!primary) {
          return `No warning summary is available for ${context.zone}.`;
        }
        return `The average warning level in ${context.zone} during ${primary.label} was ${String(primary.averageWarningLevel || "unknown").toUpperCase()}, with dominant level ${String(primary.dominantWarningLevel || "unknown").toUpperCase()} and average confidence ${formatNumber((primary.averageConfidence || 0) * 100, 0)}%.`;
      case "history":
        if (toolExecutions[0]?.name === "get_ml_history") {
          return answerForMlHistory(primary, context.metric);
        }
        return answerForHistory(message, primary, context.metric);
      case "latest-prediction":
        if (!primary?.found) {
          return `No TinyML humidity prediction has been uploaded yet for ${context.zone}.`;
        }
        return `The latest TinyML prediction for ${context.zone} is ${formatNumber(primary.predictedHumidity, 1)}% humidity, compared with an actual humidity of ${formatNumber(primary.actualHumidity, 1)}% at ${formatTimestamp(primary.timestamp)}.`;
      case "docs-thresholds": {
        if (/safe humidity|humidity threshold/.test(String(message).toLowerCase())) {
          return `The configured humidity warning thresholds are ${thresholdConfig?.thresholds?.humidity?.medium ?? "unavailable"}% for medium and ${thresholdConfig?.thresholds?.humidity?.high ?? "unavailable"}% for high.`;
        }
        if (/mq135airqualitydeviation|mq135|air quality/.test(String(message).toLowerCase())) {
          return thresholdConfig?.explanations?.mq135AirQualityDeviation || "MQ135 air-quality deviation details are unavailable.";
        }
        if (/health score/.test(String(message).toLowerCase())) {
          return thresholdConfig?.explanations?.healthScore || "Health score details are unavailable.";
        }
        if (docResults?.results?.length) {
          const top = docResults.results[0];
          return `The closest local documentation match comes from ${top.filePath}: ${top.snippet}`;
        }
        return "I could not find matching documentation for that question in the local project files.";
      }
      case "latest-ml-status":
        if (!primary?.found) {
          return `No backend ML status is available for ${context.zone}.`;
        }
        if (primary.anomalyFlag) {
          return `Yes. ${context.zone} currently has an anomaly with score ${formatNumber(primary.anomalyScore, 2)} and reasons ${primary.anomalyReasons?.join(", ") || "not specified"}. The warning level is ${String(primary.warningLevel || "unknown").toUpperCase()}.`;
        }
        return `There is no active anomaly in ${context.zone} right now. The latest warning level is ${String(primary.warningLevel || "unknown").toUpperCase()} with ${formatNumber((primary.warningConfidence || 0) * 100, 0)}% confidence.`;
      case "air-quality-status":
        if (!latestStatus) {
          return `No live air-quality reading is available for ${context.zone}.`;
        }
        return `${context.zone} gas deviation is ${formatNumber(latestStatus.mq135AirQualityDeviation, 2)}% at ${latestStatus.displayTimestamp}. The current warning level is ${String(latestMl?.warningLevel || "unknown").toUpperCase()}${latestMl?.anomalyFlag ? ` and an anomaly is active with score ${formatNumber(latestMl.anomalyScore, 2)}.` : "."}`;
      case "latest-zone-status":
      default:
        if (!primary?.found) {
          return `No live sensor reading is available for ${context.zone}.`;
        }
        if (context.metric === "humidity") {
          return `${context.zone} humidity is ${formatNumber(primary.humidity, 1)}% at ${primary.displayTimestamp}.`;
        }
        if (context.metric === "temperature") {
          return `${context.zone} temperature is ${formatNumber(primary.temperature, 1)} C at ${primary.displayTimestamp}.`;
        }
        if (context.metric === "dustMgPerM3") {
          return `${context.zone} dust proxy is ${formatNumber(primary.dustMgPerM3, 3)} mg/m^3 at ${primary.displayTimestamp}.`;
        }
        if (context.metric === "mq135AirQualityDeviation") {
          return `${context.zone} gas deviation is ${formatNumber(primary.mq135AirQualityDeviation, 2)}% at ${primary.displayTimestamp}.`;
        }
        return `${context.zone} latest reading at ${primary.displayTimestamp}: temperature ${formatNumber(primary.temperature, 1)} C, humidity ${formatNumber(primary.humidity, 1)}%, dust ${formatNumber(primary.dustMgPerM3, 3)} mg/m^3, gas deviation ${formatNumber(primary.mq135AirQualityDeviation, 2)}%.`;
    }
  }

  function extractResponsePayload(plan, toolExecutions) {
    const primary = toolExecutions[0]?.result || null;
    if (!primary) {
      return {
        chartData: null,
        chartMeta: null,
        tableData: null,
        tableMeta: null
      };
    }

    const chartData = primary.chartData || null;
    const chartMeta = primary.chartMeta || null;
    const tableData = primary.tableData || primary.topAnomalies || null;
    const tableMeta = primary.tableMeta || (primary.topAnomalies ? {
      columns: ["displayTimestamp", "anomalyScore", "anomalyReasons"]
    } : null);

    if (plan.intent === "latest-ml-status" && primary.found) {
      return {
        chartData: null,
        chartMeta: null,
        tableData: [
          {
            anomalyFlag: primary.anomalyFlag,
            anomalyScore: primary.anomalyScore,
            warningLevel: primary.warningLevel,
            warningConfidence: primary.warningConfidence,
            anomalyReasons: primary.anomalyReasons?.join(", ") || "none"
          }
        ],
        tableMeta: {
          columns: ["anomalyFlag", "anomalyScore", "warningLevel", "warningConfidence", "anomalyReasons"]
        }
      };
    }

    return {
      chartData,
      chartMeta,
      tableData,
      tableMeta
    };
  }

  async function sendMessage({ message, conversationId, zone }) {
    const effectiveConversationId = conversationId || randomUUID().replace(/-/g, "");
    const history = await loadConversation(effectiveConversationId);
    const context = deriveContext(message, zone, history);
    const plan = buildToolPlan(message, context);

    logger.info?.(`Chat request ${effectiveConversationId}: intent=${plan.intent} zone=${context.zone}`);

    await persistMessage({
      conversationId: effectiveConversationId,
      role: "user",
      message,
      zone: context.zone,
      metadata: {
        requestedZone: zone || null
      }
    });

    const toolExecutions = [];
    for (const toolCall of plan.toolCalls) {
      logger.info?.(`Chat tool ${toolCall.name} ${JSON.stringify(toolCall.args)}`);
      toolExecutions.push(await toolRegistry.executeToolCall(toolCall));
    }

    const draftAnswer = composeDraftAnswer({
      message,
      plan,
      toolExecutions,
      context
    });
    const responsePayload = extractResponsePayload(plan, toolExecutions);
    const llmResult = await llmProvider.generateWithTools({
      systemPrompt: buildSystemPrompt(config),
      userMessage: message,
      conversation: history.map((row) => ({
        role: row.role,
        message: row.message
      })),
      toolCalls: plan.toolCalls,
      toolResults: toolExecutions,
      draftAnswer
    });
    const suggestedQuestions = buildSuggestedQuestions(plan.intent, context.zone, context.metric);
    const answer = llmResult.answer || draftAnswer;

    await persistMessage({
      conversationId: effectiveConversationId,
      role: "assistant",
      message: answer,
      zone: context.zone,
      metadata: {
        toolCalls: plan.toolCalls,
        chartMeta: responsePayload.chartMeta,
        tableMeta: responsePayload.tableMeta,
        suggestedQuestions,
        context: {
          zone: context.zone,
          metric: context.metric,
          preset: plan.context?.preset || context.preset || null,
          intent: plan.intent
        },
        provider: llmResult.provider
      },
      response: {
        answer,
        chartData: responsePayload.chartData,
        chartMeta: responsePayload.chartMeta,
        tableData: responsePayload.tableData,
        tableMeta: responsePayload.tableMeta,
        suggestedQuestions
      }
    });

    return {
      conversationId: effectiveConversationId,
      answer,
      toolCalls: plan.toolCalls,
      chartData: responsePayload.chartData,
      chartMeta: responsePayload.chartMeta,
      tableData: responsePayload.tableData,
      tableMeta: responsePayload.tableMeta,
      suggestedQuestions
    };
  }

  async function getHistory(conversationId) {
    const rows = await loadConversation(conversationId, 32);
    return rows.map((row) => ({
      role: row.role,
      message: row.message,
      zone: row.zone || null,
      timestamp: row.createdAt,
      toolCalls: row.metadata?.toolCalls || [],
      chartData: row.response?.chartData || null,
      chartMeta: row.response?.chartMeta || null,
      tableData: row.response?.tableData || null,
      tableMeta: row.response?.tableMeta || null,
      suggestedQuestions: row.response?.suggestedQuestions || row.metadata?.suggestedQuestions || []
    }));
  }

  async function clearHistory(conversationId) {
    if (!chatCollection) {
      return {
        deletedCount: 0
      };
    }

    const result = await chatCollection.deleteMany({ conversationId });
    return {
      deletedCount: result.deletedCount || 0
    };
  }

  return {
    sendMessage,
    getHistory,
    clearHistory,
    buildToolPlan,
    composeDraftAnswer
  };
}

module.exports = {
  createChatService
};
