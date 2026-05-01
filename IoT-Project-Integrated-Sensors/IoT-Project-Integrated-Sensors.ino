/*
   ESP32 4-sensor monitor + MQTT + TinyML serial output
   ----------------------------------------------------
   Sensors:
   1) DHT22 / AM2302
   2) GP2Y1010AU0F dust sensor
   3) BH1750FVI light intensity sensor
   4) MQ-135 gas sensor

   This sketch is the primary integrated firmware entrypoint for the repo.
   It:
   - reads the 4 physical sensors
   - publishes sensor snapshots to MQTT
   - keeps a rolling TinyML input window
   - emits one JSON line over serial per sample for the Node ingester
   - optionally POSTs device-side TinyML predictions to the backend
*/

#include <Arduino.h>
#include <ArduinoJson.h>
#include <BH1750.h>
#include <HTTPClient.h>
#include <PubSubClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <time.h>
#include <TensorFlowLite_ESP32.h>

#include "../firmware/tinyml/humidity_inference.h"
// Compile the shared TinyML implementation with this sketch.
#include "../firmware/tinyml/humidity_inference.cpp"

// =======================
// Wi-Fi / MQTT settings
// =======================
const char* WIFI_SSID = "SLT-Mobitel 4G Mobile B9E9A5";
const char* WIFI_PASSWORD = "467D04E7";
// Use the PC's LAN IP here. "localhost" will not work from the ESP32.
const char* SENSOR_INGEST_ENDPOINT = "http://172.28.30.223:3001/api/readings/device";

const char* MQTT_SERVER = "broker.hivemq.com";
const int MQTT_PORT = 1883;
const char* MQTT_USERNAME = "";
const char* MQTT_PASSWORD = "";
const char* MQTT_TOPIC = "maochi-streetwear/garment-storage/zone1/readings";

const char* DEVICE_ID = "esp32-garment-1";
const char* ZONE = "zone1";
const char* NTP_SERVER_1 = "pool.ntp.org";
const char* NTP_SERVER_2 = "time.nist.gov";

// =======================
// Pin configuration
// =======================
#define DHT_PIN       5
#define DUST_LED_PIN  26
#define DUST_VO_PIN   34
#define MQ135_AO_PIN  32

// =======================
// ADC / timing configuration
// =======================
const float ADC_REF_VOLTAGE = 3.3f;
const int ADC_MAX_VALUE = 4095;
const float MQ135_DIVIDER_RATIO = 2.0f;
const int MQ135_BASELINE_RAW = 2770;
const float DUST_SLOPE = 0.17f;
const float DUST_OFFSET = 0.10f;
const unsigned long SAMPLE_INTERVAL_MS = 5000UL;

// =======================
// Global objects
// =======================
BH1750 lightMeter;
WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);
HumidityInferenceEngine humidityInference;

bool lightSensorReady = false;
bool tinyMlReady = false;
unsigned long lastSampleTime = 0;

float lastValidTemperature = 0.0f;
float lastValidHumidity = 0.0f;
bool hasLastValidTemperature = false;
bool hasLastValidHumidity = false;

// =======================
// Data structures
// =======================
struct DHTData {
  float temperatureC;
  float humidity;
  bool valid;
};

struct DustData {
  int raw;
  float voltage;
  float densityMgPerM3;
};

struct MQ135Data {
  int raw;
  float adcVoltage;
  float sensorVoltage;
  float airQualityDeviation;
};

struct SensorSnapshot {
  bool valid;
  bool hasFreshDht;
  float temperature;
  float humidity;
  float lightLux;
  float dustMgPerM3;
  int mq135Raw;
  float mq135AirQualityDeviation;
};

struct TinyMlUploadStatus {
  bool uploadAttempted;
  bool uploadSucceeded;
  int httpStatus;
};

// =======================
// Utility helpers
// =======================
float rawToVoltage(int raw) {
  return (raw * ADC_REF_VOLTAGE) / ADC_MAX_VALUE;
}

