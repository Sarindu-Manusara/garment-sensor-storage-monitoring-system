/*
   ESP32 Integrated Test + MQTT Publish
   ------------------------------------
   Sensors:
   1) DHT22 / AM2302
   2) GP2Y1010AU0F dust sensor
   3) BH1750FVI Light Intensity Sensor
   4) MQ-135 Gas Sensor

   Pins:
   DHT22 DATA      -> GPIO 5
   Dust LED CTRL   -> GPIO 26
   Dust VO         -> GPIO 34
   MQ-135 AO       -> GPIO 32 (via voltage divider)

   BH1750 (I2C)
   SDA -> GPIO 21
   SCL -> GPIO 22
*/

#include <Arduino.h>
#include <Wire.h>
#include <BH1750.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include "secrets.h"

// =======================
// Wi-Fi / MQTT settings
// =======================
const char* WIFI_SSID     = ""; //add wifi ssid here
const char* WIFI_PASSWORD = ""; //add wifi password here

const char* MQTT_SERVER   = "broker.hivemq.com";
const int   MQTT_PORT     = 1883;
const char* MQTT_USERNAME = "";
const char* MQTT_PASSWORD = "";
const char* MQTT_TOPIC    = "maochi-streetwear/garment-storage/zone1/readings";

// =======================
// Pin configuration
// =======================
#define DHT2_PIN      5
#define DUST_LED_PIN  26
#define DUST_VO_PIN   34
#define MQ135_AO_PIN  32

// =======================
// ADC / timing configuration
// =======================
const float ADC_REF_VOLTAGE = 3.3f;
const int   ADC_MAX_VALUE   = 4095;

// MQ-135 voltage divider correction
const float MQ135_DIVIDER_RATIO = 2.0f;

// MQ-135 clean-air baseline
const int MQ135_BASELINE_RAW = 2770;

// Dust conversion constants
const float DUST_SLOPE  = 0.17f;
const float DUST_OFFSET = 0.10f;

// Sampling interval
const unsigned long SAMPLE_INTERVAL_MS = 5000UL;
unsigned long lastSampleTime = 0;

// =======================
// Global objects
// =======================
BH1750 lightMeter;
WiFiClient espClient;
PubSubClient mqttClient(espClient);

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
  int   raw;
  float adcVoltage;
  float sensorVoltage;
  float airQualityDeviation;
};

// Store last valid DHT values
float lastValidTemperature = 0.0f;
float lastValidHumidity    = 0.0f;
bool hasLastValidTemperature = false;
bool hasLastValidHumidity    = false;

// =======================
// Utility functions
// =======================
float rawToVoltage(int raw) {
  return (raw * ADC_REF_VOLTAGE) / ADC_MAX_VALUE;
}

uint32_t waitForStateChange(uint8_t pin, uint8_t state, uint32_t timeoutUs) {
  uint32_t start = micros();
  while (digitalRead(pin) == state) {
    if ((micros() - start) > timeoutUs) return 0;
  }
  return micros() - start;
}

// =======================
// Wi-Fi / MQTT functions
// =======================
void connectWiFi() {
  Serial.print("Connecting to WiFi");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();
  Serial.println("WiFi connected");
  Serial.print("IP address: ");
  Serial.println(WiFi.localIP());
}

void connectMQTT() {
  while (!mqttClient.connected()) {
    Serial.print("Connecting to MQTT...");

    String clientId = "ESP32-GarmentMonitor-";
    clientId += String((uint32_t)random(0xffff), HEX);

    bool connected;
    if (strlen(MQTT_USERNAME) > 0) {
      connected = mqttClient.connect(clientId.c_str(), MQTT_USERNAME, MQTT_PASSWORD);
    } else {
      connected = mqttClient.connect(clientId.c_str());
    }

    if (connected) {
      Serial.println("connected");
    } else {
      Serial.print("failed, rc=");
      Serial.print(mqttClient.state());
      Serial.println(" retrying in 5 seconds");
      delay(5000);
    }
  }
}

