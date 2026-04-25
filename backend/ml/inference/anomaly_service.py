from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Sequence

import joblib
import numpy as np

from ..config import ANOMALY_FEATURE_COLUMNS, MODELS_DIR
from ..schemas import AnomalyResult
from ..utils import anomaly_reasons_from_row, build_live_feature_frame


class AnomalyService:
    def __init__(self, model_path: Path | None = None) -> None:
        self.model_path = model_path or (MODELS_DIR / "anomaly_model.joblib")
        self.artifact = self._load_artifact()

    def _load_artifact(self) -> Dict[str, Any] | None:
        if not self.model_path.exists():
            return None
        return joblib.load(self.model_path)

    def infer(
        self,
        sample: Dict[str, Any],
        history: Sequence[Dict[str, Any]] | None = None,
        mq135_baseline: float = 2800.0,
    ) -> AnomalyResult:
        _, latest = build_live_feature_frame(sample, history=history, mq135_baseline=mq135_baseline)
        reasons = anomaly_reasons_from_row(latest, (self.artifact or {}).get("rule_thresholds"))

        if not self.artifact:
            heuristic_score = min(1.0, max(0.0, len(reasons) * 0.34))
            return AnomalyResult(
                anomaly_flag=bool(reasons),
                anomaly_score=round(heuristic_score, 4),
                anomaly_reasons=reasons,
                model_version="backend-ml-rules-fallback",
            )

        feature_columns = self.artifact.get("feature_columns", ANOMALY_FEATURE_COLUMNS)
        row = latest.reindex(feature_columns).astype(float).fillna(0.0)
        scaler = self.artifact["scaler"]
        model = self.artifact["model"]
        scaled = scaler.transform(row.to_frame().T)
        raw_score = float(-model.decision_function(scaled)[0])
        score_min = float(self.artifact.get("score_min", raw_score))
        score_max = float(self.artifact.get("score_max", raw_score + 1.0))
        denominator = score_max - score_min or 1.0
        normalized_score = float(np.clip((raw_score - score_min) / denominator, 0.0, 1.0))
        threshold = float(self.artifact.get("threshold", 0.5))
        score_flag = normalized_score >= threshold

        if score_flag and "isolation_forest_score_high" not in reasons:
            reasons.append("isolation_forest_score_high")

        return AnomalyResult(
            anomaly_flag=bool(score_flag or reasons),
            anomaly_score=round(normalized_score, 4),
            anomaly_reasons=reasons,
            model_version=self.artifact.get("version", "backend-ml-v1"),
        )