uint32_t waitForStateChange(uint8_t pin, uint8_t state, uint32_t timeoutUs) {
  uint32_t start = micros();
  while (digitalRead(pin) == state) {
    if ((micros() - start) > timeoutUs) {
      return 0;
    }
  }
  return micros() - start;
}

bool hasWifiConfig() {
  return WIFI_SSID[0] != '\0' && WIFI_PASSWORD[0] != '\0';
}

bool hasPredictionEndpointConfig() {
  return SENSOR_INGEST_ENDPOINT[0] != '\0';
}

bool isLightValid(float lux) {
  return !isnan(lux) && lux >= 0.0f;
}

bool isDustValid(const DustData& dust) {
  return dust.raw > 0 && dust.raw < ADC_MAX_VALUE;
}

bool isMq135Valid(const MQ135Data& mq135) {
  return mq135.raw > 0 && mq135.raw < ADC_MAX_VALUE;
}

int countFailingSensors(const DHTData& dht, float lux, const DustData& dust, const MQ135Data& mq135) {
  int failures = 0;
  if (!dht.valid) failures++;
  if (!isLightValid(lux)) failures++;
  if (!isDustValid(dust)) failures++;
  if (!isMq135Valid(mq135)) failures++;
  return failures;
}

void ensureTimeSync() {
  if (WiFi.status() == WL_CONNECTED) {
    configTime(0, 0, NTP_SERVER_1, NTP_SERVER_2);
  }
}

bool tryGetIsoTimestamp(char* buffer, size_t bufferSize) {
  struct tm timeInfo;
  if (!getLocalTime(&timeInfo, 100)) {
    return false;
  }
  strftime(buffer, bufferSize, "%Y-%m-%dT%H:%M:%SZ", &timeInfo);
  return true;
}

void connectWiFiIfNeeded() {
  if (!hasWifiConfig() || WiFi.status() == WL_CONNECTED) {
    return;
  }

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long startedAt = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - startedAt) < 15000UL) {
    delay(250);
  }

  if (WiFi.status() == WL_CONNECTED) {
    ensureTimeSync();
  }
}

void connectMQTTIfNeeded() {
  if (mqttClient.connected()) {
    return;
  }

  while (!mqttClient.connected() && WiFi.status() == WL_CONNECTED) {
    String clientId = "ESP32-GarmentMonitor-";
    clientId += String((uint32_t)random(0xffff), HEX);

    bool connected;
    if (strlen(MQTT_USERNAME) > 0) {
      connected = mqttClient.connect(clientId.c_str(), MQTT_USERNAME, MQTT_PASSWORD);
    } else {
      connected = mqttClient.connect(clientId.c_str());
    }

    if (connected) {
      break;
    }

    delay(1000);
  }
}

// =======================
// DHT22 functions
// =======================
bool readDHT22Single(uint8_t dhtPin, float& temperatureC, float& humidity) {
  uint8_t data[5] = {0, 0, 0, 0, 0};

  pinMode(dhtPin, OUTPUT);
  digitalWrite(dhtPin, LOW);
  delay(2);
  digitalWrite(dhtPin, HIGH);
  delayMicroseconds(30);

  pinMode(dhtPin, INPUT_PULLUP);

  if (waitForStateChange(dhtPin, HIGH, 100) == 0) return false;
  if (waitForStateChange(dhtPin, LOW, 100) == 0) return false;
  if (waitForStateChange(dhtPin, HIGH, 100) == 0) return false;

  for (int i = 0; i < 40; i++) {
    if (waitForStateChange(dhtPin, LOW, 70) == 0) return false;

    uint32_t highTime = waitForStateChange(dhtPin, HIGH, 120);
    if (highTime == 0) return false;

    data[i / 8] <<= 1;
    if (highTime > 40) {
      data[i / 8] |= 1;
    }
  }

  uint8_t checksum = (uint8_t)(data[0] + data[1] + data[2] + data[3]);
  if (checksum != data[4]) return false;

  uint16_t rawHumidity = ((uint16_t)data[0] << 8) | data[1];
  humidity = rawHumidity * 0.1f;

  uint16_t rawTemp = ((uint16_t)data[2] << 8) | data[3];
  if (rawTemp & 0x8000) {
    rawTemp &= 0x7FFF;
    temperatureC = -rawTemp * 0.1f;
  } else {
    temperatureC = rawTemp * 0.1f;
  }

  return true;
}

