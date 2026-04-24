#pragma once

#include <Arduino.h>

static constexpr int kHumidityWindowSize = 12;
static constexpr int kHumidityFeatureCount = 5;
static constexpr const char* kHumidityFeatureNames[kHumidityFeatureCount] = {
  "temperature",
  "humidity",
  "lightLux",
  "dustMgPerM3",
  "mq135AirQualityDeviation"
};
static constexpr float kHumidityFeatureMeans[kHumidityFeatureCount] = {
  0.0f,
  0.0f,
  0.0f,
  0.0f,
  0.0f
};
static constexpr float kHumidityFeatureScales[kHumidityFeatureCount] = {
  1.0f,
  1.0f,
  1.0f,
  1.0f,
  1.0f
};

