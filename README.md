# Garment Storage Monitoring System

This repository now includes the three ML flows wired into the existing Node/React/Arduino stack:

- ESP32-side TinyML humidity forecasting with firmware export targets
- Backend anomaly detection from the labeled public dataset
- Backend warning-level classification from the labeled public dataset
- Website chatbot grounded in live sensor data, ML outputs, and local project docs
- Optional WhatsApp alerting through WAAPI when live health reaches warning or danger

## Repository layout

- `src/`: Node ingestion + API server
- `frontend/`: React dashboard
- `backend/ml/`: Python training and inference workspace
- `firmware/tinyml/`: firmware-side TinyML headers and inference wrapper
- `arduino/esp32_mongo_ready/`: ESP32 sketch
- `artifacts/tinyml/`: exported TinyML artifacts
- `artifacts/backend/`: backend ML reports

## Sensor schema

The backend normalizes live readings to the ML-ready schema below and preserves legacy aliases for the existing UI:

```json
{
  "zone": "zone1",
  "temperature": 31.8,
  "humidity": 68.9,
  "lightLux": 62.5,
  "dustMgPerM3": 0.12988,
  "mq135Raw": 2831,
  "mq135AirQualityDeviation": 2.202166,
  "timestamp": "2026-04-21T10:54:10.605Z"
}
```

## API routes

- `GET /api/readings/latest`
- `GET /api/readings/recent?limit=10`
- `GET /api/dashboard?zone=zone1&limit=10`
- `POST /api/ml/anomaly-warning/infer`
- `POST /api/ml/tinyml-prediction`
- `GET /api/ml/latest?zone=zone1`
- `GET /api/ml/history?from=...&to=...&zone=zone1`
- `POST /api/chat/message`
- `GET /api/chat/history?conversationId=...`
- `DELETE /api/chat/history?conversationId=...`

## Environment variables

See `.env.example`.

Required:

- `MONGODB_URI`
- `SERIAL_PORT` for ingestion

Common runtime variables:

- `MONGODB_SENSOR_DATABASE`
- `MONGODB_SENSOR_COLLECTION`
- `MONGODB_ML_COLLECTION`
- `MONGODB_CHAT_COLLECTION`
- `MONGODB_ALERT_COLLECTION`
- `API_PORT`
- `ZONE`
- `PYTHON_BIN`
- `MQ135_BASELINE_RAW`
- `BACKEND_MODEL_VERSION`
- `TINYML_MODEL_VERSION`
- `PUBLIC_DASHBOARD_URL`
- `LIVE_ML_MONITOR_ENABLED`
- `LIVE_ML_MONITOR_INTERVAL_MS`
- `CHAT_LLM_PROVIDER`
- `CHAT_LLM_API_KEY`
- `CHAT_LLM_BASE_URL`
- `CHAT_LLM_MODEL`
- `CHAT_LLM_TIMEOUT_MS`
- `WAAPI_ENABLED`
- `WAAPI_BASE_URL`
- `WAAPI_INSTANCE_ID`
- `WAAPI_API_TOKEN`
- `WAAPI_CHAT_IDS`
- `WAAPI_RECIPIENT_PHONES`
- `WAAPI_ALERT_COOLDOWN_MINUTES`
- `WAAPI_SEND_WARNING_ALERTS`
- `WAAPI_SEND_DANGER_ALERTS`
- `VITE_API_BASE_URL` for a separately hosted frontend build

The chatbot works with `CHAT_LLM_PROVIDER=local` by default, which keeps responses deterministic and grounded in backend tool outputs. If you want an external OpenAI-compatible LLM to rewrite the final answer text, set `CHAT_LLM_PROVIDER`, `CHAT_LLM_API_KEY`, `CHAT_LLM_BASE_URL`, and `CHAT_LLM_MODEL`.

If Python inference is enabled, `PYTHON_BIN` should point to a valid Python executable. The backend now tries the configured command first, then falls back to common commands such as `python` and `python3` when possible.

## WhatsApp alerts with WAAPI

The backend can now watch new sensor readings in MongoDB, run the existing ML inference pipeline, store/update `ml_predictions`, and send WhatsApp alerts through WAAPI when the latest health state becomes `warning` or `danger`.

Minimal setup:

1. Set `WAAPI_ENABLED=true`
2. Set `WAAPI_INSTANCE_ID`
3. Set `WAAPI_API_TOKEN`
4. Configure recipients with either `WAAPI_CHAT_IDS` or `WAAPI_RECIPIENT_PHONES`
5. Set `LIVE_ML_MONITOR_ENABLED=true` only if you also want the backend to run the optional ML polling loop

