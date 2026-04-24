from __future__ import annotations

import unittest

import pandas as pd

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


if __name__ == "__main__":
    unittest.main()

