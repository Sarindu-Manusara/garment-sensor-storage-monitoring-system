from __future__ import annotations

import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

CURRENT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = CURRENT_DIR.parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.ml.config import (  # noqa: E402
    DEFAULT_SENSOR_COLLECTION,
    DEFAULT_SENSOR_DATABASE,
    DEFAULT_TINYML_HORIZON,
    DEFAULT_TINYML_RESAMPLE_RULE,
    DEFAULT_TINYML_SIZE_BUDGET_BYTES,
    DEFAULT_TINYML_WINDOW_SIZE,
    FIRMWARE_TINYML_DIR,
    TINYML_ARTIFACTS_DIR,
    TINYML_FEATURE_COLUMNS,
    ensure_directories,
)
from backend.ml.utils import build_humidity_sequences, write_json  # noqa: E402
from scripts.export_tflite_to_header import convert_tflite_to_header  # noqa: E402


def require_tensorflow():
    try:
        import tensorflow as tf  # type: ignore
    except ImportError as error:
        raise SystemExit(
            "TensorFlow is required for TinyML training. Install it with `py -m pip install tensorflow`."
        ) from error
    return tf


def load_sensor_frame(args) -> pd.DataFrame:
    if args.csv:
        frame = pd.read_csv(args.csv)
    else:
        try:
            from pymongo import MongoClient
        except ImportError as error:
            raise SystemExit(
                "pymongo is required to train TinyML directly from MongoDB. Install it with `py -m pip install pymongo`."
            ) from error

        mongodb_uri = args.mongodb_uri or os.getenv("MONGODB_URI")
        if not mongodb_uri:
            raise SystemExit("Provide --mongodb-uri or set MONGODB_URI.")

        database_name = args.database or DEFAULT_SENSOR_DATABASE
        collection_name = args.collection or DEFAULT_SENSOR_COLLECTION
        client = MongoClient(mongodb_uri)
        try:
            documents = list(
                client[database_name][collection_name].find(
                    {},
                    {
                        "_id": 0,
                        "zone": 1,
                        "temperature": 1,
                        "humidity": 1,
                        "lightLux": 1,
                        "light": 1,
                        "dustMgPerM3": 1,
                        "dust": 1,
                        "mq135Raw": 1,
                        "mq135AirQualityDeviation": 1,
                        "timestamp": 1,
                    },
                )
            )
        finally:
            client.close()
        frame = pd.DataFrame(documents)

    if frame.empty:
        raise SystemExit("No sensor readings were found for TinyML training.")

    aliases = {
        "temperature": ["temperature"],
        "humidity": ["humidity"],
        "lightLux": ["lightLux", "light"],
        "dustMgPerM3": ["dustMgPerM3", "dust"],
        "mq135AirQualityDeviation": ["mq135AirQualityDeviation"],
        "mq135Raw": ["mq135Raw"],
    }

    for canonical, options in aliases.items():
        if canonical not in frame.columns:
            for option in options:
                if option in frame.columns:
                    frame[canonical] = frame[option]
                    break
            else:
                frame[canonical] = np.nan

    frame["timestamp"] = pd.to_datetime(frame.get("timestamp"), utc=True, errors="coerce")
    frame = frame.dropna(subset=["timestamp", "temperature", "humidity", "lightLux", "dustMgPerM3"])
    frame = frame.sort_values("timestamp").drop_duplicates(subset=["timestamp", "zone"], keep="last")
    frame["mq135AirQualityDeviation"] = pd.to_numeric(frame["mq135AirQualityDeviation"], errors="coerce").fillna(0.0)
    frame["mq135Raw"] = pd.to_numeric(frame["mq135Raw"], errors="coerce")

    rule = args.resample or DEFAULT_TINYML_RESAMPLE_RULE
    frame = frame.set_index("timestamp").sort_index()
    numeric_columns = ["temperature", "humidity", "lightLux", "dustMgPerM3", "mq135AirQualityDeviation", "mq135Raw"]
    frame[numeric_columns] = frame[numeric_columns].apply(pd.to_numeric, errors="coerce")
    frame = frame.resample(rule).mean(numeric_only=True).interpolate(limit_direction="both")
    frame["zone"] = args.zone or "zone1"
    frame = frame.reset_index()
    return frame


