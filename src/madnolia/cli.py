import argparse
import sys
from pathlib import Path

from madnolia.constants import (
    BACKEND_DEFAULT_DEVICES,
    DEFAULT_ANALYSIS_ACOUSTIC_UNITS,
    DEFAULT_ANALYSIS_ALIGNMENT,
    DEFAULT_INFERENCE_DEVICE,
    DEFAULT_INPUT_DIR,
    DEFAULT_MODEL_NAME,
    DEFAULT_OUTPUT_DIR,
    DEFAULT_VIEWER_HOST,
    DEFAULT_VIEWER_PORT,
    DEVICE_DEFAULT_BACKENDS,
    SUPPORTED_VIDEO_EXTENSIONS,
)
from madnolia.hardware import detect_analysis_hardware
from madnolia.models import ensure_analysis_models
from madnolia.pipeline import IngestionPipeline, finalize_project, realign_project
from madnolia.types.common import AlignmentMode, InferenceBackend


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="madnolia")
    subparsers = parser.add_subparsers(dest="command", required=True)
    ingest = subparsers.add_parser("ingest", help="입력 폴더의 영상을 분석합니다.")
    ingest.add_argument("--input", type=Path, default=DEFAULT_INPUT_DIR)
    ingest.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_DIR)
    ingest.add_argument("--model", default=DEFAULT_MODEL_NAME)
    ingest.add_argument("--candidate-model", action="append", default=[])
    ingest.add_argument(
        "--alignment",
        choices=list(AlignmentMode),
        default=AlignmentMode(DEFAULT_ANALYSIS_ALIGNMENT),
    )
    ingest.add_argument(
        "--acoustic-units",
        action=argparse.BooleanOptionalAction,
        default=DEFAULT_ANALYSIS_ACOUSTIC_UNITS,
    )
    ingest.add_argument(
        "--backend",
        choices=list(InferenceBackend),
        default=None,
    )
    ingest.add_argument("--device", default=None)
    ingest.add_argument("--file", type=Path)
    finalize = subparsers.add_parser("finalize", help="기존 분석 JSON에서 프로젝트를 복구합니다.")
    finalize.add_argument("--project", type=Path, required=True)
    finalize.add_argument("--model", default=DEFAULT_MODEL_NAME)
    finalize.add_argument("--backend", choices=list(InferenceBackend), required=True)
    finalize.add_argument("--device", default=DEFAULT_INFERENCE_DEVICE)
    finalize.add_argument(
        "--alignment", choices=list(AlignmentMode), default=AlignmentMode.ESTIMATED
    )
    realign = subparsers.add_parser(
        "realign", help="기존 프로젝트의 CTC와 음향 특징을 다시 계산합니다."
    )
    realign.add_argument("--project", type=Path, required=True)
    realign.add_argument("--device", default=DEFAULT_INFERENCE_DEVICE)
    realign.add_argument("--acoustic-units", action="store_true")
    viewer = subparsers.add_parser("viewer", help="분석 결과 검수용 웹 API를 실행합니다.")
    viewer.add_argument("--port", type=int, default=DEFAULT_VIEWER_PORT)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if args.command == "viewer":
        import uvicorn

        uvicorn.run("madnolia.viewer:app", host=DEFAULT_VIEWER_HOST, port=args.port, reload=False)
        return
    if args.command == "finalize":
        try:
            project_dir = finalize_project(
                args.project,
                args.model,
                InferenceBackend(args.backend),
                args.device,
                AlignmentMode(args.alignment),
            )
        except (OSError, RuntimeError, ValueError) as error:
            print(f"오류: {error}", file=sys.stderr)
            raise SystemExit(1) from error
        print(f"완료: {project_dir}")
        return
    if args.command == "realign":
        try:
            project_dir = realign_project(args.project, args.device, args.acoustic_units)
        except (OSError, RuntimeError, ValueError) as error:
            print(f"오류: {error}", file=sys.stderr)
            raise SystemExit(1) from error
        print(f"완료: {project_dir}")
        return
    detected = detect_analysis_hardware() if args.backend is None or args.device is None else None
    if args.backend is None:
        selected_device = args.device.upper() if args.device else detected.device
        if selected_device not in DEVICE_DEFAULT_BACKENDS:
            raise SystemExit(f"지원하지 않는 장치: {selected_device}")
        args.backend = InferenceBackend(DEVICE_DEFAULT_BACKENDS[selected_device])
    if args.device is None:
        args.device = (
            detected.device
            if detected.backend == args.backend
            else BACKEND_DEFAULT_DEVICES[args.backend]
        )
    try:
        selected_files = (
            [args.file]
            if args.file
            else sorted(
                path
                for path in args.input.iterdir()
                if path.is_file() and path.suffix.lower() in SUPPORTED_VIDEO_EXTENSIONS
            )
        )
        if not selected_files:
            raise ValueError(f"분석할 영상이 없습니다: {args.input}")
        ensure_analysis_models(
            args.model,
            InferenceBackend(args.backend),
            args.candidate_model,
            AlignmentMode(args.alignment),
            args.acoustic_units,
            on_download=lambda name, percent: print(
                f"모델 준비: {name} {percent:.1f}%", end="\r", flush=True
            ),
        )
        for selected_file in selected_files:
            project_dir = IngestionPipeline(
                args.model,
                InferenceBackend(args.backend),
                args.device,
                args.candidate_model,
                AlignmentMode(args.alignment),
                args.acoustic_units,
            ).run(args.input, args.output, selected_file)
            print(f"완료: {project_dir}")
    except (OSError, RuntimeError, ValueError) as error:
        print(f"오류: {error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
