from __future__ import annotations

import unittest
from pathlib import Path
import sys

import pandas as pd

PROJECT_ROOT = Path(__file__).resolve().parents[3]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.ml.utils import build_humidity_sequences


class SequenceBuilderTest(unittest.TestCase):
    def test_builds_expected_window_count_and_targets(self) -> None:
        frame = pd.DataFrame(
            {
                "timestamp": pd.date_range("2026-01-01", periods=20, freq="5min", tz="UTC"),
                "temperature": [28.0 + index * 0.1 for index in range(20)],
                "humidity": [60.0 + index for index in range(20)],
                "lightLux": [100.0 + index for index in range(20)],
                "dustMgPerM3": [0.05 + index * 0.001 for index in range(20)],
                "mq135AirQualityDeviation": [0.1 + index * 0.05 for index in range(20)],
            }
        )

        X, y, timestamps = build_humidity_sequences(frame, window_size=12, horizon=1)

        self.assertEqual(X.shape, (8, 12, 5))
        self.assertEqual(y.shape, (8,))
        self.assertEqual(len(timestamps), 8)
        self.assertAlmostEqual(y[0], frame.loc[12, "humidity"])
        self.assertAlmostEqual(X[0, -1, 1], frame.loc[11, "humidity"])

    def test_skips_windows_that_cross_large_time_gaps(self) -> None:
        timestamps = list(pd.date_range("2026-01-01", periods=12, freq="5s", tz="UTC"))
        timestamps.extend(pd.date_range("2026-01-01 00:10:00", periods=12, freq="5s", tz="UTC"))
        frame = pd.DataFrame(
            {
                "timestamp": timestamps,
                "temperature": [28.0] * 24,
                "humidity": [60.0 + index for index in range(24)],
                "lightLux": [100.0] * 24,
                "dustMgPerM3": [0.05] * 24,
                "mq135AirQualityDeviation": [0.1] * 24,
            }
        )

        X, y, sequence_timestamps = build_humidity_sequences(
            frame,
            window_size=6,
            horizon=1,
            max_gap_seconds=12.5,
        )

        self.assertEqual(len(X), 12)
        self.assertEqual(len(y), 12)
        self.assertEqual(len(sequence_timestamps), 12)
        self.assertTrue(all(timestamp >= timestamps[6] for timestamp in sequence_timestamps[:6]))
        self.assertTrue(all(timestamp >= timestamps[18] for timestamp in sequence_timestamps[6:]))


if __name__ == "__main__":
    unittest.main()

