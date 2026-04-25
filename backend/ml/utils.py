from __future__ import annotations

import json
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Sequence, Tuple

import numpy as np
import pandas as pd

from .config import (
    ANOMALY_FEATURE_COLUMNS,
    DEFAULT_BACKEND_DATASET_PATH,
    TINYML_FEATURE_COLUMNS,
    WARNING_FEATURE_COLUMNS,
)


def parse_timestamp(value: Any) -> pd.Timestamp:
    timestamp = pd.to_datetime(value, utc=True, errors="coerce")
    if pd.isna(timestamp):
        return pd.Timestamp.utcnow().tz_localize("UTC")
    return timestamp


def safe_float(value: Any, default: float | None = np.nan) -> float | None:
    if value is None or value == "":
        return default
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if np.isnan(number) or np.isinf(number):
        return default
    return number


def normalize_warning_level(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"low", "safe"}:
        return "low"
    if normalized in {"medium", "warning"}:
        return "medium"
    if normalized in {"high", "danger"}:
        return "high"
    return "low"


def normalize_binary_label(value: Any) -> int:
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "anomaly", "anomalous"}:
            return 1
        if normalized in {"0", "false", "no", "normal"}:
            return 0
    return int(bool(value))


def derive_gas_proxy(row: pd.Series, mq135_baseline: float = 2800.0) -> float:
    deviation = safe_float(row.get("mq135AirQualityDeviation"))
    if deviation is not None and not np.isnan(deviation):
        return float(deviation)

    gas_proxy = safe_float(row.get("gas_proxy"))
    if gas_proxy is not None and not np.isnan(gas_proxy):
        return float(gas_proxy)

    mq135_raw = safe_float(row.get("mq135Raw"))
    if mq135_raw is None or np.isnan(mq135_raw):
        return 0.0

    baseline = mq135_baseline if mq135_baseline else 1.0
    return float(((mq135_raw - baseline) / baseline) * 10.0)


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    serialized = payload
    if is_dataclass(payload):
        serialized = asdict(payload)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(serialized, handle, indent=2, default=_json_default)


def _json_default(value: Any) -> Any:
    if is_dataclass(value):
        return asdict(value)
    if isinstance(value, (datetime, pd.Timestamp)):
        return value.isoformat()
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, (np.floating, np.integer)):
        return value.item()
    raise TypeError(f"Object of type {type(value)!r} is not JSON serializable")


def load_labeled_dataset(path: Path | str = DEFAULT_BACKEND_DATASET_PATH) -> pd.DataFrame:
    dataset_path = Path(path)
    if not dataset_path.exists():
        raise FileNotFoundError(f"Dataset not found: {dataset_path}")

    frame = pd.read_csv(dataset_path)
    if "timestamp" in frame.columns:
        frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True, errors="coerce")
    elif "datetime" in frame.columns:
        frame["timestamp"] = pd.to_datetime(frame["datetime"], utc=True, errors="coerce")
    else:
        frame["timestamp"] = pd.date_range(
            start="2026-01-01",
            periods=len(frame),
            freq="5min",
            tz="UTC",
        )

    frame = frame.sort_values("timestamp").reset_index(drop=True)
    return frame


def ensure_feature_columns(frame: pd.DataFrame, feature_columns: Sequence[str]) -> pd.DataFrame:
    prepared = frame.copy()
    for column in feature_columns:
        if column not in prepared.columns:
            prepared[column] = 0.0
    return prepared


