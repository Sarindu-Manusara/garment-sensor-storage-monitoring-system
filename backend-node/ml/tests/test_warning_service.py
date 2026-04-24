from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from backend.ml.inference.warning_service import WarningService


class WarningServiceTest(unittest.TestCase):
    def test_infers_warning_level_and_confidence(self) -> None:
        base_history = [
            {
                "timestamp": f"2026-04-21T10:{minute:02d}:00Z",
                "zone": "zone1",
                "temperature": 29.0,
                "humidity": 60.0,
                "lightLux": 65.0,
                "dustMgPerM3": 0.04,
                "mq135AirQualityDeviation": 0.15,
            }
            for minute in range(12)
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_path = Path(temp_dir) / "missing_warning_model.joblib"
            service = WarningService(model_path=artifact_path)
            result = service.infer(
                {
                    "timestamp": "2026-04-21T11:00:00Z",
                    "zone": "zone1",
                    "temperature": 34.0,
                    "humidity": 85.0,
                    "lightLux": 68.0,
                    "dustMgPerM3": 0.14,
                    "mq135AirQualityDeviation": 1.7,
                },
                history=base_history,
                anomaly_score=0.85,
                anomaly_flag=True,
            )

        self.assertEqual(result.warning_level, "high")
        self.assertGreater(result.warning_confidence, 0.0)


if __name__ == "__main__":
    unittest.main()
