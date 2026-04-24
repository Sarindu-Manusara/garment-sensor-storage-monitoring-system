from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np

from backend.ml.training.train_tinyml_humidity import write_scaler_header
from scripts.export_tflite_to_header import convert_tflite_to_header


class ExportPipelineTest(unittest.TestCase):
    def test_tflite_header_and_scaler_header_are_generated(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            tflite_path = temp_path / "model.tflite"
            header_path = temp_path / "humidity_model.h"
            scaler_path = temp_path / "humidity_scaler.h"

            tflite_path.write_bytes(bytes(range(16)))
            convert_tflite_to_header(tflite_path, header_path)
            write_scaler_header(
                scaler_path,
                np.array([1.0, 2.0, 3.0], dtype=np.float32),
                np.array([0.5, 1.5, 2.5], dtype=np.float32),
                ["temperature", "humidity", "lightLux"],
                12,
            )

            header_text = header_path.read_text(encoding="utf-8")
            scaler_text = scaler_path.read_text(encoding="utf-8")

            self.assertIn("#define HUMIDITY_MODEL_DATA_LEN 16", header_text)
            self.assertIn("0x00, 0x01, 0x02", header_text)
            self.assertIn("kHumidityWindowSize = 12", scaler_text)
            self.assertIn("\"humidity\"", scaler_text)
            self.assertIn("1.50000000f", scaler_text)


if __name__ == "__main__":
    unittest.main()

