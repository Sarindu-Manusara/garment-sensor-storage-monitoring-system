from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class LiveSensorSample:
    timestamp: str
    zone: str
    temperature: Optional[float]
    humidity: Optional[float]
    lightLux: Optional[float]
    dustMgPerM3: Optional[float]
    mq135Raw: Optional[float]
    mq135AirQualityDeviation: Optional[float]

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class AnomalyResult:
    anomaly_flag: bool
    anomaly_score: float
    anomaly_reasons: List[str] = field(default_factory=list)
    model_version: str = "backend-ml-untrained"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class WarningResult:
    warning_level: str
    warning_confidence: float
    model_version: str = "backend-ml-untrained"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

