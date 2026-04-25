function parseInteger(value, fallback, label) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`${label} must be an integer.`);
  }

  return parsed;
}

function parseNumber(value, fallback, label) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`${label} must be a number.`);
  }

  return parsed;
}

function decodeDelimiter(value) {
  return value.replace(/\\r/g, "\r").replace(/\\n/g, "\n");
}

function requireEnv(env, name) {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function loadBaseConfig(env) {
  const mongodbDatabase = env.MONGODB_SENSOR_DATABASE || env.MONGODB_DATABASE || "garment_monitoring";
  const mongodbCollection = env.MONGODB_SENSOR_COLLECTION || env.MONGODB_COLLECTION || "sensor_readings";

  return {
    mongodbUri: requireEnv(env, "MONGODB_URI"),
    mongodbDatabase,
    mongodbCollection,
    mongodbMlCollection: env.MONGODB_ML_COLLECTION || "ml_predictions",
    mongodbChatCollection: env.MONGODB_CHAT_COLLECTION || "chat_messages",
    mongodbAlertCollection: env.MONGODB_ALERT_COLLECTION || "alert_notifications",
    pythonBin: env.PYTHON_BIN || "py",
    tinymlModelVersion: env.TINYML_MODEL_VERSION || "tinyml-humidity-v1",
    backendModelVersion: env.BACKEND_MODEL_VERSION || "backend-ml-v1",
    chatLlmProvider: (env.CHAT_LLM_PROVIDER || "local").trim().toLowerCase(),
    chatLlmApiKey: env.CHAT_LLM_API_KEY || env.OPENAI_API_KEY || "",
    chatLlmBaseUrl: env.CHAT_LLM_BASE_URL || "https://api.openai.com/v1",
    chatLlmModel: env.CHAT_LLM_MODEL || "gpt-4.1-mini",
    chatLlmTimeoutMs: parseInteger(env.CHAT_LLM_TIMEOUT_MS, 15000, "CHAT_LLM_TIMEOUT_MS"),
    mq135BaselineRaw: parseNumber(env.MQ135_BASELINE_RAW, 2800, "MQ135_BASELINE_RAW"),
    deviceId: env.DEVICE_ID || "esp32-garment-1",
    zone: env.ZONE || "zone1",
    publicDashboardUrl: env.PUBLIC_DASHBOARD_URL || "",
    liveMlMonitorEnabled: String(env.LIVE_ML_MONITOR_ENABLED ?? "true").trim().toLowerCase() !== "false",
    liveMlMonitorIntervalMs: parseInteger(env.LIVE_ML_MONITOR_INTERVAL_MS, 15000, "LIVE_ML_MONITOR_INTERVAL_MS"),
    waapiEnabled: String(env.WAAPI_ENABLED || "false").trim().toLowerCase() === "true",
    waapiBaseUrl: env.WAAPI_BASE_URL || "https://waapi.app/api/v1/instances",
    waapiInstanceId: env.WAAPI_INSTANCE_ID || "",
    waapiApiToken: env.WAAPI_API_TOKEN || "",
    waapiChatIds: String(env.WAAPI_CHAT_IDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    waapiRecipientPhones: String(env.WAAPI_RECIPIENT_PHONES || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    waapiAlertCooldownMinutes: parseInteger(env.WAAPI_ALERT_COOLDOWN_MINUTES, 30, "WAAPI_ALERT_COOLDOWN_MINUTES"),
    waapiSendWarningAlerts: String(env.WAAPI_SEND_WARNING_ALERTS ?? "true").trim().toLowerCase() !== "false",
    waapiSendDangerAlerts: String(env.WAAPI_SEND_DANGER_ALERTS ?? "true").trim().toLowerCase() !== "false",
    riskThresholds: {
      temperature: {
        medium: parseNumber(env.TEMPERATURE_MEDIUM_THRESHOLD, 28, "TEMPERATURE_MEDIUM_THRESHOLD"),
        high: parseNumber(env.TEMPERATURE_HIGH_THRESHOLD, 30, "TEMPERATURE_HIGH_THRESHOLD")
      },
      humidity: {
        medium: parseNumber(env.HUMIDITY_MEDIUM_THRESHOLD, 60, "HUMIDITY_MEDIUM_THRESHOLD"),
        high: parseNumber(env.HUMIDITY_HIGH_THRESHOLD, 70, "HUMIDITY_HIGH_THRESHOLD")
      },
      light: {
        medium: parseNumber(env.LIGHT_MEDIUM_THRESHOLD, 150, "LIGHT_MEDIUM_THRESHOLD"),
        high: parseNumber(env.LIGHT_HIGH_THRESHOLD, 300, "LIGHT_HIGH_THRESHOLD")
      },
      dust: {
        medium: parseNumber(env.DUST_MEDIUM_THRESHOLD, 0.03, "DUST_MEDIUM_THRESHOLD"),
        high: parseNumber(env.DUST_HIGH_THRESHOLD, 0.045, "DUST_HIGH_THRESHOLD")
      },
      gas: {
        medium: parseNumber(env.GAS_MEDIUM_THRESHOLD, 0.75, "GAS_MEDIUM_THRESHOLD"),
        high: parseNumber(env.GAS_HIGH_THRESHOLD, 1.5, "GAS_HIGH_THRESHOLD")
      }
    }
  };
}

function loadConfig(env, options = {}) {
  const config = loadBaseConfig(env);

  if (options.requireSerial === false) {
    return config;
  }

  return {
    ...config,
    serialPortPath: requireEnv(env, "SERIAL_PORT"),
    serialBaudRate: parseInteger(env.SERIAL_BAUD_RATE, 9600, "SERIAL_BAUD_RATE"),
    serialDelimiter: decodeDelimiter(env.SERIAL_DELIMITER || "\\r\\n")
  };
}

module.exports = {
  loadConfig
};
