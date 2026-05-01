#pragma once

#include <Arduino.h>

static constexpr int kHumidityWindowSize = 12;
static constexpr int kHumidityFeatureCount = 5;
static constexpr const char* kHumidityFeatureNames[kHumidityFeatureCount] = {"temperature", "humidity", "lightLux", "dustMgPerM3", "mq135AirQualityDeviation"};
static constexpr float kHumidityFeatureMeans[kHumidityFeatureCount] = {30.74325371f, 74.97108459f, 70.37890625f, 0.13758118f, 1.11399305f};
static constexpr float kHumidityFeatureScales[kHumidityFeatureCount] = {1.64727080f, 5.90430498f, 128.38407898f, 0.00598871f, 0.31993866f};
static constexpr float kHumidityTargetMean = 75.02249908f;
static constexpr float kHumidityTargetScale = 5.90731001f;