def chronological_split(
    frame: pd.DataFrame,
    train_fraction: float = 0.7,
    validation_fraction: float = 0.15,
) -> Tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    ordered = frame.sort_values("timestamp").reset_index(drop=True)
    total_rows = len(ordered)
    train_end = max(int(total_rows * train_fraction), 1)
    validation_end = max(train_end + int(total_rows * validation_fraction), train_end + 1)
    validation_end = min(validation_end, total_rows)
    train = ordered.iloc[:train_end].copy()
    validation = ordered.iloc[train_end:validation_end].copy()
    test = ordered.iloc[validation_end:].copy()
    if validation.empty:
        validation = train.tail(min(len(train), max(total_rows // 10, 1))).copy()
    if test.empty:
        test = ordered.tail(min(len(ordered), max(total_rows // 10, 1))).copy()
    return train, validation, test


def build_feature_frame(
    records: pd.DataFrame | Sequence[Dict[str, Any]],
    mq135_baseline: float = 2800.0,
    rolling_window: int = 6,
) -> pd.DataFrame:
    frame = pd.DataFrame(records).copy()
    if frame.empty:
        ordered_columns = list(dict.fromkeys(ANOMALY_FEATURE_COLUMNS + WARNING_FEATURE_COLUMNS + ["timestamp"]))
        return pd.DataFrame(columns=ordered_columns)

    if "timestamp" in frame.columns:
        frame["timestamp"] = frame["timestamp"].apply(parse_timestamp)
    else:
        frame["timestamp"] = pd.date_range(
            end=pd.Timestamp.utcnow().tz_localize("UTC"),
            periods=len(frame),
            freq="5min",
        )
    frame = frame.sort_values("timestamp").reset_index(drop=True)

    aliases = {
        "temperature_c": ["temperature_c", "temperature"],
        "humidity_pct": ["humidity_pct", "humidity"],
        "light_lux": ["light_lux", "lightLux", "light"],
        "dust_proxy": ["dust_proxy", "dustMgPerM3", "dust"],
        "gas_proxy": ["gas_proxy", "mq135AirQualityDeviation"],
    }

    for canonical, options in aliases.items():
        if canonical in frame.columns:
            continue
        for option in options:
            if option in frame.columns:
                frame[canonical] = pd.to_numeric(frame[option], errors="coerce")
                break
        else:
            if canonical == "gas_proxy":
                frame[canonical] = frame.apply(derive_gas_proxy, axis=1, mq135_baseline=mq135_baseline)
            else:
                frame[canonical] = 0.0

    if "mq135Raw" not in frame.columns:
        frame["mq135Raw"] = np.nan

    numeric_columns = [
        "temperature_c",
        "humidity_pct",
        "light_lux",
        "dust_proxy",
        "gas_proxy",
        "mq135Raw",
    ]
    for column in numeric_columns:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    frame[numeric_columns] = frame[numeric_columns].replace([np.inf, -np.inf], np.nan)
    frame[numeric_columns] = frame[numeric_columns].interpolate(limit_direction="both")
    frame[numeric_columns] = frame[numeric_columns].ffill().bfill().fillna(0.0)

    frame["hour_of_day"] = frame["timestamp"].dt.hour
    frame["day_of_week"] = frame["timestamp"].dt.dayofweek

    for source, delta_column in (
        ("humidity_pct", "humidity_delta"),
        ("dust_proxy", "dust_delta"),
        ("gas_proxy", "gas_delta"),
    ):
        frame[delta_column] = frame[source].diff().fillna(0.0)

    for source in ("humidity_pct", "dust_proxy", "gas_proxy"):
        roll_mean_column = f"{source}_roll_mean"
        roll_std_column = f"{source}_roll_std"
        z_column = f"{source}_z"
        rolling = frame[source].rolling(window=rolling_window, min_periods=2)
        frame[roll_mean_column] = rolling.mean().fillna(frame[source])
        frame[roll_std_column] = rolling.std(ddof=0).fillna(0.0)
        denominator = frame[roll_std_column].replace(0.0, np.nan)
        frame[z_column] = ((frame[source] - frame[roll_mean_column]) / denominator).fillna(0.0)

    if "anomaly_label" in frame.columns:
        frame["anomaly_label"] = frame["anomaly_label"].apply(normalize_binary_label)
    if "warning_level" in frame.columns:
        frame["warning_level"] = frame["warning_level"].apply(normalize_warning_level)

    return frame


def build_live_feature_frame(
    sample: Dict[str, Any],
    history: Sequence[Dict[str, Any]] | None = None,
    mq135_baseline: float = 2800.0,
) -> Tuple[pd.DataFrame, pd.Series]:
    records = list(history or []) + [sample]
    frame = build_feature_frame(records, mq135_baseline=mq135_baseline)
    latest = frame.iloc[-1].copy()
    return frame, latest


def anomaly_reasons_from_row(row: pd.Series, thresholds: Dict[str, float] | None = None) -> List[str]:
    limits = {
        "humidity_pct_z": 2.5,
        "dust_proxy_z": 2.5,
        "gas_proxy_z": 2.5,
        "humidity_delta": 4.0,
        "dust_delta": 0.05,
        "gas_delta": 0.75,
    }
    if thresholds:
        limits.update(thresholds)

    reasons: List[str] = []
    if abs(float(row.get("humidity_pct_z", 0.0))) >= limits["humidity_pct_z"]:
        reasons.append("humidity_spike")
    if abs(float(row.get("dust_proxy_z", 0.0))) >= limits["dust_proxy_z"]:
        reasons.append("dust_proxy_high")
    if abs(float(row.get("gas_proxy_z", 0.0))) >= limits["gas_proxy_z"]:
        reasons.append("gas_proxy_high")
    if abs(float(row.get("humidity_delta", 0.0))) >= limits["humidity_delta"] and "humidity_spike" not in reasons:
        reasons.append("humidity_delta_jump")
    if abs(float(row.get("dust_delta", 0.0))) >= limits["dust_delta"] and "dust_proxy_high" not in reasons:
        reasons.append("dust_delta_jump")
    if abs(float(row.get("gas_delta", 0.0))) >= limits["gas_delta"] and "gas_proxy_high" not in reasons:
        reasons.append("gas_delta_jump")
    return reasons


def build_humidity_sequences(
    frame: pd.DataFrame,
    feature_columns: Sequence[str] = TINYML_FEATURE_COLUMNS,
    target_column: str = "humidity",
    window_size: int = 12,
    horizon: int = 1,
) -> Tuple[np.ndarray, np.ndarray, List[pd.Timestamp]]:
    ordered = frame.sort_values("timestamp").reset_index(drop=True)
    features = ordered.loc[:, list(feature_columns)].to_numpy(dtype=np.float32)
    targets = ordered.loc[:, target_column].to_numpy(dtype=np.float32)
    timestamps = ordered.loc[:, "timestamp"].tolist()

    sequences: List[np.ndarray] = []
    labels: List[float] = []
    label_timestamps: List[pd.Timestamp] = []
    max_index = len(ordered) - horizon
    for end_index in range(window_size, max_index + 1):
        start_index = end_index - window_size
        sequences.append(features[start_index:end_index])
        labels.append(targets[end_index + horizon - 1])
        label_timestamps.append(timestamps[end_index + horizon - 1])

    if not sequences:
        return (
            np.empty((0, window_size, len(feature_columns)), dtype=np.float32),
            np.empty((0,), dtype=np.float32),
            [],
        )

    return np.stack(sequences), np.asarray(labels, dtype=np.float32), label_timestamps


def confusion_as_dict(matrix: np.ndarray) -> Dict[str, int]:
    if matrix.size != 4:
        return {}
    return {
        "tn": int(matrix[0, 0]),
        "fp": int(matrix[0, 1]),
        "fn": int(matrix[1, 0]),
        "tp": int(matrix[1, 1]),
    }
