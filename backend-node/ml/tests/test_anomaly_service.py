from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler

from backend.ml.config import ANOMALY_FEATURE_COLUMNS
from backend.ml.inference.anomaly_service import AnomalyService
from backend.ml.utils import build_feature_frame


class AnomalyServiceTest(unittest.TestCase):
    def test_infers_flag_score_and_reasons(self) -> None:
        history = [
            {
                "timestamp": f"2026-04-21T10:{minute:02d}:00Z",
                "zone": "zone1",
                "temperature": 30.0,
                "humidity": 61.0,
                "lightLux": 70.0,
                "dustMgPerM3": 0.04,
                "mq135AirQualityDeviation": 0.2,
            }
            for minute in range(12)
        ]
        training_frame = build_feature_frame(history)
        scaler = StandardScaler()
        X_train = scaler.fit_transform(training_frame[ANOMALY_FEATURE_COLUMNS])
        model = IsolationForest(n_estimators=50, contamination=0.1, random_state=42).fit(X_train)
        train_scores = -model.decision_function(X_train)

        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_path = Path(temp_dir) / "anomaly_model.joblib"
            joblib.dump(
                {
                    "version": "backend-ml-v1",
                    "feature_columns": ANOMALY_FEATURE_COLUMNS,
                    "rule_thresholds": {
                        "humidity_pct_z": 2.0,
                        "dust_proxy_z": 2.0,
                        "gas_proxy_z": 2.0,
                        "humidity_delta": 2.0,
                        "dust_delta": 0.02,
                        "gas_delta": 0.2,
                    },
                    "threshold": 0.5,
                    "score_min": float(np.min(train_scores)),
                    "score_max": float(np.max(train_scores)),
                    "scaler": scaler,
                    "model": model,
                },
                artifact_path,
            )

            service = AnomalyService(model_path=artifact_path)
            result = service.infer(
                {
                    "timestamp": "2026-04-21T11:00:00Z",
                    "zone": "zone1",
                    "temperature": 35.0,
                    "humidity": 82.0,
                    "lightLux": 72.0,
                    "dustMgPerM3": 0.13,
                    "mq135AirQualityDeviation": 1.8,
                },
                history=history,
            )

        self.assertIsInstance(result.anomaly_flag, bool)
        self.assertGreaterEqual(result.anomaly_score, 0.0)
        self.assertLessEqual(result.anomaly_score, 1.0)
        self.assertTrue(result.anomaly_reasons)


if __name__ == "__main__":
    unittest.main()