DHTData readDHT22Averaged(uint8_t dhtPin, int samples) {
  float tempSum = 0.0f;
  float humSum = 0.0f;
  int validCount = 0;

  for (int i = 0; i < samples; i++) {
    float t = 0.0f;
    float h = 0.0f;
    if (readDHT22Single(dhtPin, t, h)) {
      tempSum += t;
      humSum += h;
      validCount++;
    }

    if (i < samples - 1) {
      delay(20);
    }
  }

  DHTData result;
  if (validCount == 0) {
    result.temperatureC = 0.0f;
    result.humidity = 0.0f;
    result.valid = false;
  } else {
    result.temperatureC = tempSum / validCount;
    result.humidity = humSum / validCount;
    result.valid = true;
  }
  return result;
}

// =======================
// Dust sensor functions
// =======================
int readDustRawSingle() {
  digitalWrite(DUST_LED_PIN, LOW);
  delayMicroseconds(280);
  int raw = analogRead(DUST_VO_PIN);
  delayMicroseconds(40);
  digitalWrite(DUST_LED_PIN, HIGH);
  delayMicroseconds(9680);
  return raw;
}

DustData readDustAveraged(int samples) {
  long sum = 0;
  for (int i = 0; i < samples; i++) {
    sum += readDustRawSingle();
  }

  int avgRaw = sum / samples;
  float voltage = rawToVoltage(avgRaw);
  float density = DUST_SLOPE * voltage - DUST_OFFSET;
  if (density < 0.0f) {
    density = 0.0f;
  }

  DustData data;
  data.raw = avgRaw;
  data.voltage = voltage;
  data.densityMgPerM3 = density;
  return data;
}

// =======================
// MQ-135 functions
// =======================
MQ135Data readMQ135Averaged(int samples) {
  long sum = 0;
  for (int i = 0; i < samples; i++) {
    sum += analogRead(MQ135_AO_PIN);
    if (i < samples - 1) {
      delay(5);
    }
  }

  int avgRaw = sum / samples;
  float adcVoltage = rawToVoltage(avgRaw);
  float sensorVoltage = adcVoltage * MQ135_DIVIDER_RATIO;
  float airQualityDeviation = ((float)(avgRaw - MQ135_BASELINE_RAW) / (float)MQ135_BASELINE_RAW) * 100.0f;

  MQ135Data data;
  data.raw = avgRaw;
  data.adcVoltage = adcVoltage;
  data.sensorVoltage = sensorVoltage;
  data.airQualityDeviation = airQualityDeviation;
  return data;
}

SensorSnapshot buildSnapshot(const DHTData& dht, const DustData& dust, float lux, const MQ135Data& mq135) {
  SensorSnapshot snapshot;
  snapshot.hasFreshDht = dht.valid;

  if (dht.valid) {
    lastValidTemperature = dht.temperatureC;
    lastValidHumidity = dht.humidity;
    hasLastValidTemperature = true;
    hasLastValidHumidity = true;
  }

  snapshot.valid = (dht.valid || (hasLastValidTemperature && hasLastValidHumidity));
  snapshot.temperature = dht.valid
    ? dht.temperatureC
    : (hasLastValidTemperature ? lastValidTemperature : 0.0f);
  snapshot.humidity = dht.valid
    ? dht.humidity
    : (hasLastValidHumidity ? lastValidHumidity : 0.0f);
  snapshot.lightLux = isLightValid(lux) ? lux : 0.0f;
  snapshot.dustMgPerM3 = dust.densityMgPerM3;
  snapshot.mq135Raw = mq135.raw;
  snapshot.mq135AirQualityDeviation = mq135.airQualityDeviation;
  return snapshot;
}

