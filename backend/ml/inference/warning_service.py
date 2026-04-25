from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Sequence

import joblib
import numpy as np

from ..config import MODELS_DIR, WARNING_FEATURE_COLUMNS
from ..schemas import WarningResult
from ..utils import build_live_feature_frame


class WarningService:
    def __init__(self, model_path: Path | None = None) -> None:
        self.model_path = model_path or (MODELS_DIR / "warning_model.joblib")
        self.artifact = self._load_artifact()

    def _load_artifact(self) -> Dict[str, Any] | None:
        if not self.model_path.exists():
            return None
        return joblib.load(self.model_path)

    def infer(
        self,
        sample: Dict[str, Any],
        history: Sequence[Dict[str, Any]] | None = None,
        anomaly_score: float = 0.0,
        anomaly_flag: bool = False,
        mq135_baseline: float = 2800.0,
    ) -> WarningResult:
        _, latest = build_live_feature_frame(sample, history=history, mq135_baseline=mq135_baseline)
        latest["anomaly_score_from_pipeline"] = anomaly_score
        latest["anomaly_flag_from_pipeline"] = int(bool(anomaly_flag))

        if not self.artifact:
            humidity = float(latest.get("humidity_pct", 0.0))
            gas = float(latest.get("gas_proxy", 0.0))
            dust = float(latest.get("dust_proxy", 0.0))
            if anomaly_flag or gas >= 1.5 or dust >= 0.15 or humidity >= 75:
                return WarningResult("high", 0.76, "backend-ml-rules-fallback")
            if anomaly_score >= 0.35 or gas >= 0.75 or dust >= 0.08 or humidity >= 65:
                return WarningResult("medium", 0.64, "backend-ml-rules-fallback")
            return WarningResult("low", 0.82, "backend-ml-rules-fallback")

        feature_columns = self.artifact.get("feature_columns", WARNING_FEATURE_COLUMNS)
        row = latest.reindex(feature_columns).astype(float).fillna(0.0)
        imputer = self.artifact["imputer"]
        model = self.artifact["model"]
        transformed = imputer.transform(row.to_frame().T)
        probabilities = model.predict_proba(transformed)[0]
        predicted_index = int(np.argmax(probabilities))
        classes = list(self.artifact.get("classes", model.classes_))
        return WarningResult(
            warning_level=str(classes[predicted_index]),
            warning_confidence=round(float(probabilities[predicted_index]), 4),
            model_version=self.artifact.get("version", "backend-ml-v1"),
        )
