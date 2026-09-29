# Madnolia

## 웹 워크플로우

서버의 `data/input/videos/`에 영상을 넣고 뷰어를 실행하면 **영상 분석 생성 → 완료된 분석 여러 개 선택 후 프로젝트 생성 → 프로젝트와 연결된 합성 생성** 순서로 작업할 수 있습니다. 웹 분석은 기본 OpenVINO GPU `large-v3` 모델, CTC 정렬, HuBERT 음향 단위 분석으로 실행됩니다. 분석 화면에서 모델·실행 방식·장치·정렬·추가 전사 모델·음향 단위 분석을 선택하고 작업을 일시정지·계속·중단할 수 있습니다. 필요한 모델이 없으면 다운로드 진행률을 표시하고 자동으로 준비합니다. 분석은 프로젝트와 별개이며, 완료된 분석을 선택해 프로젝트를 직접 만듭니다. 서버 시작 시에는 프로젝트를 자동 생성하지 않고 기존 분석 오디오 경로와 실제 프로젝트의 레거시 합성만 마이그레이션합니다. 프로젝트 메타데이터는 `data/projects/`, 합성과 내보내기 파일은 `data/collages/`에 독립적으로 저장됩니다.

웹 화면은 `#/analysis`, `#/projects`, `#/collage/<project-id>`로 구분됩니다. 분석 화면에서 단계별 진행률과 오디오 추출·전사가 처리한 영상 구간의 비율을 볼 수 있습니다. 
구현 파일과 데이터 흐름은 [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md)에 정리되어 있습니다.
전문 합성의 기능 범위와 단계별 계획은 [전문 합성 편집기 명세](docs/PROFESSIONAL_SYNTHESIS_SPEC.md)에 정리되어 있습니다.

합성의 음소 검색은 한국어·영어·일본어 입력을 지원하며, 자동 감지 또는 언어 직접 선택으로 각 언어의 발음에 맞춰 검색합니다. 중국어는 지원하지 않습니다. 한자만 포함된 입력은 언어를 구분할 수 없으므로 일본어를 직접 선택해야 합니다.

발화가 포함된 영상을 로컬 Whisper 또는 Qwen3-ASR로 분석하고, 발음형 IPA phone 구간을 JSON과 SQLite로 저장합니다.

## 준비

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev,web,intel,alignment,qwen]"
```

FFmpeg 실행 파일은 필요하지 않습니다. PyAV가 영상의 오디오를 직접 디코딩합니다. Whisper·Qwen3-ASR 모델과 G2P 데이터는 첫 실행 시 다운로드되며 API 요금은 발생하지 않습니다.

## 웹 실행

```powershell
python -m pip install -e ".[web]"
cd web
npm install
npm run build
cd ..
madnolia viewer
```

브라우저에서 `http://127.0.0.1:8000`을 엽니다. 영상과 waveform, 발화·비발화 구간, 단어, IPA phone을 동기화해서 확인할 수 있습니다.

`VOICE SYNTHESIS`에서 문장을 검색하면 입력 음소 범위를 덮는 긴 연속 후보와 짧은 후보가 함께 표시됩니다. 정확한 음소가 코퍼스에 없으면 빨간색 `유사` 후보로 구분됩니다. 후보를 직접 배치한 뒤 합성 프로젝트로 저장하고 WAV, MP4, JSON, CMX 3600 EDL, FCPXML로 내보낼 수 있습니다.

원본 영상은 `data/input/videos/`에 두고, 분석이 기록하는 원본 경로로 참조합니다. 영상에서 추출한 WAV는 `data/cache/audio/<캐시키>.wav`에 공유 저장되며 같은 이름의 JSON에 원본 영상 경로와 WAV 경로가 기록됩니다. 분석은 `data/output/<analysis-id>`, 분석을 모은 프로젝트는 `data/projects/<project-id>`, 프로젝트 하나를 참조하는 합성은 `data/collages/<collage-id>`에 생성됩니다. 분석 결과는 `versions/<uuid>/` 아래 새 버전으로 완성한 뒤, 루트 `project.json`을 마지막에 갱신해 활성 버전을 가리킵니다. 발행되지 않은 버전 디렉터리는 무시되며 자동 복구나 롤백 UI는 제공하지 않습니다. 이전 저장 형식의 루트 파일도 계속 읽을 수 있고, 이전 버전은 보존됩니다.