int postJsonToEndpoint(const char* endpoint, const String& payload) {
  HTTPClient http;
  int statusCode = 0;

  if (String(endpoint).startsWith("https://")) {
    WiFiClientSecure secureClient;
    secureClient.setInsecure();
    http.begin(secureClient, endpoint);
    http.addHeader("Content-Type", "application/json");
    statusCode = http.POST(payload);
    http.end();
    return statusCode;
  }

  WiFiClient client;
  http.begin(client, endpoint);
  http.addHeader("Content-Type", "application/json");
  statusCode = http.POST(payload);
  http.end();
  return statusCode;
}

TinyMlUploadStatus uploadSensorReading(
  const char* timestamp,
  const SensorSnapshot& snapshot,
  const TinyMlInferenceResult& prediction
) {
  TinyMlUploadStatus status = {false, false, 0};
  if (!hasPredictionEndpointConfig() || WiFi.status() != WL_CONNECTED) {
    return status;
  }

  StaticJsonDocument<512> doc;
  doc["timestamp"] = timestamp;
  doc["zone"] = ZONE;
  doc["deviceId"] = DEVICE_ID;
  doc["temperature"] = snapshot.temperature;
  doc["humidity"] = snapshot.humidity;
  doc["lightLux"] = snapshot.lightLux;
  doc["dustMgPerM3"] = snapshot.dustMgPerM3;
  doc["mq135Raw"] = snapshot.mq135Raw;
  doc["mq135AirQualityDeviation"] = snapshot.mq135AirQualityDeviation;

  if (prediction.valid) {
    doc["predictedHumidity"] = prediction.predictedHumidity;
    doc["predictionHorizon"] = 1;
    doc["inferenceLatencyMs"] = prediction.inferenceLatencyMs;
    doc["modelVersion"] = prediction.modelVersion;
  }

  String payload;
  serializeJson(doc, payload);

  status.uploadAttempted = true;
  status.httpStatus = postJsonToEndpoint(SENSOR_INGEST_ENDPOINT, payload);
  status.uploadSucceeded = status.httpStatus >= 200 && status.httpStatus < 300;
  return status;
}

void publishSensorData(const SensorSnapshot& snapshot, float lux, const TinyMlInferenceResult& prediction) {
  if (!mqttClient.connected()) {
    return;
  }

  StaticJsonDocument<384> doc;
  doc["zone"] = ZONE;
  if (snapshot.valid) {
    doc["temperature"] = snapshot.temperature;
    doc["humidity"] = snapshot.humidity;
  }
  if (isLightValid(lux)) {
    doc["lightLux"] = lux;
  }
  doc["dustMgPerM3"] = snapshot.dustMgPerM3;
  doc["mq135Raw"] = snapshot.mq135Raw;
  doc["mq135AirQualityDeviation"] = snapshot.mq135AirQualityDeviation;
  if (prediction.valid) {
    doc["predictedHumidity"] = prediction.predictedHumidity;
  }

  char payload[384];
  serializeJson(doc, payload, sizeof(payload));
  mqttClient.publish(MQTT_TOPIC, payload);
}

