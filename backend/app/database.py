from pymongo import MongoClient
from dotenv import load_dotenv
import os
import certifi

load_dotenv()

MONGODB_URI = os.getenv("MONGODB_URI")
DATABASE_NAME = os.getenv("DATABASE_NAME", "garment_monitoring")
COLLECTION_NAME = os.getenv("COLLECTION_NAME", "sensor_readings")

client = MongoClient(
    MONGODB_URI,
    tls=True,
    tlsCAFile=certifi.where()
)

db = client[DATABASE_NAME]
sensor_collection = db[COLLECTION_NAME]