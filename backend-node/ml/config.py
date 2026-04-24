from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "backend"
ML_ROOT = BACKEND_ROOT / "ml"
ARTIFACTS_ROOT = PROJECT_ROOT / "artifacts"
TINYML_ARTIFACTS_DIR = ARTIFACTS_ROOT / "tinyml"
BACKEND_ARTIFACTS_DIR = ARTIFACTS_ROOT / "backend"
MODELS_DIR = ML_ROOT / "models"
TRAINING_DIR = ML_ROOT / "training"
INFERENCE_DIR = ML_ROOT / "inference"
FIRMWARE_TINYML_DIR = PROJECT_ROOT / "firmware" / "tinyml"

DEFAULT_BACKEND_DATASET_PATH = PROJECT_ROOT / "labeled_garment_dataset.csv"
DEFAULT_SENSOR_DATABASE = "garment_monitoring"
DEFAULT_SENSOR_COLLECTION = "sensor_readings"
DEFAULT_SENSOR_FEATURES = [
    "temperature",
    "humidity",
    "lightLux",
    "dustMgPerM3",
    "mq135AirQualityDeviation",
    "mq135Raw",
    "timestamp",
    "zone",
]

ANOMALY_FEATURE_COLUMNS = [
    "temperature_c",
    "humidity_pct",
    "light_lux",
    "dust_proxy",
    "gas_proxy",
    "humidity_delta",
    "dust_delta",
    "gas_delta",
    "humidity_pct_z",
    "dust_proxy_z",
    "gas_proxy_z",
    "humidity_pct_roll_std",
    "dust_proxy_roll_std",
    "gas_proxy_roll_std",
    "hour_of_day",
    "day_of_week",
]

WARNING_FEATURE_COLUMNS = [
    "temperature_c",
    "humidity_pct",
    "light_lux",
    "dust_proxy",
    "gas_proxy",
    "humidity_delta",
    "dust_delta",
    "gas_delta",
    "humidity_pct_roll_mean",
    "dust_proxy_roll_mean",
    "gas_proxy_roll_mean",
    "humidity_pct_roll_std",
    "dust_proxy_roll_std",
    "gas_proxy_roll_std",
    "humidity_pct_z",
    "dust_proxy_z",
    "gas_proxy_z",
    "hour_of_day",
    "day_of_week",
    "anomaly_score_from_pipeline",
    "anomaly_flag_from_pipeline",
]

TINYML_FEATURE_COLUMNS = [
    "temperature",
    "humidity",
    "lightLux",
    "dustMgPerM3",
    "mq135AirQualityDeviation",
]

DEFAULT_TINYML_WINDOW_SIZE = 12
DEFAULT_TINYML_HORIZON = 1
DEFAULT_TINYML_RESAMPLE_RULE = "5min"
DEFAULT_TINYML_SIZE_BUDGET_BYTES = 32 * 1024


def ensure_directories() -> None:
    for directory in (
        TINYML_ARTIFACTS_DIR,
        BACKEND_ARTIFACTS_DIR,
        MODELS_DIR,
        FIRMWARE_TINYML_DIR,
    ):
        directory.mkdir(parents=True, exist_ok=True)

