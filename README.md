# Madnolia

## 웹 워크플로우

서버의 `data/input/videos/`에 영상을 넣고 뷰어를 실행하면 **영상 분석 생성 → 완료된 분석 여러 개 선택 후 프로젝트 생성 → 프로젝트와 연결된 콜라주 생성** 순서로 작업할 수 있습니다. 웹 분석은 기본 OpenVINO GPU `large-v3` 모델, CTC 정렬, HuBERT 음향 단위 분석으로 실행됩니다. 분석 화면에서 모델·실행 방식·장치·정렬·추가 전사 모델·음향 단위 분석을 선택하고 작업을 일시정지·계속·중단할 수 있습니다. 필요한 모델이 없으면 다운로드 진행률을 표시하고 자동으로 준비합니다. 기존 `data/output/`의 단일 영상 분석은 서버 시작 시 각각 프로젝트로 연결됩니다. 프로젝트 메타데이터는 `data/projects/`, 콜라주와 내보내기 파일은 `data/collages/`에 독립적으로 저장됩니다.

웹 화면은 `#/analysis`, `#/projects`, `#/collage/<project-id>`로 구분됩니다. 분석 화면에서 단계별 진행률과 오디오 추출·전사가 처리한 영상 구간의 비율을 볼 수 있습니다. 
구현 파일과 데이터 흐름은 [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md)에 정리되어 있습니다.

발화가 포함된 영상을 로컬 Whisper로 분석하고, 발음형 IPA phone 구간을 JSON과 SQLite로 저장합니다.

## 준비

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev,web,intel,alignment]"
```

FFmpeg 실행 파일은 필요하지 않습니다. PyAV가 영상의 오디오를 직접 디코딩합니다. Whisper 모델과 G2P 데이터는 첫 실행 시 다운로드되며 API 요금은 발생하지 않습니다.

## 실행

영상을 `data/input/videos`에 넣고 실행합니다.

```powershell
madnolia ingest
```

분석 기본값은 OpenVINO GPU `large-v3` 전사, CTC 정렬, HuBERT 음향 단위 분석입니다. CPU에서 가볍게 확인하려면 다음 명령을 사용합니다.

```powershell
madnolia ingest --backend faster-whisper --device CPU --model tiny --alignment estimated --no-acoustic-units
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

분석 JSON 생성 후 DB 저장만 실패한 경우 프로젝트를 복구할 수 있습니다.

```powershell
madnolia finalize --project "data/output/<project-id>" --backend openvino --device GPU
```

## 검수 뷰어

```powershell
python -m pip install -e ".[web]"
cd web
npm install
npm run build
cd ..
madnolia viewer
```

브라우저에서 `http://127.0.0.1:8000`을 엽니다. 영상과 waveform, 발화·비발화 구간, 단어, IPA phone을 동기화해서 확인할 수 있습니다.

`AUDIO COLLAGE`에서 문장을 검색하면 입력 음소 범위를 덮는 긴 연속 후보와 짧은 후보가 함께 표시됩니다. 정확한 음소가 코퍼스에 없으면 빨간색 `유사` 후보로 구분됩니다. 후보를 직접 배치한 뒤 조립 프로젝트로 저장하고 WAV, MP4, JSON, CMX 3600 EDL, FCPXML로 내보낼 수 있습니다.

원본 영상은 `data/input/videos/`에 두고, 분석이 기록하는 원본 경로로 참조합니다. 영상에서 추출한 WAV는 `data/cache/audio/<캐시키>.wav`에 공유 저장되며 같은 이름의 JSON에 원본 영상 경로와 WAV 경로가 기록됩니다. 분석은 `data/output/<analysis-id>`, 분석을 모은 프로젝트는 `data/projects/<project-id>`, 프로젝트 하나를 참조하는 콜라주는 `data/collages/<collage-id>`에 생성됩니다.

- `project.json`: 분석 정보와 공유 오디오 경로
- `corpus.sqlite3`: phone 검색용 코퍼스
- `project.json`의 `audio_files`: 공유 캐시 오디오의 경로
- `data/cache/audio/*.wav`: 영상에서 추출한 16kHz mono PCM 오디오
- `analysis/*.json`: 영상별 전사와 IPA phone 구간
- `data/collages/<collage-id>/collage.json`: 연결된 프로젝트 ID와 배치한 오디오 조각
- `data/collages/<collage-id>/exports/*`: 렌더링 및 NLE 익스포트 결과

Silero VAD가 원본 시간축을 `SPEECH`와 `NON_SPEECH` 구간으로 나눕니다. 비발화 구간은 프로젝트에 보존되지만 Whisper 전사와 IPA 인덱싱에서는 제외됩니다.

`--alignment ctc`를 사용하면 Wav2Vec2 CTC가 IPA phone 경계를 정렬하며 결과는 `ALIGNED`, `LOW_CONFIDENCE`, `MISSING`으로 구분됩니다. HuBERT 음향 단위와 F0, RMS, peak, voiced probability도 phone별로 함께 저장됩니다.
