from __future__ import annotations

import json
import sys
from pathlib import Path

CURRENT_DIR = Path(__file__).resolve().parent
ML_ROOT = CURRENT_DIR.parent
PROJECT_ROOT = ML_ROOT.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.ml.inference.anomaly_service import AnomalyService
from backend.ml.inference.warning_service import WarningService


def main() -> None:
    payload = json.load(sys.stdin)
    sample = payload.get("sample", payload)
    history = payload.get("history") or []
    mq135_baseline = float(payload.get("mq135Baseline", 2800.0))

    anomaly_service = AnomalyService()
    warning_service = WarningService()

    anomaly = anomaly_service.infer(sample, history=history, mq135_baseline=mq135_baseline)
    warning = warning_service.infer(
        sample,
        history=history,
        anomaly_score=anomaly.anomaly_score,
        anomaly_flag=anomaly.anomaly_flag,
        mq135_baseline=mq135_baseline,
    )

    response = {
        "anomalyFlag": anomaly.anomaly_flag,
        "anomalyScore": anomaly.anomaly_score,
        "anomalyReasons": anomaly.anomaly_reasons,
        "warningLevel": warning.warning_level,
        "warningConfidence": warning.warning_confidence,
        "modelVersion": {
            "anomaly": anomaly.model_version,
            "warning": warning.model_version,
        },
    }
    json.dump(response, sys.stdout)


if __name__ == "__main__":
    main()

