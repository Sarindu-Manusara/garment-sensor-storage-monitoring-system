/*
   ESP32 -> MongoDB serial bridge output with TinyML humidity forecasting
   ---------------------------------------------------------------------
   Sensors:
   1) DHT22 / AM2302 #1
   2) DHT22 / AM2302 #2
   3) GP2Y1010AU0F dust sensor
   4) BH1750FVI light intensity sensor
   5) MQ135 gas sensor

   Data flow:
   - Sensor readings continue to stream over serial for the Node.js ingestor.
   - The board keeps a rolling window for TinyML humidity forecasting.
   - When Wi-Fi, time sync, TensorFlow Lite Micro, and a trained model are available,
     the board can POST its local humidity prediction back to the backend.
*/

#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <Wire.h>
#include <BH1750.h>
#include <time.h>

#include "../../firmware/tinyml/humidity_inference.h"

#define DHT1_PIN       4
#define DHT2_PIN       5
#define DUST_LED_PIN   26
#define DUST_VO_PIN    34
#define MQ135_PIN      35

const char *DEVICE_ID = "esp32-garment-1";
const char *ZONE = "zone1";
const unsigned long REPORT_INTERVAL_MS = 30000;

const float ADC_REF_VOLTAGE = 3.3f;
const int ADC_MAX_VALUE = 4095;

const float DUST_SLOPE = 0.17f;
const float DUST_OFFSET = 0.10f;
const int MQ135_BASELINE_RAW = 2800;

const char *WIFI_SSID = "";
const char *WIFI_PASSWORD = "";
const char *PREDICTION_ENDPOINT = "";
const char *NTP_SERVER_1 = "pool.ntp.org";
const char *NTP_SERVER_2 = "time.nist.gov";

BH1750 lightMeter;
HumidityInferenceEngine humidityInference;

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
  float airQualityDeviation;
};

struct SensorSnapshot {
  bool valid;
  float temperature;
  float humidity;
  float lightLux;
  float dustMgPerM3;
  int mq135Raw;
  float mq135AirQualityDeviation;
};

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

bool readDHT22Single(uint8_t dhtPin, float &temperatureC, float &humidity) {
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

MQ135Data readMq135Averaged(int samples) {
  long sum = 0;
  for (int i = 0; i < samples; i++) {
    sum += analogRead(MQ135_PIN);
    delay(10);
  }

  MQ135Data data;
  data.raw = sum / samples;
  data.airQualityDeviation = ((float)data.raw - (float)MQ135_BASELINE_RAW) / (float)MQ135_BASELINE_RAW * 10.0f;
  return data;
}

bool hasWifiConfig() {
  return WIFI_SSID[0] != '\0' && WIFI_PASSWORD[0] != '\0';
}

void connectWifiIfConfigured() {
  if (!hasWifiConfig() || WiFi.status() == WL_CONNECTED) {
    return;
  }

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long startedAt = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - startedAt) < 15000) {
    delay(250);
  }
}

bool tryGetIsoTimestamp(char *buffer, size_t bufferSize) {
  struct tm timeInfo;
  if (!getLocalTime(&timeInfo, 100)) {
    return false;
  }

  strftime(buffer, bufferSize, "%Y-%m-%dT%H:%M:%SZ", &timeInfo);
  return true;
}

SensorSnapshot buildSnapshot(
  const DHTData &dht1,
  const DHTData &dht2,
  const DustData &dust,
  float lux,
  const MQ135Data &mq135
) {
  float temperatureSum = 0.0f;
  float humiditySum = 0.0f;
  int count = 0;

  if (dht1.valid) {
    temperatureSum += dht1.temperatureC;
    humiditySum += dht1.humidity;
    count++;
  }
  if (dht2.valid) {
    temperatureSum += dht2.temperatureC;
    humiditySum += dht2.humidity;
    count++;
  }

  SensorSnapshot snapshot;
  snapshot.valid = count > 0;
  snapshot.temperature = snapshot.valid ? temperatureSum / count : 0.0f;
  snapshot.humidity = snapshot.valid ? humiditySum / count : 0.0f;
  snapshot.lightLux = lux;
  snapshot.dustMgPerM3 = dust.densityMgPerM3;
  snapshot.mq135Raw = mq135.raw;
  snapshot.mq135AirQualityDeviation = mq135.airQualityDeviation;
  return snapshot;
}

void printDHTJson(const char *label, const DHTData &data) {
  Serial.print("\"");
  Serial.print(label);
  Serial.print("\":{");
  Serial.print("\"valid\":");
  Serial.print(data.valid ? "true" : "false");
  Serial.print(",\"temperatureC\":");
  if (data.valid) {
    Serial.print(data.temperatureC, 1);
  } else {
    Serial.print("null");
  }
  Serial.print(",\"humidity\":");
  if (data.valid) {
    Serial.print(data.humidity, 1);
  } else {
    Serial.print("null");
  }
  Serial.print("}");
}

void printDustJson(const DustData &data) {
  Serial.print("\"dust\":{");
  Serial.print("\"raw\":");
  Serial.print(data.raw);
  Serial.print(",\"voltage\":");
  Serial.print(data.voltage, 3);
  Serial.print(",\"densityMgPerM3\":");
  Serial.print(data.densityMgPerM3, 3);
  Serial.print("}");
}

