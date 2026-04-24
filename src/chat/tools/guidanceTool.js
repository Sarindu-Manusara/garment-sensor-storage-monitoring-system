const {
  loadLatestMlStatus,
  loadLatestZoneStatus,
  sanitizeZone
} = require("../utils");

function detectGuidanceFocus(topic = "") {
  const normalized = String(topic || "").toLowerCase();
  if (/anomaly/.test(normalized)) {
    return "anomaly";
  }
  if (/warning/.test(normalized)) {
    return "warning";
  }
  if (/predict|tinyml|forecast/.test(normalized)) {
    return "prediction";
  }
  if (/compare|zone|versus|vs/.test(normalized)) {
    return "comparison";
  }
  return "general";
}

function buildSteps(focus, zone, latestStatus, latestMl) {
  if (focus === "anomaly") {
    return [
      {
        step: 1,
        section: "ML Insights",
        action: "Check the anomaly card first.",
        reason: `It shows whether ${zone} is currently flagged and which reasons are attached to the latest score.`
      },
      {
        step: 2,
        section: "Brushed Timeline Analysis",
        action: "Brush the time range around the anomaly.",
        reason: "This narrows the view to the period where the score rose and reveals whether the spike was brief or sustained."
      },
      {
        step: 3,
        section: "Linked Event Drill-Down",
        action: "Select the highest anomaly point.",
        reason: "The drill-down compares actual humidity, TinyML output, anomaly score, and warning state for one event."
      },
      {
        step: 4,
        section: "Recent Sensor Captures",
        action: "Verify the raw sensor context.",
        reason: "Use the latest readings to confirm whether gas, dust, or humidity remained elevated after the anomaly."
      }
    ];
  }

  if (focus === "warning") {
    return [
      {
        step: 1,
        section: "System Health Overview",
        action: "Start with the health and warning summary.",
        reason: `This confirms whether ${zone} is currently low, medium, or high risk.`
      },
      {
        step: 2,
        section: "ML Insights",
        action: "Inspect the warning classifier card.",
        reason: "The classifier confidence shows whether the current warning state is strong or borderline."
      },
      {
        step: 3,
        section: "Filters and Focus",
        action: "Set the focus metric to humidity, dust, or gas.",
        reason: "Those are the metrics most often tied to warning escalations in this system."
      },
      {
        step: 4,
        section: "Linked Event Drill-Down",
        action: "Open a selected warning event.",
        reason: "This lets you verify which reading crossed the safe range at that timestamp."
      }
    ];
  }

  if (focus === "prediction") {
    return [
      {
        step: 1,
        section: "ML Insights",
        action: "Check the TinyML forecast card.",
        reason: "It shows the latest predicted humidity, the actual humidity, and the current prediction delta."
      },
      {
        step: 2,
        section: "Brushed Timeline Analysis",
        action: "Use the humidity chart.",
        reason: "The actual-versus-predicted line chart reveals whether the ESP32 forecast is tracking the real humidity well."
      },
      {
        step: 3,
        section: "Linked Event Drill-Down",
        action: "Select a point with a large delta.",
        reason: "The drill-down shows the matched sensor reading, TinyML prediction, and backend inference for that event."
      },
      {
        step: 4,
        section: "Recent Sensor Captures",
        action: "Compare the selected event with the most recent reading.",
        reason: "This confirms whether the model error is improving or drifting in the live stream."
      }
    ];
  }

  if (focus === "comparison") {
    return [
      {
        step: 1,
        section: "Zone Comparison",
        action: "Choose the zone to investigate.",
        reason: "This quickly surfaces which zone has the highest warning state or humidity burden."
      },
      {
        step: 2,
        section: "Filters and Focus",
        action: "Set the metric and detail filter.",
        reason: "This reduces clutter before comparing the same metric across a brushed time range."
      },
      {
        step: 3,
        section: "Brushed Timeline Analysis",
        action: "Brush the range you want to compare.",
        reason: "A tighter brush makes the zone comparison and anomaly interpretation more precise."
      },
      {
        step: 4,
        section: "Linked Event Drill-Down",
        action: "Inspect a representative event.",
        reason: "Use one timestamp to explain why the compared windows diverged."
      }
    ];
  }

  const warningLevel = String(latestMl?.warningLevel || "unknown").toUpperCase();
  const humidity = latestStatus?.humidity;
  return [
    {
      step: 1,
      section: "Zone Comparison",
      action: "Start with the active zone strip.",
      reason: "This shows which zone needs attention before you open a deeper chart."
    },
    {
      step: 2,
      section: "System Health Overview",
      action: "Read the current health summary.",
      reason: `${zone} is currently ${warningLevel} with live humidity ${humidity ?? "unavailable"}%.`
    },
    {
      step: 3,
      section: "ML Insights",
      action: "Check the anomaly, warning, and TinyML cards.",
      reason: "These cards summarize the model outputs before you move into the linked charts."
    },
    {
      step: 4,
      section: "Brushed Timeline Analysis",
      action: "Brush the time window and select an event.",
      reason: "This is the main path from dashboard overview to evidence-backed investigation."
    }
  ];
}

function createGuidanceTools(context) {
  const { config, sensorCollection, mlCollection } = context;

  return [
    {
      name: "get_dashboard_guidance",
      description: "Return grounded guidance for how to explore the dashboard for a topic.",
      parameters: {
        type: "object",
        properties: {
          zone: { type: "string" },
          topic: { type: "string" }
        },
        required: ["zone"]
      },
      async execute(args = {}) {
        const zone = sanitizeZone(args.zone, config.zone);
        const topic = String(args.topic || "").trim();
        const focus = detectGuidanceFocus(topic);
        const [latestStatus, latestMl] = await Promise.all([
          loadLatestZoneStatus({ sensorCollection, zone }),
          loadLatestMlStatus({
            config,
            sensorCollection,
            mlCollection,
            zone,
            allowLiveInference: true
          })
        ]);
        const steps = buildSteps(focus, zone, latestStatus, latestMl.data);

        return {
          zone,
          focus,
          latestStatus: latestStatus ? {
            humidity: latestStatus.humidity,
            temperature: latestStatus.temperature,
            gasDeviation: latestStatus.mq135AirQualityDeviation
          } : null,
          latestMl: latestMl.data ? {
            anomalyFlag: latestMl.data.anomalyFlag,
            anomalyScore: latestMl.data.anomalyScore,
            warningLevel: latestMl.data.warningLevel,
            warningConfidence: latestMl.data.warningConfidence
          } : null,
          steps,
          summary: `Use ${steps[0]?.section || "the dashboard"} first for ${focus} questions in ${zone}.`,
          tableData: steps,
          tableMeta: {
            columns: ["step", "section", "action", "reason"]
          }
        };
      }
    }
  ];
}

module.exports = {
  createGuidanceTools
};
