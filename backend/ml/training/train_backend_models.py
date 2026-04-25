from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Tuple

import joblib
import numpy as np
from sklearn.ensemble import IsolationForest, RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    confusion_matrix,
    f1_score,
    precision_recall_fscore_support,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.preprocessing import StandardScaler

CURRENT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = CURRENT_DIR.parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.ml.config import (
    ANOMALY_FEATURE_COLUMNS,
    BACKEND_ARTIFACTS_DIR,
    MODELS_DIR,
    WARNING_FEATURE_COLUMNS,
    ensure_directories,
)
from backend.ml.utils import (
    anomaly_reasons_from_row,
    build_feature_frame,
    chronological_split,
    confusion_as_dict,
    ensure_feature_columns,
    load_labeled_dataset,
    normalize_binary_label,
    normalize_warning_level,
    write_json,
)


def fit_anomaly_pipeline(train_frame, validation_frame) -> Tuple[Dict, Dict]:
    train_frame = ensure_feature_columns(train_frame, ANOMALY_FEATURE_COLUMNS)
    validation_frame = ensure_feature_columns(validation_frame, ANOMALY_FEATURE_COLUMNS)

    scaler = StandardScaler()
    X_train = scaler.fit_transform(train_frame[ANOMALY_FEATURE_COLUMNS].astype(float))
    contamination = float(np.clip(train_frame["anomaly_label"].mean() or 0.05, 0.02, 0.35))
    model = IsolationForest(
        n_estimators=250,
        contamination=contamination,
        random_state=42,
    )
    model.fit(X_train)

    train_raw_scores = -model.decision_function(X_train)
    score_min = float(np.min(train_raw_scores))
    score_max = float(np.max(train_raw_scores))
    denominator = score_max - score_min or 1.0

    X_validation = scaler.transform(validation_frame[ANOMALY_FEATURE_COLUMNS].astype(float))
    validation_raw_scores = -model.decision_function(X_validation)
    validation_scores = np.clip((validation_raw_scores - score_min) / denominator, 0.0, 1.0)
    validation_reasons = validation_frame.apply(anomaly_reasons_from_row, axis=1)

    thresholds = np.linspace(0.2, 0.9, 29)
    best_threshold = 0.5
    best_f1 = -1.0
    validation_labels = validation_frame["anomaly_label"].to_numpy(dtype=int)
    for threshold in thresholds:
        predicted = np.array(
            [
                int(score >= threshold or bool(reasons))
                for score, reasons in zip(validation_scores, validation_reasons, strict=False)
            ]
        )
        score_value = f1_score(validation_labels, predicted, zero_division=0)
        if score_value > best_f1:
            best_f1 = float(score_value)
            best_threshold = float(threshold)

    artifact = {
        "version": "backend-ml-v1",
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "feature_columns": list(ANOMALY_FEATURE_COLUMNS),
        "rule_thresholds": {
            "humidity_pct_z": 2.5,
            "dust_proxy_z": 2.5,
            "gas_proxy_z": 2.5,
            "humidity_delta": 4.0,
            "dust_delta": 0.05,
            "gas_delta": 0.75,
        },
        "threshold": best_threshold,
        "score_min": score_min,
        "score_max": score_max,
        "scaler": scaler,
        "model": model,
    }
    summary = {
        "validation_f1": round(best_f1, 4),
        "validation_threshold": round(best_threshold, 4),
        "contamination": round(contamination, 4),
    }
    return artifact, summary


def score_anomaly_frame(frame, artifact: Dict) -> Tuple[np.ndarray, np.ndarray]:
    prepared = ensure_feature_columns(frame, artifact["feature_columns"])
    X = artifact["scaler"].transform(prepared[artifact["feature_columns"]].astype(float))
    raw_scores = -artifact["model"].decision_function(X)
    denominator = artifact["score_max"] - artifact["score_min"] or 1.0
    scores = np.clip((raw_scores - artifact["score_min"]) / denominator, 0.0, 1.0)
    reasons = prepared.apply(anomaly_reasons_from_row, axis=1, thresholds=artifact["rule_thresholds"])
    predictions = np.array(
        [
            int(score >= artifact["threshold"] or bool(reason_set))
            for score, reason_set in zip(scores, reasons, strict=False)
        ]
    )
    return scores, predictions