void printSensorPayload(
  const DHTData& dht,
  const DustData& dust,
  float lux,
  const MQ135Data& mq135,
  const SensorSnapshot& snapshot,
  const TinyMlInferenceResult& prediction,
  const TinyMlUploadStatus& uploadStatus
) {
  StaticJsonDocument<1536> doc;
  char timestampBuffer[32];
  bool hasTimestamp = tryGetIsoTimestamp(timestampBuffer, sizeof(timestampBuffer));

  doc["deviceId"] = DEVICE_ID;
  doc["zone"] = ZONE;
  doc["uptimeMs"] = millis();
  if (hasTimestamp) {
    doc["timestamp"] = timestampBuffer;
  }

  if (snapshot.valid) {
    doc["temperature"] = snapshot.temperature;
    doc["humidity"] = snapshot.humidity;
  } else {
    doc["temperature"] = nullptr;
    doc["humidity"] = nullptr;
  }
  if (isLightValid(lux)) {
    doc["lightLux"] = lux;
  } else {
    doc["lightLux"] = nullptr;
  }
  doc["dustMgPerM3"] = snapshot.dustMgPerM3;
  doc["mq135Raw"] = snapshot.mq135Raw;
  doc["mq135AirQualityDeviation"] = snapshot.mq135AirQualityDeviation;
  doc["failedSensorCount"] = countFailingSensors(dht, lux, dust, mq135);

  JsonObject dht2 = doc["dht2"].to<JsonObject>();
  dht2["valid"] = dht.valid;
  if (dht.valid) {
    dht2["temperatureC"] = dht.temperatureC;
    dht2["humidity"] = dht.humidity;
  } else {
    dht2["temperatureC"] = nullptr;
    dht2["humidity"] = nullptr;
  }

  JsonObject dustJson = doc["dust"].to<JsonObject>();
  dustJson["raw"] = dust.raw;
  dustJson["voltage"] = dust.voltage;
  dustJson["densityMgPerM3"] = dust.densityMgPerM3;

  JsonObject lightJson = doc["light"].to<JsonObject>();
  if (isLightValid(lux)) {
    lightJson["lux"] = lux;
  } else {
    lightJson["lux"] = nullptr;
  }

  JsonObject mq135Json = doc["mq135"].to<JsonObject>();
  mq135Json["raw"] = mq135.raw;
  mq135Json["adcVoltage"] = mq135.adcVoltage;
  mq135Json["sensorVoltage"] = mq135.sensorVoltage;
  mq135Json["airQualityDeviation"] = mq135.airQualityDeviation;

  JsonObject sensorStatus = doc["sensorStatus"].to<JsonObject>();
  sensorStatus["dht2"] = dht.valid ? "ok" : "fail";
  sensorStatus["bh1750"] = isLightValid(lux) ? "ok" : "fail";
  sensorStatus["dust"] = isDustValid(dust) ? "ok" : "fail";
  sensorStatus["mq135"] = isMq135Valid(mq135) ? "ok" : "fail";

  JsonArray failingSensors = doc["failingSensors"].to<JsonArray>();
  if (!dht.valid) failingSensors.add("dht2");
  if (!isLightValid(lux)) failingSensors.add("bh1750");
  if (!isDustValid(dust)) failingSensors.add("dust");
  if (!isMq135Valid(mq135)) failingSensors.add("mq135");

  const bool windowReady = humidityInference.canInfer();
  const bool wifiConnected = WiFi.status() == WL_CONNECTED;
  const bool uploadConfigured = hasPredictionEndpointConfig();

  const char* tinyMlState = "collecting_window";
  if (!humidityInference.isEnabled()) {
    tinyMlState = "runtime_unavailable";
  } else if (!windowReady) {
    tinyMlState = "collecting_window";
  } else if (!prediction.valid) {
    tinyMlState = "inference_failed";
  } else if (!uploadConfigured) {
    tinyMlState = "upload_disabled";
  } else if (!wifiConnected) {
    tinyMlState = "wifi_disconnected";
  } else if (!uploadStatus.uploadAttempted) {
    tinyMlState = "prediction_ready";
  } else if (uploadStatus.uploadSucceeded) {
    tinyMlState = "uploaded";
  } else {
    tinyMlState = "upload_failed";
  }

  JsonObject tinyml = doc["tinyml"].to<JsonObject>();
  tinyml["enabled"] = humidityInference.isEnabled();
  tinyml["windowReady"] = windowReady;
  tinyml["bufferedReadings"] = humidityInference.bufferedCount();
  tinyml["requiredReadings"] = kHumidityWindowSize;
  tinyml["predictionValid"] = prediction.valid;
  if (prediction.valid) {
    tinyml["predictedHumidity"] = prediction.predictedHumidity;
    tinyml["inferenceLatencyMs"] = prediction.inferenceLatencyMs;
  } else {
    tinyml["predictedHumidity"] = nullptr;
    tinyml["inferenceLatencyMs"] = nullptr;
  }
  tinyml["wifiConnected"] = wifiConnected;
  tinyml["uploadConfigured"] = uploadConfigured;
  tinyml["uploadAttempted"] = uploadStatus.uploadAttempted;
  tinyml["uploadSucceeded"] = uploadStatus.uploadSucceeded;
  if (uploadStatus.uploadAttempted) {
    tinyml["httpStatus"] = uploadStatus.httpStatus;
  } else {
    tinyml["httpStatus"] = nullptr;
  }
  tinyml["modelVersion"] = prediction.modelVersion;
  tinyml["state"] = tinyMlState;

  JsonObject backendUpload = doc["backendUpload"].to<JsonObject>();
  backendUpload["configured"] = uploadConfigured;
  backendUpload["attempted"] = uploadStatus.uploadAttempted;
  backendUpload["succeeded"] = uploadStatus.uploadSucceeded;
  if (uploadStatus.uploadAttempted) {
    backendUpload["httpStatus"] = uploadStatus.httpStatus;
  } else {
    backendUpload["httpStatus"] = nullptr;
  }

  serializeJson(doc, Serial);
  Serial.println();
}