void printLightJson(float lux) {
  Serial.print("\"light\":{");
  Serial.print("\"lux\":");
  if (lux < 0) {
    Serial.print("null");
  } else {
    Serial.print(lux, 1);
  }
  Serial.print("}");
}

void printMq135Json(const MQ135Data &data) {
  Serial.print("\"mq135\":{");
  Serial.print("\"raw\":");
  Serial.print(data.raw);
  Serial.print(",\"airQualityDeviation\":");
  Serial.print(data.airQualityDeviation, 6);
  Serial.print("}");
}

void printSensorPayload(
  const DHTData &dht1,
  const DHTData &dht2,
  const DustData &dust,
  float lux,
  const MQ135Data &mq135,
  const SensorSnapshot &snapshot
) {
  char timestampBuffer[32];
  bool hasTimestamp = tryGetIsoTimestamp(timestampBuffer, sizeof(timestampBuffer));

  Serial.print("{");
  Serial.print("\"deviceId\":\"");
  Serial.print(DEVICE_ID);
  Serial.print("\",\"zone\":\"");
  Serial.print(ZONE);
  Serial.print("\",\"uptimeMs\":");
  Serial.print(millis());
  if (hasTimestamp) {
    Serial.print(",\"timestamp\":\"");
    Serial.print(timestampBuffer);
    Serial.print("\"");
  }
  Serial.print(",\"temperature\":");
  Serial.print(snapshot.valid ? snapshot.temperature : 0.0f, 2);
  Serial.print(",\"humidity\":");
  Serial.print(snapshot.valid ? snapshot.humidity : 0.0f, 2);
  Serial.print(",\"lightLux\":");
  Serial.print(snapshot.lightLux, 1);
  Serial.print(",\"dustMgPerM3\":");
  Serial.print(snapshot.dustMgPerM3, 3);
  Serial.print(",\"mq135Raw\":");
  Serial.print(snapshot.mq135Raw);
  Serial.print(",\"mq135AirQualityDeviation\":");
  Serial.print(snapshot.mq135AirQualityDeviation, 6);
  Serial.print(",");
  printDHTJson("dht1", dht1);
  Serial.print(",");
  printDHTJson("dht2", dht2);
  Serial.print(",");
  printDustJson(dust);
  Serial.print(",");
  printLightJson(lux);
  Serial.print(",");
  printMq135Json(mq135);
  Serial.println("}");
}

void uploadTinyMlPrediction(const char *timestamp, const TinyMlInferenceResult &prediction) {
  if (PREDICTION_ENDPOINT[0] == '\0' || WiFi.status() != WL_CONNECTED) {
    return;
  }

  HTTPClient http;
  http.begin(PREDICTION_ENDPOINT);
  http.addHeader("Content-Type", "application/json");

  String payload = "{";
  payload += "\"timestamp\":\"";
  payload += timestamp;
  payload += "\",\"zone\":\"";
  payload += ZONE;
  payload += "\",\"predictedHumidity\":";
  payload += String(prediction.predictedHumidity, 2);
  payload += ",\"predictionHorizon\":1,\"inferenceLatencyMs\":";
  payload += String(prediction.inferenceLatencyMs);
  payload += ",\"modelVersion\":\"";
  payload += prediction.modelVersion;
  payload += "\"}";

  http.POST(payload);
  http.end();
}

void setup() {
  Serial.begin(9600);
  delay(50);

  pinMode(DUST_LED_PIN, OUTPUT);
  digitalWrite(DUST_LED_PIN, HIGH);

  pinMode(DHT1_PIN, INPUT_PULLUP);
  pinMode(DHT2_PIN, INPUT_PULLUP);
  pinMode(MQ135_PIN, INPUT);

  analogReadResolution(12);
  Wire.begin(21, 22);

  lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, 0x23, &Wire);
  humidityInference.begin();

  connectWifiIfConfigured();
  if (WiFi.status() == WL_CONNECTED) {
    configTime(0, 0, NTP_SERVER_1, NTP_SERVER_2);
  }
}

void loop() {
  connectWifiIfConfigured();

  DustData dust = readDustAveraged(5);
  DHTData dht1 = readDHT22Averaged(DHT1_PIN, 1);
  DHTData dht2 = readDHT22Averaged(DHT2_PIN, 1);
  float lux = lightMeter.readLightLevel();
  MQ135Data mq135 = readMq135Averaged(5);
  SensorSnapshot snapshot = buildSnapshot(dht1, dht2, dust, lux, mq135);

  printSensorPayload(dht1, dht2, dust, lux, mq135, snapshot);

  if (snapshot.valid) {
    TinyMlReading reading = {
      snapshot.temperature,
      snapshot.humidity,
      snapshot.lightLux,
      snapshot.dustMgPerM3,
      snapshot.mq135AirQualityDeviation,
      (float)snapshot.mq135Raw
    };
    humidityInference.pushReading(reading);

    if (humidityInference.canInfer()) {
      TinyMlInferenceResult prediction = humidityInference.predict();
      char timestampBuffer[32];
      if (prediction.valid && tryGetIsoTimestamp(timestampBuffer, sizeof(timestampBuffer))) {
        uploadTinyMlPrediction(timestampBuffer, prediction);
      }
    }
  }

  delay(REPORT_INTERVAL_MS);
}