def split_sequences(X: np.ndarray, y: np.ndarray, timestamps: List[pd.Timestamp]):
    total = len(X)
    train_end = max(int(total * 0.7), 1)
    validation_end = max(train_end + int(total * 0.15), train_end + 1)
    validation_end = min(validation_end, total)
    return (
        X[:train_end],
        y[:train_end],
        timestamps[:train_end],
        X[train_end:validation_end],
        y[train_end:validation_end],
        timestamps[train_end:validation_end],
        X[validation_end:],
        y[validation_end:],
        timestamps[validation_end:],
    )


def normalize_sequences(X_train, X_validation, X_test):
    feature_count = X_train.shape[-1]
    flattened = X_train.reshape(-1, feature_count)
    means = flattened.mean(axis=0)
    scales = flattened.std(axis=0)
    scales = np.where(scales == 0, 1.0, scales)

    def transform(values):
        return ((values - means) / scales).astype(np.float32)

    return transform(X_train), transform(X_validation), transform(X_test), means, scales


def build_candidate_models(tf, window_size: int, feature_count: int, horizon: int):
    mlp = tf.keras.Sequential(
        [
            tf.keras.layers.Input(shape=(window_size, feature_count)),
            tf.keras.layers.Flatten(),
            tf.keras.layers.Dense(16, activation="relu"),
            tf.keras.layers.Dense(8, activation="relu"),
            tf.keras.layers.Dense(horizon),
        ],
        name="tiny_mlp",
    )

    cnn = tf.keras.Sequential(
        [
            tf.keras.layers.Input(shape=(window_size, feature_count)),
            tf.keras.layers.Conv1D(filters=8, kernel_size=3, activation="relu", padding="causal"),
            tf.keras.layers.GlobalAveragePooling1D(),
            tf.keras.layers.Dense(8, activation="relu"),
            tf.keras.layers.Dense(horizon),
        ],
        name="tiny_cnn",
    )
    return {"mlp": mlp, "cnn": cnn}


def train_candidate(tf, model, X_train, y_train, X_validation, y_validation):
    model.compile(optimizer="adam", loss="mae")
    callbacks = [
        tf.keras.callbacks.EarlyStopping(monitor="val_loss", patience=10, restore_best_weights=True),
    ]
    model.fit(
        X_train,
        y_train,
        epochs=120,
        batch_size=min(32, len(X_train)),
        validation_data=(X_validation, y_validation),
        callbacks=callbacks,
        verbose=0,
    )
    validation_predictions = model.predict(X_validation, verbose=0).reshape(-1)
    validation_mae = float(mean_absolute_error(y_validation, validation_predictions))
    validation_rmse = float(math.sqrt(mean_squared_error(y_validation, validation_predictions)))
    validation_r2 = float(r2_score(y_validation, validation_predictions))
    return {
        "model": model,
        "validation_mae": validation_mae,
        "validation_rmse": validation_rmse,
        "validation_r2": validation_r2,
        "validation_predictions": validation_predictions,
    }


def quantize_model(tf, keras_model, representative_samples, output_path: Path):
    converter = tf.lite.TFLiteConverter.from_keras_model(keras_model)
    converter.optimizations = [tf.lite.Optimize.DEFAULT]
    converter.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS_INT8]
    converter.inference_input_type = tf.int8
    converter.inference_output_type = tf.int8

    def representative_dataset():
        for sample in representative_samples[: min(len(representative_samples), 128)]:
            yield [sample[np.newaxis, ...].astype(np.float32)]

    converter.representative_dataset = representative_dataset
    tflite_model = converter.convert()
    output_path.write_bytes(tflite_model)
    return tflite_model