// =======================
// DHT22 functions
// =======================
bool readDHT22Single(uint8_t dhtPin, float &temperatureC, float &humidity) {
  uint8_t data[5] = {0, 0, 0, 0, 0};

  pinMode(dhtPin, OUTPUT);
  digitalWrite(dhtPin, LOW);
  delay(2);
  digitalWrite(dhtPin, HIGH);
  delayMicroseconds(30);

  pinMode(dhtPin, INPUT_PULLUP);

  if (waitForStateChange(dhtPin, HIGH, 100) == 0) return false;
  if (waitForStateChange(dhtPin, LOW, 100)  == 0) return false;
  if (waitForStateChange(dhtPin, HIGH, 100) == 0) return false;

  for (int i = 0; i < 40; i++) {
    if (waitForStateChange(dhtPin, LOW, 70) == 0) return false;

    uint32_t highTime = waitForStateChange(dhtPin, HIGH, 120);
    if (highTime == 0) return false;

    data[i / 8] <<= 1;
    if (highTime > 40) data[i / 8] |= 1;
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
  float tempSum  = 0;
  float humSum   = 0;
  int validCount = 0;

  for (int i = 0; i < samples; i++) {
    float t = 0, h = 0;
    if (readDHT22Single(dhtPin, t, h)) {
      tempSum += t;
      humSum  += h;
      validCount++;
    }
    if (i < samples - 1) delay(20);
  }

  DHTData result;
  if (validCount == 0) {
    result.valid = false;
  } else {
    result.temperatureC = tempSum / validCount;
    result.humidity     = humSum / validCount;
    result.valid        = true;
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

  int avgRaw    = sum / samples;
  float voltage = rawToVoltage(avgRaw);
  float density = DUST_SLOPE * voltage - DUST_OFFSET;
  if (density < 0) density = 0;

  DustData data;
  data.raw            = avgRaw;
  data.voltage        = voltage;
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
    if (i < samples - 1) delay(5);
  }

  int avgRaw          = sum / samples;
  float adcVoltage    = rawToVoltage(avgRaw);
  float sensorVoltage = adcVoltage * MQ135_DIVIDER_RATIO;
  float airQualityDeviation = ((float)(avgRaw - MQ135_BASELINE_RAW) / (float)MQ135_BASELINE_RAW) * 100.0f;

  MQ135Data data;
  data.raw                 = avgRaw;
  data.adcVoltage          = adcVoltage;
  data.sensorVoltage       = sensorVoltage;
  data.airQualityDeviation = airQualityDeviation;
  return data;
}

// =======================
// Print functions
// =======================
void printDivider() {
  Serial.println("--------------------------------------------------");
}

void printDHTData(const DHTData &data) {
  Serial.println("[DHT22 Temperature and Humidity Sensor]");

  if (data.valid) {
    lastValidTemperature    = data.temperatureC;
    lastValidHumidity       = data.humidity;
    hasLastValidTemperature = true;
    hasLastValidHumidity    = true;
  }

  if (hasLastValidTemperature) {
    Serial.print("Temperature: ");
    Serial.print(lastValidTemperature, 1);
    Serial.println(" C");
  } else {
    Serial.println("Temperature: FAILED");
  }

  if (hasLastValidHumidity) {
    Serial.print("Humidity   : ");
    Serial.print(lastValidHumidity, 2);
    Serial.println(" %");
  } else {
    Serial.println("Humidity   : FAILED");
  }
}

void printDustData(const DustData &data) {
  Serial.println("[Dust Sensor]");
  Serial.print("Dust Output Voltage: ");
  Serial.print(data.voltage, 3);
  Serial.println(" V");
  Serial.print("Dust Density Est.  : ");
  Serial.print(data.densityMgPerM3, 3);
  Serial.println(" mg/m^3");
}

void printLightData(float lux) {
  Serial.println("[BH1750 Light Sensor]");
  Serial.print("Light Intensity: ");
  Serial.print(lux);
  Serial.println(" lx");
}

void printMQ135Data(const MQ135Data &data) {
  Serial.println("[MQ-135 Gas Sensor]");
  Serial.print("Raw ADC Value    : ");
  Serial.println(data.raw);
  Serial.print("ADC Voltage      : ");
  Serial.print(data.adcVoltage, 3);
  Serial.println(" V  (at GPIO 32)");
  Serial.print("Sensor AO Voltage: ");
  Serial.print(data.sensorVoltage, 3);
  Serial.println(" V  (actual, after divider correction)");
  Serial.print("Air Quality Dev. : ");
  Serial.print(data.airQualityDeviation, 2);
  Serial.println(" %  (deviation from clean-air baseline)");
}

// =======================
// MQTT publish function
// =======================
void publishSensorData(const DHTData &dht2, const DustData &dust, float lux, const MQ135Data &mq135) {
  StaticJsonDocument<256> doc;

  doc["zone"] = "zone1";

  if (dht2.valid) {
    doc["temperature"] = dht2.temperatureC;
    doc["humidity"] = dht2.humidity;
  } else {
    if (hasLastValidTemperature) doc["temperature"] = lastValidTemperature;
    if (hasLastValidHumidity)    doc["humidity"]    = lastValidHumidity;
  }

  doc["lightLux"] = lux;
  doc["dustMgPerM3"] = dust.densityMgPerM3;
  doc["mq135Raw"] = mq135.raw;
  doc["mq135AirQualityDeviation"] = mq135.airQualityDeviation;

  char payload[256];
  serializeJson(doc, payload);

  bool ok = mqttClient.publish(MQTT_TOPIC, payload);

  if (ok) {
    Serial.println("Published to MQTT:");
    Serial.println(payload);
  } else {
    Serial.println("MQTT publish failed");
  }
}

// =======================
// Setup
// =======================
void setup() {
  Serial.begin(9600);
  delay(50);
  Serial.println();

  pinMode(DUST_LED_PIN, OUTPUT);
  digitalWrite(DUST_LED_PIN, HIGH);

  pinMode(DHT2_PIN, INPUT_PULLUP);

  Serial.println("MQ-135: Allow 2 min warm-up for stable readings.");

  analogReadResolution(12);

  Wire.begin(21, 22);
  delay(200);

  if (lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE)) {
    Serial.println("BH1750 Initialized");
  } else {
    Serial.println("BH1750 Initialization Failed");
  }

  connectWiFi();
  mqttClient.setServer(MQTT_SERVER, MQTT_PORT);

  printDivider();
  Serial.println("Setup complete.");
  printDivider();

  lastSampleTime = millis() - SAMPLE_INTERVAL_MS;
}

// =======================
// Loop
// =======================
void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  if (!mqttClient.connected()) {
    connectMQTT();
  }
  mqttClient.loop();

  unsigned long now = millis();

  if (now - lastSampleTime >= SAMPLE_INTERVAL_MS) {
    lastSampleTime = now;

    DustData  dust  = readDustAveraged(5);
    DHTData   dht2  = readDHT22Averaged(DHT2_PIN, 3);
    MQ135Data mq135 = readMQ135Averaged(5);
    float     lux   = lightMeter.readLightLevel();

    printDivider();
    Serial.println("Integrated Sensor Report");

    printDustData(dust);
    Serial.println();

    printLightData(lux);
    Serial.println();

    printDHTData(dht2);
    Serial.println();

    printMQ135Data(mq135);
    Serial.println();

    publishSensorData(dht2, dust, lux, mq135);
    Serial.println();
  }
}