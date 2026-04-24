import os
import json
from dotenv import load_dotenv
import paho.mqtt.client as mqtt
from app.database import sensor_collection
from datetime import datetime, timezone

load_dotenv()

MQTT_BROKER = os.getenv("MQTT_BROKER")
MQTT_PORT = int(os.getenv("MQTT_PORT", 1883))
MQTT_USERNAME = os.getenv("MQTT_USERNAME")
MQTT_PASSWORD = os.getenv("MQTT_PASSWORD")
MQTT_TOPIC = os.getenv("MQTT_TOPIC")

def on_connect(client, userdata, flags, rc):
    if rc == 0:
        print("Connected to MQTT broker")
        client.subscribe(MQTT_TOPIC)
        print(f"Subscribed to topic: {MQTT_TOPIC}")
    else:
        print(f"Failed to connect to MQTT broker, rc={rc}")

def on_message(client, userdata, msg):
    try:
        payload = json.loads(msg.payload.decode())
        payload["timestamp"] = datetime.now(timezone.utc)
        
        sensor_collection.insert_one(payload)
        print("Inserted reading into MongoDB:", payload)
    except Exception as e:
        print("Error processing MQTT message:", e)

def start_mqtt():
    client = mqtt.Client()

    if MQTT_USERNAME and MQTT_PASSWORD:
        client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)

    client.on_connect = on_connect
    client.on_message = on_message

    client.connect(MQTT_BROKER, MQTT_PORT, 60)
    client.loop_start()

    return client