def fit_warning_model(train_frame, validation_frame, test_frame, anomaly_artifact: Dict) -> Tuple[Dict, Dict]:
    for frame in (train_frame, validation_frame, test_frame):
        scores, predictions = score_anomaly_frame(frame, anomaly_artifact)
        frame["anomaly_score_from_pipeline"] = scores
        frame["anomaly_flag_from_pipeline"] = predictions
        frame["warning_level"] = frame["warning_level"].apply(normalize_warning_level)

    feature_columns = list(WARNING_FEATURE_COLUMNS)
    train_frame = ensure_feature_columns(train_frame, feature_columns)
    validation_frame = ensure_feature_columns(validation_frame, feature_columns)
    test_frame = ensure_feature_columns(test_frame, feature_columns)

    imputer = SimpleImputer(strategy="median")
    X_train = imputer.fit_transform(train_frame[feature_columns].astype(float))
    X_validation = imputer.transform(validation_frame[feature_columns].astype(float))
    X_test = imputer.transform(test_frame[feature_columns].astype(float))

    model = RandomForestClassifier(
        n_estimators=300,
        max_depth=12,
        min_samples_leaf=2,
        random_state=42,
        class_weight="balanced_subsample",
    )
    model.fit(X_train, train_frame["warning_level"])

    validation_predictions = model.predict(X_validation)
    validation_f1 = f1_score(validation_frame["warning_level"], validation_predictions, average="macro", zero_division=0)
    test_predictions = model.predict(X_test)
    test_probabilities = model.predict_proba(X_test)
    test_confidence = np.max(test_probabilities, axis=1)

    artifact = {
        "version": "backend-ml-v1",
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "feature_columns": feature_columns,
        "classes": model.classes_.tolist(),
        "imputer": imputer,
        "model": model,
    }
    summary = {
        "validation_macro_f1": round(float(validation_f1), 4),
        "test_accuracy": round(float(accuracy_score(test_frame["warning_level"], test_predictions)), 4),
        "test_macro_f1": round(
            float(f1_score(test_frame["warning_level"], test_predictions, average="macro", zero_division=0)),
            4,
        ),
        "mean_confidence": round(float(np.mean(test_confidence)), 4),
        "classification_report": classification_report(
            test_frame["warning_level"],
            test_predictions,
            output_dict=True,
            zero_division=0,
        ),
        "confusion_matrix": confusion_matrix(
            test_frame["warning_level"],
            test_predictions,
            labels=model.classes_,
        ).tolist(),
    }
    return artifact, summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Train backend anomaly and warning models.")
    parser.add_argument("--dataset", default=str(Path("labeled_garment_dataset.csv")), help="Path to labeled dataset CSV.")
    args = parser.parse_args()

    ensure_directories()
    dataset = build_feature_frame(load_labeled_dataset(args.dataset))
    if "anomaly_label" not in dataset.columns:
        raise ValueError("Dataset must include anomaly_label.")
    if "warning_level" not in dataset.columns:
        raise ValueError("Dataset must include warning_level.")

    dataset["anomaly_label"] = dataset["anomaly_label"].apply(normalize_binary_label)
    dataset["warning_level"] = dataset["warning_level"].apply(normalize_warning_level)

    train_frame, validation_frame, test_frame = chronological_split(dataset)
    anomaly_artifact, anomaly_summary = fit_anomaly_pipeline(train_frame.copy(), validation_frame.copy())

    test_scores, test_predictions = score_anomaly_frame(test_frame.copy(), anomaly_artifact)
    anomaly_truth = test_frame["anomaly_label"].to_numpy(dtype=int)
    anomaly_metrics = {
        "precision": round(float(precision_score(anomaly_truth, test_predictions, zero_division=0)), 4),
        "recall": round(float(recall_score(anomaly_truth, test_predictions, zero_division=0)), 4),
        "f1": round(float(f1_score(anomaly_truth, test_predictions, zero_division=0)), 4),
        "confusion_matrix": confusion_as_dict(confusion_matrix(anomaly_truth, test_predictions, labels=[0, 1])),
    }
    if len(np.unique(anomaly_truth)) > 1:
        anomaly_metrics["roc_auc"] = round(float(roc_auc_score(anomaly_truth, test_scores)), 4)

    warning_artifact, warning_summary = fit_warning_model(
        train_frame.copy(),
        validation_frame.copy(),
        test_frame.copy(),
        anomaly_artifact,
    )

    joblib.dump(anomaly_artifact, MODELS_DIR / "anomaly_model.joblib")
    joblib.dump(warning_artifact, MODELS_DIR / "warning_model.joblib")

    feature_manifest = {
        "anomaly": ANOMALY_FEATURE_COLUMNS,
        "warning": WARNING_FEATURE_COLUMNS,
    }
    write_json(MODELS_DIR / "feature_columns.json", feature_manifest)

    report = {
        "trainedAt": datetime.now(timezone.utc).isoformat(),
        "datasetRows": int(len(dataset)),
        "splits": {
            "train": int(len(train_frame)),
            "validation": int(len(validation_frame)),
            "test": int(len(test_frame)),
        },
        "anomaly": {
            **anomaly_summary,
            **anomaly_metrics,
        },
        "warning": warning_summary,
    }
    write_json(MODELS_DIR / "backend_ml_report.json", report)
    write_json(BACKEND_ARTIFACTS_DIR / "backend_ml_report.json", report)


if __name__ == "__main__":
    main()
