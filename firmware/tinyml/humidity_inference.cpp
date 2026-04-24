#include "humidity_inference.h"

#include "humidity_model.h"
#include "humidity_scaler.h"

#if __has_include(<TensorFlowLite.h>) && (HUMIDITY_MODEL_DATA_LEN > 0)
#define HUMIDITY_TINYML_AVAILABLE 1
#include <TensorFlowLite.h>
#include <tensorflow/lite/micro/micro_error_reporter.h>
#include <tensorflow/lite/micro/micro_interpreter.h>
#include <tensorflow/lite/micro/micro_mutable_op_resolver.h>
#include <tensorflow/lite/schema/schema_generated.h>
#else
#define HUMIDITY_TINYML_AVAILABLE 0
#endif

#if HUMIDITY_TINYML_AVAILABLE
namespace {
tflite::MicroErrorReporter micro_error_reporter;
const tflite::Model* model_ptr = nullptr;
tflite::MicroInterpreter* interpreter_ptr = nullptr;
constexpr int kTensorArenaSize = 16 * 1024;
alignas(16) uint8_t tensor_arena[kTensorArenaSize];
}  // namespace
#endif

HumidityInferenceEngine::HumidityInferenceEngine()
    : nextIndex_(0), count_(0), enabled_(false) {}

bool HumidityInferenceEngine::begin() {
#if HUMIDITY_TINYML_AVAILABLE
  model_ptr = tflite::GetModel(g_humidity_model);
  if (!model_ptr) {
    enabled_ = false;
    return false;
  }

  static tflite::MicroMutableOpResolver<4> resolver;
  resolver.AddReshape();
  resolver.AddFullyConnected();
  resolver.AddQuantize();
  resolver.AddDequantize();

  static tflite::MicroInterpreter static_interpreter(
      model_ptr,
      resolver,
      tensor_arena,
      kTensorArenaSize,
      &micro_error_reporter);
  interpreter_ptr = &static_interpreter;

  if (interpreter_ptr->AllocateTensors() != kTfLiteOk) {
    enabled_ = false;
    return false;
  }

  enabled_ = true;
  return true;
#else
  enabled_ = false;
  return false;
#endif
}

void HumidityInferenceEngine::pushReading(const TinyMlReading& reading) {
  buffer_[nextIndex_] = reading;
  nextIndex_ = (nextIndex_ + 1) % kHumidityWindowSize;
  if (count_ < kHumidityWindowSize) {
    count_++;
  }
}

bool HumidityInferenceEngine::canInfer() const {
  return enabled_ && count_ >= kHumidityWindowSize;
}

TinyMlInferenceResult HumidityInferenceEngine::predict() {
  TinyMlInferenceResult result = {false, 0.0f, 0, "tinyml-humidity-untrained"};
  if (!canInfer()) {
    return result;
  }

#if HUMIDITY_TINYML_AVAILABLE
  TfLiteTensor* input = interpreter_ptr->input(0);
  const float input_scale = input->params.scale;
  const int input_zero_point = input->params.zero_point;

  uint32_t started_at = millis();
  for (int offset = 0; offset < kHumidityWindowSize; offset++) {
    const int buffer_index = (nextIndex_ + offset) % kHumidityWindowSize;
    const TinyMlReading& reading = buffer_[buffer_index];
    const float values[kHumidityFeatureCount] = {
        reading.temperature,
        reading.humidity,
        reading.lightLux,
        reading.dustMgPerM3,
        reading.mq135AirQualityDeviation,
    };

    for (int feature_index = 0; feature_index < kHumidityFeatureCount; feature_index++) {
      const float normalized =
          (values[feature_index] - kHumidityFeatureMeans[feature_index]) /
          kHumidityFeatureScales[feature_index];
      const int quantized = static_cast<int>(roundf(normalized / input_scale)) + input_zero_point;
      input->data.int8[(offset * kHumidityFeatureCount) + feature_index] =
          static_cast<int8_t>(constrain(quantized, -128, 127));
    }
  }

  if (interpreter_ptr->Invoke() != kTfLiteOk) {
    return result;
  }

  TfLiteTensor* output = interpreter_ptr->output(0);
  const float dequantized =
      (static_cast<float>(output->data.int8[0]) - output->params.zero_point) * output->params.scale;
  result.valid = true;
  result.predictedHumidity = dequantized;
  result.inferenceLatencyMs = millis() - started_at;
  result.modelVersion = "tinyml-humidity-v1";
#endif
  return result;
}