- `project.json`: 활성 분석 버전과 공유 오디오 경로를 가리키는 매니페스트
- `versions/<uuid>/corpus.sqlite3`: 해당 버전의 phone 검색용 코퍼스
- `project.json`의 `audio_files`: 공유 캐시 오디오의 경로
- `data/cache/audio/*.wav`: 영상에서 추출한 16kHz mono PCM 오디오
- `versions/<uuid>/analysis/<source_id>.json`: 버전별 전사와 IPA phone 구간
- `versions/<uuid>/analysis/acoustic_unit_centroids.npy`: 음향 단위 분석을 선택한 경우의 중심점
- 기존 형식의 `analysis/*.json`도 읽을 수 있습니다.
- `data/collages/<collage-id>/collage.json`: 연결된 프로젝트 ID와 배치한 오디오 조각
- `data/collages/<collage-id>/exports/*`: 렌더링 및 NLE 익스포트 결과

Silero VAD가 원본 시간축을 `SPEECH`와 `NON_SPEECH` 구간으로 나눕니다. 비발화 구간은 프로젝트에 보존되지만 Whisper 전사와 IPA 인덱싱에서는 제외됩니다.

`--alignment ctc`를 사용하면 Wav2Vec2 CTC가 IPA phone 경계를 정렬하며 결과는 `ALIGNED`, `LOW_CONFIDENCE`, `MISSING`으로 구분됩니다. HuBERT 음향 단위와 F0, RMS, peak, voiced probability도 phone별로 함께 저장됩니다.


## CLI로 실행

영상을 `data/input/videos`에 넣고 실행합니다.

```powershell
madnolia ingest
```

분석 기본값은 OpenVINO GPU `large-v3` 전사, CTC 정렬, HuBERT 음향 단위 분석입니다. CPU에서 가볍게 확인하려면 다음 명령을 사용합니다.

```powershell
madnolia ingest --backend faster-whisper --device CPU --model tiny --alignment estimated --no-acoustic-units
```

Qwen3-ASR 0.6B와 1.7B는 PyTorch로 실행합니다. 단어 시간 정보에는 별도 Qwen3 강제 정렬 모델이 사용됩니다.
Intel GPU에서는 PyTorch의 XPU 빌드를 설치한 뒤 `--device XPU`를 선택할 수 있습니다. 두 ASR 모델은 같은 0.6B 강제 정렬 모델을 사용합니다.

```powershell
python -m pip install --index-url https://download.pytorch.org/whl/xpu "torch==2.14.0+xpu"
madnolia ingest --backend qwen3-asr --device XPU --model qwen3-asr-0.6b --file "data/input/videos/video.mp4"
```

```powershell
madnolia ingest --backend qwen3-asr --device CPU --model qwen3-asr-0.6b --file "data/input/videos/video.mp4"
madnolia ingest --backend qwen3-asr --device CPU --model qwen3-asr-1.7b --file "data/input/videos/video.mp4"
```

Intel GPU에서는 OpenVINO 추가 의존성을 설치하고 실행합니다.

```powershell
python -m pip install -e ".[intel]"
madnolia ingest --backend openvino --device GPU --model small --file "data/input/videos/video.mp4"
```

한국어 전사 품질을 우선하면 30초 문맥 창과 5초 중첩 병합을 사용하는 `large-v3-turbo`를 선택합니다.

```powershell
madnolia ingest --backend openvino --device GPU --model large-v3-turbo --file "data/input/videos/video.mp4"
```

비터보 `large-v3` INT8 모델은 다음과 같이 실행합니다.

```powershell
madnolia ingest --backend openvino --device GPU --model large-v3 --file "data/input/videos/video.mp4"
```

같은 VAD 발화 구간에 복수 Whisper 모델을 적용하려면 후보 모델을 추가합니다.

```powershell
madnolia ingest --backend openvino --device GPU --model large-v3-turbo --candidate-model large-v3 --file "data/input/videos/video.mp4"
```

IPA CTC 실제 경계 정렬을 함께 실행하려면 다음 옵션을 사용합니다.

```powershell
madnolia ingest --backend openvino --device GPU --model large-v3-turbo --candidate-model large-v3 --alignment ctc --acoustic-units --file "data/input/videos/video.mp4"
```

`finalize`는 활성 매니페스트의 분석 파일(매니페스트가 없는 기존 형식은 `analysis/*.json`)로 새 버전을 생성합니다. 미발행 버전 디렉터리는 자동으로 선택하지 않습니다.

```powershell
madnolia finalize --project "data/output/<project-id>" --backend openvino --device GPU
```


