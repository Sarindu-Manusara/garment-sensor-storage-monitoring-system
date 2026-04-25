const STATUS_ORDER = {
  safe: 0,
  warning: 1,
  danger: 2,
  waiting: -1
};

function toFiniteNumber(value) {
  const parsed = typeof value === "string" ? Number.parseFloat(value) : value;
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeHealthStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "high" || normalized === "danger") {
    return "danger";
  }
  if (normalized === "medium" || normalized === "warning") {
    return "warning";
  }
  if (normalized === "low" || normalized === "safe") {
    return "safe";
  }
  return "waiting";
}

function formatNumber(value, decimals = 1) {
  const parsed = toFiniteNumber(value);
  return parsed === null ? "n/a" : parsed.toFixed(decimals);
}

function formatTimestamp(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "unknown time";
  }

  return parsed.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function sanitizePhoneNumber(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function collectThresholdBreaches(actualReading = {}, thresholds = {}) {
  const checks = [
    {
      key: "temperature",
      label: "Temperature",
      unit: "C",
      value: actualReading.temperature,
      thresholds: thresholds.temperature
    },
    {
      key: "humidity",
      label: "Humidity",
      unit: "%",
      value: actualReading.humidity,
      thresholds: thresholds.humidity
    },
    {
      key: "lightLux",
      label: "Light",
      unit: "lx",
      value: actualReading.lightLux,
      thresholds: thresholds.light
    },
    {
      key: "dustMgPerM3",
      label: "Dust",
      unit: "mg/m^3",
      value: actualReading.dustMgPerM3,
      thresholds: thresholds.dust
    },
    {
      key: "mq135AirQualityDeviation",
      label: "Gas deviation",
      unit: "%",
      value: actualReading.mq135AirQualityDeviation,
      thresholds: thresholds.gas
    }
  ];

  return checks
    .map((check) => {
      const value = toFiniteNumber(check.value);
      if (!check.thresholds || value === null) {
        return null;
      }

      if (value >= check.thresholds.high) {
        return {
          ...check,
          value,
          severity: "danger",
          threshold: check.thresholds.high
        };
      }

      if (value >= check.thresholds.medium) {
        return {
          ...check,
          value,
          severity: "warning",
          threshold: check.thresholds.medium
        };
      }

      return null;
    })
    .filter(Boolean);
}

function deriveHealthStatus({ actualReading, inference, thresholds }) {
  const warningStatus = normalizeHealthStatus(inference?.warningLevel);
  if (warningStatus !== "waiting") {
    return warningStatus;
  }

  if (inference?.anomalyFlag) {
    return Number(inference.anomalyScore || 0) >= 0.75 ? "danger" : "warning";
  }

  if (!actualReading) {
    return "waiting";
  }

  const highestBreach = collectThresholdBreaches(actualReading, thresholds)
    .sort((left, right) => STATUS_ORDER[right.severity] - STATUS_ORDER[left.severity])[0];

  return highestBreach?.severity || "safe";
}

function buildAlertMessage({
  zone,
  timestamp,
  actualReading,
  inference,
  healthStatus,
  thresholds,
  dashboardUrl
}) {
  const statusLabel = String(healthStatus || "warning").toUpperCase();
  const breaches = collectThresholdBreaches(actualReading, thresholds);
  const breachLines = breaches.length > 0
    ? breaches.map((breach) => {
      const severityLabel = breach.severity === "danger" ? "high" : "medium";
      return `- ${breach.label}: ${formatNumber(breach.value, breach.unit === "mg/m^3" ? 3 : 1)} ${breach.unit} (>${formatNumber(breach.threshold, breach.unit === "mg/m^3" ? 3 : 1)} ${severityLabel})`;
    }).join("\n")
    : "- No direct threshold breach captured in the latest reading.";

  const anomalyReasons = Array.isArray(inference?.anomalyReasons) && inference.anomalyReasons.length > 0
    ? inference.anomalyReasons.join(", ")
    : "none";

  const dashboardLine = dashboardUrl
    ? `Dashboard: ${dashboardUrl}`
    : "";

  return [
    `MAOCHI alert: ${statusLabel}`,
    `Zone: ${zone}`,
    `Time: ${formatTimestamp(timestamp)}`,
    `Humidity: ${formatNumber(actualReading?.humidity, 1)}%`,
    `Gas deviation: ${formatNumber(actualReading?.mq135AirQualityDeviation, 2)}%`,
    `Dust: ${formatNumber(actualReading?.dustMgPerM3, 3)} mg/m^3`,
    `Warning level: ${String(inference?.warningLevel || "unavailable").toUpperCase()} (${formatNumber((inference?.warningConfidence ?? 0) * 100, 0)}%)`,
    `Anomaly score: ${formatNumber(inference?.anomalyScore, 2)}`,
    `Anomaly reasons: ${anomalyReasons}`,
    "Thresholds crossed:",
    breachLines,
    dashboardLine
  ].filter(Boolean).join("\n");
}

function extractChatId(payload) {
  const candidates = [
    payload?.chatId,
    payload?.data?.chatId,
    payload?.data?.id,
    payload?.id,
    payload?.numberId,
    payload?.data?.numberId
  ];

  return candidates.find((value) => typeof value === "string" && value.trim());
}

function resolveMessageIdentifier(payload) {
  const candidates = [
    payload?.messageId,
    payload?.id,
    payload?.data?.messageId,
    payload?.data?.id
  ];

  return candidates.find((value) => value !== undefined && value !== null) ?? null;
}

function createWaapiClient(config, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required for WAAPI integration.");
  }

  const baseUrl = String(config.waapiBaseUrl || "https://waapi.app/api/v1/instances").replace(/\/+$/, "");
  const instanceId = String(config.waapiInstanceId || "").trim();
  const apiToken = String(config.waapiApiToken || "").trim();

  async function postJson(pathname, body) {
    const response = await fetchImpl(`${baseUrl}/${instanceId}${pathname}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload?.message || payload?.error || `WAAPI request failed with status ${response.status}.`;
      throw new Error(message);
    }

    return payload;
  }

  return {
    async getNumberId(phoneNumber) {
      const sanitized = sanitizePhoneNumber(phoneNumber);
      const payload = await postJson("/client/action/get-number-id", {
        phoneNumber: sanitized
      });
      const chatId = extractChatId(payload);
      if (!chatId) {
        throw new Error(`WAAPI did not return a chat ID for ${sanitized}.`);
      }

      return {
        phoneNumber: sanitized,
        chatId,
        raw: payload
      };
    },

    async sendMessage({ chatId, message }) {
      const payload = await postJson("/client/action/send-message", {
        chatId,
        message
      });

      return {
        chatId,
        messageId: resolveMessageIdentifier(payload),
        raw: payload
      };
    }
  };
}

function createAlertService({
  config,
  alertCollection = null,
  fetchImpl = globalThis.fetch
}) {
  const waapiConfigured = Boolean(
    config?.waapiEnabled
    && config?.waapiInstanceId
    && config?.waapiApiToken
    && ((config?.waapiChatIds?.length || 0) > 0 || (config?.waapiRecipientPhones?.length || 0) > 0)
  );
  const waapiClient = waapiConfigured ? createWaapiClient(config, fetchImpl) : null;
  const recipientCache = new Map();

  async function findRecentAlert(zone, healthStatus) {
    if (!alertCollection) {
      return null;
    }

    const cutoff = new Date(Date.now() - ((config.waapiAlertCooldownMinutes || 30) * 60 * 1000));
    return alertCollection
      .find({
        zone,
        healthStatus,
        sent: true,
        createdAt: { $gte: cutoff }
      })
      .sort({ createdAt: -1, _id: -1 })
      .limit(1)
      .next();
  }

  async function persistAlertLog(document) {
    if (!alertCollection) {
      return;
    }

    await alertCollection.insertOne(document);
  }

  async function resolveRecipients() {
    const recipients = [];
    for (const chatId of config.waapiChatIds || []) {
      recipients.push({
        kind: "chatId",
        target: chatId,
        chatId
      });
    }

    for (const phoneNumber of config.waapiRecipientPhones || []) {
      const cacheKey = sanitizePhoneNumber(phoneNumber);
      let resolved = recipientCache.get(cacheKey);
      if (!resolved) {
        resolved = await waapiClient.getNumberId(phoneNumber);
        recipientCache.set(cacheKey, resolved);
      }
      recipients.push({
        kind: "phoneNumber",
        target: resolved.phoneNumber,
        chatId: resolved.chatId
      });
    }

    return recipients;
  }

  async function sendAlert({
    actualReading,
    inference,
    source = "monitor"
  }) {
    const zone = String(actualReading?.zone || config.zone || "zone1").trim() || "zone1";
    const timestamp = actualReading?.timestamp || new Date();
    const healthStatus = deriveHealthStatus({
      actualReading,
      inference,
      thresholds: config.riskThresholds
    });

    if (!waapiConfigured) {
      return {
        enabled: false,
        sent: false,
        healthStatus,
        reason: "WAAPI is disabled or incomplete."
      };
    }

    if (healthStatus !== "warning" && healthStatus !== "danger") {
      return {
        enabled: true,
        sent: false,
        healthStatus,
        reason: "Latest health state is not warning or danger."
      };
    }

    if (healthStatus === "warning" && !config.waapiSendWarningAlerts) {
      return {
        enabled: true,
        sent: false,
        healthStatus,
        reason: "Warning alerts are disabled."
      };
    }

    if (healthStatus === "danger" && !config.waapiSendDangerAlerts) {
      return {
        enabled: true,
        sent: false,
        healthStatus,
        reason: "Danger alerts are disabled."
      };
    }

    const recentAlert = await findRecentAlert(zone, healthStatus);
    if (recentAlert) {
      return {
        enabled: true,
        sent: false,
        healthStatus,
        reason: `A ${healthStatus} alert was already sent recently for ${zone}.`,
        deduplicated: true
      };
    }

    const recipients = await resolveRecipients();
    if (recipients.length === 0) {
      return {
        enabled: true,
        sent: false,
        healthStatus,
        reason: "No WAAPI recipients are configured."
      };
    }

    const message = buildAlertMessage({
      zone,
      timestamp,
      actualReading,
      inference,
      healthStatus,
      thresholds: config.riskThresholds,
      dashboardUrl: config.publicDashboardUrl
    });

    const deliveries = [];
    for (const recipient of recipients) {
      const delivery = await waapiClient.sendMessage({
        chatId: recipient.chatId,
        message
      });
      deliveries.push({
        recipient: recipient.target,
        chatId: recipient.chatId,
        kind: recipient.kind,
        messageId: delivery.messageId
      });
    }

    await persistAlertLog({
      zone,
      timestamp: new Date(timestamp),
      createdAt: new Date(),
      source,
      sent: true,
      healthStatus,
      warningLevel: inference?.warningLevel ?? null,
      warningConfidence: inference?.warningConfidence ?? null,
      anomalyFlag: Boolean(inference?.anomalyFlag),
      anomalyScore: inference?.anomalyScore ?? null,
      anomalyReasons: inference?.anomalyReasons ?? [],
      actualReading: actualReading || null,
      recipients: deliveries,
      message
    });

    return {
      enabled: true,
      sent: true,
      healthStatus,
      deliveries
    };
  }

  return {
    deriveHealthStatus: (payload) => deriveHealthStatus({
      ...payload,
      thresholds: payload?.thresholds || config.riskThresholds
    }),
    sendAlert
  };
}

module.exports = {
  buildAlertMessage,
  collectThresholdBreaches,
  createAlertService,
  createWaapiClient,
  deriveHealthStatus,
  normalizeHealthStatus,
  sanitizePhoneNumber
};
