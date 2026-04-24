#pragma once

#include <Arduino.h>

#include "humidity_scaler.h"

struct TinyMlReading {
  float temperature;
  float humidity;
  float lightLux;
  float dustMgPerM3;
  float mq135AirQualityDeviation;
  float mq135Raw;
};

struct TinyMlInferenceResult {
  bool valid;
  float predictedHumidity;
  uint32_t inferenceLatencyMs;
  const char* modelVersion;
};

class HumidityInferenceEngine {
 public:
  HumidityInferenceEngine();
  bool begin();
  void pushReading(const TinyMlReading& reading);
  bool canInfer() const;
  TinyMlInferenceResult predict();

 private:
 TinyMlReading buffer_[kHumidityWindowSize];
  int nextIndex_;
  int count_;
  bool enabled_;
};