void setup() {
  Serial.begin(9600);
  delay(50);

  pinMode(DUST_LED_PIN, OUTPUT);
  digitalWrite(DUST_LED_PIN, HIGH);
  pinMode(DHT_PIN, INPUT_PULLUP);
  pinMode(MQ135_AO_PIN, INPUT);

  analogReadResolution(12);
  Wire.begin(21, 22);

  lightSensorReady = lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, 0x23, &Wire);
  tinyMlReady = humidityInference.begin();

  connectWiFiIfNeeded();
  mqttClient.setServer(MQTT_SERVER, MQTT_PORT);
  connectMQTTIfNeeded();

  lastSampleTime = millis() - SAMPLE_INTERVAL_MS;
}

void loop() {
  connectWiFiIfNeeded();
  connectMQTTIfNeeded();
  mqttClient.loop();

  unsigned long now = millis();
  if (now - lastSampleTime < SAMPLE_INTERVAL_MS) {
    return;
  }
  lastSampleTime = now;

  DHTData dht = readDHT22Averaged(DHT_PIN, 3);
  DustData dust = readDustAveraged(5);
  float lux = lightMeter.readLightLevel();
  MQ135Data mq135 = readMQ135Averaged(5);
  SensorSnapshot snapshot = buildSnapshot(dht, dust, lux, mq135);

  TinyMlInferenceResult prediction = {
    false,
    0.0f,
    0,
    tinyMlReady ? "tinyml-humidity-v1" : "tinyml-runtime-unavailable"
  };
  TinyMlUploadStatus uploadStatus = {false, false, 0};

  if (snapshot.valid && snapshot.hasFreshDht) {
    TinyMlReading reading = {
      snapshot.temperature,
      snapshot.humidity,
      isLightValid(lux) ? lux : 0.0f,
      snapshot.dustMgPerM3,
      snapshot.mq135AirQualityDeviation,
      (float)snapshot.mq135Raw
    };
    humidityInference.pushReading(reading);

    if (humidityInference.canInfer()) {
      prediction = humidityInference.predict();
      char timestampBuffer[32];
    }
  }

  char timestampBuffer[32];
  if (snapshot.valid && tryGetIsoTimestamp(timestampBuffer, sizeof(timestampBuffer))) {
    uploadStatus = uploadSensorReading(timestampBuffer, snapshot, prediction);
  }

  publishSensorData(snapshot, lux, prediction);
  printSensorPayload(dht, dust, lux, mq135, snapshot, prediction, uploadStatus);
}
