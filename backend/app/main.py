from fastapi import FastAPI
from app.database import client
from app.mqtt_client import start_mqtt
from bson import ObjectId
from app.database import sensor_collection

app = FastAPI()
mqtt_client = None

def serialize_doc(doc):
    doc["_id"] = str(doc["_id"])
    if "timestamp" in doc:
        doc["timestamp"] = doc["timestamp"].isoformat()
    return doc

@app.get("/readings")
def get_readings():
    readings = list(sensor_collection.find().sort("timestamp", -1).limit(20))
    return [serialize_doc(doc) for doc in readings]

@app.on_event("startup")
def startup_event():
    global mqtt_client
    mqtt_client = start_mqtt()

@app.get("/")
def root():
    return {"message": "FastAPI backend is running"}

@app.get("/db-test")
def db_test():
    try:
        client.admin.command("ping")
        return {"status": "success", "message": "MongoDB connected successfully"}
    except Exception as e:
        return {"status": "error", "message": str(e)}