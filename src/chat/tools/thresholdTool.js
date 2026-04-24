function createThresholdTools(context) {
  const { config } = context;

  return [
    {
      name: "get_threshold_config",
      description: "Return the configured storage thresholds and explainers.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      },
      async execute() {
        return {
          thresholds: config.riskThresholds,
          explanations: {
            mq135AirQualityDeviation: "This is the MQ135 gas-reading deviation relative to the configured baseline. Higher positive values suggest poorer air quality.",
            tinymlPrediction: "TinyML humidity prediction is the ESP32's on-device forecast of the next humidity step based on recent sensor history.",
            healthScore: "The health score is a dashboard summary that drops when warning severity rises, anomaly scores increase, or live sensor values move outside safe ranges."
          }
        };
      }
    }
  ];
}

module.exports = {
  createThresholdTools
};