def evaluate_quantized_model(tf, model_path: Path, X_test: np.ndarray, y_test: np.ndarray) -> Dict[str, float]:
    interpreter = tf.lite.Interpreter(model_path=str(model_path))
    interpreter.allocate_tensors()
    input_details = interpreter.get_input_details()[0]
    output_details = interpreter.get_output_details()[0]
    predictions = []

    for sample in X_test:
        quantized_input = sample / input_details["quantization"][0] + input_details["quantization"][1]
        quantized_input = np.round(quantized_input).astype(np.int8)[np.newaxis, ...]
        interpreter.set_tensor(input_details["index"], quantized_input)
        interpreter.invoke()
        quantized_output = interpreter.get_tensor(output_details["index"])[0]
        output = (quantized_output.astype(np.float32) - output_details["quantization"][1]) * output_details["quantization"][0]
        predictions.append(float(output.squeeze()))

    mae = float(mean_absolute_error(y_test, predictions))
    rmse = float(math.sqrt(mean_squared_error(y_test, predictions)))
    r2 = float(r2_score(y_test, predictions))
    return {
        "mae": mae,
        "rmse": rmse,
        "r2": r2,
    }


def write_scaler_header(output_path: Path, means: np.ndarray, scales: np.ndarray, feature_names: List[str], window_size: int):
    mean_values = ", ".join(f"{value:.8f}f" for value in means)
    scale_values = ", ".join(f"{value:.8f}f" for value in scales)
    feature_labels = ", ".join(f'"{name}"' for name in feature_names)
    output_path.write_text(
        "\n".join(
            [
                "#pragma once",
                "",
                '#include <Arduino.h>',
                "",
                f"static constexpr int kHumidityWindowSize = {window_size};",
                f"static constexpr int kHumidityFeatureCount = {len(feature_names)};",
                f"static constexpr const char* kHumidityFeatureNames[kHumidityFeatureCount] = {{{feature_labels}}};",
                f"static constexpr float kHumidityFeatureMeans[kHumidityFeatureCount] = {{{mean_values}}};",
                f"static constexpr float kHumidityFeatureScales[kHumidityFeatureCount] = {{{scale_values}}};",
                "",
            ]
        ),
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Train and export the ESP32 TinyML humidity forecaster.")
    parser.add_argument("--csv", type=Path, default=None, help="CSV export of sensor_readings.")
    parser.add_argument("--mongodb-uri", default=None, help="MongoDB URI when training directly from MongoDB.")
    parser.add_argument("--database", default=DEFAULT_SENSOR_DATABASE)
    parser.add_argument("--collection", default=DEFAULT_SENSOR_COLLECTION)
    parser.add_argument("--zone", default="zone1")
    parser.add_argument("--window-size", type=int, default=DEFAULT_TINYML_WINDOW_SIZE)
    parser.add_argument("--horizon", type=int, default=DEFAULT_TINYML_HORIZON)
    parser.add_argument("--resample", default=DEFAULT_TINYML_RESAMPLE_RULE)
    parser.add_argument("--include-mq135-raw", action="store_true")
    parser.add_argument("--size-budget-bytes", type=int, default=DEFAULT_TINYML_SIZE_BUDGET_BYTES)
    args = parser.parse_args()

    tf = require_tensorflow()
    ensure_directories()
    frame = load_sensor_frame(args)
    feature_columns = list(TINYML_FEATURE_COLUMNS)
    if args.include_mq135_raw:
        feature_columns.append("mq135Raw")

    X, y, sequence_timestamps = build_humidity_sequences(
        frame,
        feature_columns=feature_columns,
        target_column="humidity",
        window_size=args.window_size,
        horizon=args.horizon,
    )
    if len(X) < 20:
        raise SystemExit("Not enough sequence windows were created. Collect more real sensor readings first.")

    (
        X_train,
        y_train,
        train_timestamps,
        X_validation,
        y_validation,
        validation_timestamps,
        X_test,
        y_test,
        test_timestamps,
    ) = split_sequences(X, y, sequence_timestamps)

    X_train, X_validation, X_test, means, scales = normalize_sequences(X_train, X_validation, X_test)
    candidates = build_candidate_models(tf, args.window_size, len(feature_columns), args.horizon)

    candidate_reports = {}
    for name, model in candidates.items():
        trained = train_candidate(tf, model, X_train, y_train, X_validation, y_validation)
        model_path = TINYML_ARTIFACTS_DIR / f"{name}_humidity_model.keras"
        trained["model"].save(model_path, overwrite=True)
        tflite_path = TINYML_ARTIFACTS_DIR / f"{name}_humidity_model.tflite"
        quantized_bytes = quantize_model(tf, trained["model"], X_train, tflite_path)
        quantized_metrics = evaluate_quantized_model(tf, tflite_path, X_test, y_test)
        candidate_reports[name] = {
            "keras_path": str(model_path),
            "tflite_path": str(tflite_path),
            "validation_mae": trained["validation_mae"],
            "validation_rmse": trained["validation_rmse"],
            "validation_r2": trained["validation_r2"],
            "test_quantized": quantized_metrics,
            "size_bytes": len(quantized_bytes),
            "compatible": len(quantized_bytes) <= args.size_budget_bytes,
            "preferred_for_deploy": name == "mlp",
        }

    compatible_candidates = [
        (name, report)
        for name, report in candidate_reports.items()
        if report["compatible"]
    ]
    if not compatible_candidates:
        raise SystemExit("No quantized candidate met the ESP32 size budget.")

    selected_name, selected_report = min(
        compatible_candidates,
        key=lambda item: (
            0 if item[0] == "mlp" else 1,
            item[1]["validation_mae"],
        ),
    )

    selected_tflite_path = Path(selected_report["tflite_path"])
    final_tflite_path = TINYML_ARTIFACTS_DIR / "humidity_model.tflite"
    final_tflite_path.write_bytes(selected_tflite_path.read_bytes())

    header_path = FIRMWARE_TINYML_DIR / "humidity_model.h"
    scaler_header_path = FIRMWARE_TINYML_DIR / "humidity_scaler.h"
    convert_tflite_to_header(final_tflite_path, header_path)
    write_scaler_header(scaler_header_path, means, scales, feature_columns, args.window_size)

    normalization_json = {
        "windowSize": args.window_size,
        "horizon": args.horizon,
        "featureColumns": feature_columns,
        "means": means.tolist(),
        "scales": scales.tolist(),
    }
    write_json(TINYML_ARTIFACTS_DIR / "normalization.json", normalization_json)

    report = {
        "trainedAt": datetime.now(timezone.utc).isoformat(),
        "datasetRows": int(len(frame)),
        "windowSize": args.window_size,
        "horizon": args.horizon,
        "featureColumns": feature_columns,
        "candidateReports": candidate_reports,
        "selectedModel": selected_name,
        "selectedModelPath": str(final_tflite_path),
        "estimatedTensorArenaBytes": int(len(final_tflite_path.read_bytes()) * 8),
        "splitSizes": {
            "train": int(len(X_train)),
            "validation": int(len(X_validation)),
            "test": int(len(X_test)),
        },
        "timestampRanges": {
            "train": [str(train_timestamps[0]), str(train_timestamps[-1])],
            "validation": [str(validation_timestamps[0]), str(validation_timestamps[-1])],
            "test": [str(test_timestamps[0]), str(test_timestamps[-1])],
        },
    }
    write_json(TINYML_ARTIFACTS_DIR / "tinyml_report.json", report)


if __name__ == "__main__":
    main()