Alert behavior:

- `warningLevel=medium` maps to a warning alert
- `warningLevel=high` maps to a danger alert
- if no stored warning level exists, the backend falls back to configured sensor thresholds and anomaly score
- repeated alerts for the same zone and same severity are deduplicated for `WAAPI_ALERT_COOLDOWN_MINUTES`

The monitor runs inside `npm run server` only when `LIVE_ML_MONITOR_ENABLED=true`, so the default backend behavior stays focused on serving MongoDB data to the frontend.

## GitHub Pages deployment

GitHub Pages can host the React frontend only. It cannot run the Node/Express API, MongoDB bridge, or serial ingestion process. For a working public dashboard you must:

1. Host the backend API on a public HTTPS URL.
2. Set the GitHub repository variable `VITE_API_BASE_URL` to that backend URL.
3. Enable GitHub Pages in repository settings and choose GitHub Actions as the source.

This repository now includes [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml), which:

- builds the Vite frontend
- sets the correct Vite `base` path for GitHub Pages
- deploys `frontend/dist` to GitHub Pages

The frontend uses `VITE_API_BASE_URL` when provided and falls back to same-origin `/api` during local development.

## Install

1. Run `npm install`
2. Install Python ML dependencies with `py -m pip install -r requirements-ml.txt`

## Run the app

Backend API:

```bash
npm run server
```

The frontend dashboard now reads its main sensor view from `GET /api/dashboard`, which pulls the latest and recent sensor readings directly from MongoDB for the selected zone.

Frontend dev server:

```bash
npm run client
```

The dashboard now includes a floating chat widget for live questions such as:

- `What is the current humidity in zone1?`
- `How many anomalies happened today?`
- `Show humidity trend for today`
- `Why is zone1 warning level high?`
- `Show predicted vs actual humidity`

Serial ingestion:

```bash
npm run ingest
```

Full dev mode:

```bash
npm run dev
```

## Train backend models

The labeled dataset file is expected at the repo root as `labeled_garment_dataset.csv`.

```bash
npm run train:backend:ml
```

This writes:

- `backend/ml/models/anomaly_model.joblib`
- `backend/ml/models/warning_model.joblib`
- `backend/ml/models/feature_columns.json`
- `backend/ml/models/backend_ml_report.json`
- `artifacts/backend/backend_ml_report.json`

## Train TinyML humidity model

Train from MongoDB:

```bash
npm run train:tinyml
```

Train from a CSV export instead:

```bash
py backend/ml/training/train_tinyml_humidity.py --csv sensor_readings.csv
```

This writes:

- `artifacts/tinyml/humidity_model.tflite`
- `artifacts/tinyml/normalization.json`
- `artifacts/tinyml/tinyml_report.json`
- `firmware/tinyml/humidity_model.h`
- `firmware/tinyml/humidity_scaler.h`

## Evaluate backend artifacts

```bash
npm run evaluate:ml
```

## Tests

```bash
npm run smoke
npm test
```

## Firmware

The ESP32 sketch remains in `arduino/esp32_mongo_ready/esp32_mongo_ready.ino`.

It now:

- streams sensor readings over serial
- emits MQ135 gas-proxy data
- keeps a rolling TinyML input window
- runs local humidity inference when a trained model and TensorFlow Lite Micro are available
- optionally uploads predictions to `POST /api/ml/tinyml-prediction`

Build notes:

- `firmware/tinyml/humidity_model.h` and `humidity_scaler.h` ship as placeholders until TinyML training is run
- TensorFlow Lite Micro must be installed in the Arduino environment before on-device inference can compile
- Wi-Fi credentials and `PREDICTION_ENDPOINT` must be filled in inside the sketch before ESP32 uploads are enabled

Typical Arduino CLI command:

```bash
arduino-cli compile --fqbn esp32:esp32:esp32 arduino/esp32_mongo_ready
```

Typical upload command:

```bash
arduino-cli upload -p COM5 --fqbn esp32:esp32:esp32 arduino/esp32_mongo_ready
```

## Manual steps still required

- Put the real `labeled_garment_dataset.csv` file at the repo root if it is not already present
- Install TensorFlow for the TinyML training script if it is not already available
- Install TensorFlow Lite Micro in the Arduino environment
- Configure Wi-Fi credentials and prediction endpoint in the ESP32 sketch if device-side uploads are required
