from __future__ import annotations

import argparse
import sys
from pathlib import Path

CURRENT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = CURRENT_DIR.parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.ml.config import MODELS_DIR
from backend.ml.utils import load_labeled_dataset


def main() -> None:
    parser = argparse.ArgumentParser(description="Inspect the latest backend ML report.")
    parser.add_argument(
        "--report",
        default=str(MODELS_DIR / "backend_ml_report.json"),
        help="Path to the saved backend report JSON.",
    )
    parser.add_argument(
        "--dataset",
        default=None,
        help="Optional dataset path used to confirm that the CSV is available.",
    )
    args = parser.parse_args()

    report_path = Path(args.report)
    if not report_path.exists():
        raise FileNotFoundError(f"Missing report: {report_path}")

    if args.dataset:
        frame = load_labeled_dataset(args.dataset)
        print(f"Loaded dataset with {len(frame)} rows from {args.dataset}")

    print(report_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    main()
