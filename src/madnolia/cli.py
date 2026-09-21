import argparse
import sys
from pathlib import Path

from madnolia.constants import (
    DEFAULT_INFERENCE_DEVICE,
    DEFAULT_INPUT_DIR,
    DEFAULT_MODEL_NAME,
    DEFAULT_OUTPUT_DIR,
    DEFAULT_VIEWER_HOST,
    DEFAULT_VIEWER_PORT,
)
from madnolia.pipeline import IngestionPipeline, finalize_project
from madnolia.types.common import InferenceBackend


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="madnolia")
    subparsers = parser.add_subparsers(dest="command", required=True)
    ingest = subparsers.add_parser("ingest", help="입력 폴더의 영상을 분석합니다.")
    ingest.add_argument("--input", type=Path, default=DEFAULT_INPUT_DIR)
    ingest.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_DIR)
    ingest.add_argument("--model", default=DEFAULT_MODEL_NAME)
    ingest.add_argument("--backend", choices=list(InferenceBackend), default=InferenceBackend.FASTER_WHISPER)
    ingest.add_argument("--device", default=DEFAULT_INFERENCE_DEVICE)
    ingest.add_argument("--file", type=Path)
    finalize = subparsers.add_parser("finalize", help="기존 분석 JSON에서 프로젝트를 복구합니다.")
    finalize.add_argument("--project", type=Path, required=True)
    finalize.add_argument("--model", default=DEFAULT_MODEL_NAME)
    finalize.add_argument("--backend", choices=list(InferenceBackend), required=True)
    finalize.add_argument("--device", default=DEFAULT_INFERENCE_DEVICE)
    viewer = subparsers.add_parser("viewer", help="분석 결과 검수용 웹 API를 실행합니다.")
    viewer.add_argument("--host", default=DEFAULT_VIEWER_HOST)
    viewer.add_argument("--port", type=int, default=DEFAULT_VIEWER_PORT)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if args.command == "viewer":
        import uvicorn

        uvicorn.run("madnolia.viewer:app", host=args.host, port=args.port, reload=False)
        return
    if args.command == "finalize":
        try:
            project_dir = finalize_project(
                args.project,
                args.model,
                InferenceBackend(args.backend),
                args.device,
            )
        except (OSError, RuntimeError, ValueError) as error:
            print(f"오류: {error}", file=sys.stderr)
            raise SystemExit(1) from error
        print(f"완료: {project_dir}")
        return
    try:
        project_dir = IngestionPipeline(
            args.model,
            InferenceBackend(args.backend),
            args.device,
        ).run(args.input, args.output, args.file)
    except (OSError, RuntimeError, ValueError) as error:
        print(f"오류: {error}", file=sys.stderr)
        raise SystemExit(1) from error
    print(f"완료: {project_dir}")


if __name__ == "__main__":
    main()
