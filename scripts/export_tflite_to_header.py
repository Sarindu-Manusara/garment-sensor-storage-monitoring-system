from __future__ import annotations

import argparse
from pathlib import Path


def convert_tflite_to_header(input_path: Path, output_path: Path, array_name: str = "g_humidity_model") -> None:
    model_bytes = input_path.read_bytes()
    byte_lines = []
    for index in range(0, len(model_bytes), 12):
        chunk = model_bytes[index:index + 12]
        formatted = ", ".join(f"0x{byte:02x}" for byte in chunk)
        byte_lines.append(f"  {formatted},")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        "\n".join(
            [
                "#pragma once",
                "",
                '#include <Arduino.h>',
                "",
                f"static const unsigned char {array_name}[] = {{",
                *byte_lines,
                "};",
                f"#define HUMIDITY_MODEL_DATA_LEN {len(model_bytes)}",
                f"static const unsigned int {array_name}_len = {len(model_bytes)};",
                "",
            ]
        ),
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert a .tflite model to an Arduino header array.")
    parser.add_argument("input_path", type=Path)
    parser.add_argument("output_path", type=Path)
    parser.add_argument("--array-name", default="g_humidity_model")
    args = parser.parse_args()
    convert_tflite_to_header(args.input_path, args.output_path, array_name=args.array_name)


if __name__ == "__main__":
    main()
