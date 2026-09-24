# Madnolia 프로젝트 구조와 워크플로우

현재 저장소의 추적 대상 파일을 기준으로 정리했다. `data/output/`, `data/projects/`, `data/collages/`, `data/cache/`, `.venv/`, `web/dist/` 등은 실행 중 생성되는 파일 또는 로컬 환경이므로 아래 파일 목록에서 제외했다.

## 프로젝트 개요

Madnolia는 한국어 영상에서 오디오를 추출하고, 음성을 전사한 뒤 단어와 IPA phone의 시간 구간을 분석하는 Python 프로젝트다. FastAPI 서버가 분석 결과와 미디어를 제공하고 React 뷰어에서 타임라인을 탐색하거나 검색한 발음 조각으로 오디오 콜라주를 만든다.

```text
madnolia/
├─ .gitignore
├─ README.md
├─ PROJECT_STRUCTURE.md
├─ pyproject.toml
├─ data/
│  └─ input/videos/.gitkeep
├─ src/madnolia/
│  ├─ __init__.py, constants.py, cli.py, pipeline.py
│  ├─ media.py, transcription.py, hierarchy.py, phonetics.py
│  ├─ alignment.py, ctc_alignment.py
│  ├─ acoustic_features.py, acoustic_units.py
│  ├─ storage.py, search.py, compositions.py
│  ├─ projects.py
│  ├─ time_stretch.py, exporters.py, viewer.py
│  └─ types/__init__.py, types/common.py
├─ tests/
│  └─ test_*.py
└─ web/
   ├─ package.json, package-lock.json, index.html, vite.config.ts
   ├─ tsconfig.json, tsconfig.app.json, tsconfig.node.json
   └─ src/
      ├─ main.tsx, App.tsx, api.ts, styles.css
      ├─ constants.ts, vite-env.d.ts, types/index.ts
      └─ components/Timeline.tsx, components/CollagePanel.tsx
         components/AnalysisPage.tsx, components/ProjectsPage.tsx
```

## 루트와 입력 파일

| 파일 | 역할 |
| --- | --- |
| `README.md` | 설치, CLI 실행, 뷰어 사용법과 결과 파일 설명. |
| `pyproject.toml` | Python 3.11 패키지와 의존성, `madnolia` 명령 진입점, pytest/ruff 설정. `dev`, `intel`, `web`, `alignment` 선택 설치 항목을 정의한다. |
| `.gitignore` | 캐시, 가상 환경, 입력 영상, 분석 결과, 빌드 결과 등의 추적 제외 규칙. |
| `data/input/videos/.gitkeep` | 기본 입력 디렉터리를 Git에 남기기 위한 빈 파일. 영상 자체는 추적하지 않는다. |
| `PROJECT_STRUCTURE.md` | 현재 구조와 실행 흐름을 설명하는 이 문서. |

## Python 파일: `src/madnolia/`

| 파일 | 역할 |
| --- | --- |
| `__init__.py` | 패키지 버전 선언. |
| `constants.py` | 입력·출력 경로, 기본 모델과 서버 주소, VAD·CTC·검색·모델 캐시·한글/IPA 변환 상수. |
| `cli.py` | `ingest`, `finalize`, `realign`, `viewer` 명령과 인자를 파싱해 파이프라인 또는 서버를 호출한다. |
| `pipeline.py` | 영상별 수집·전사·정렬·음향 분석을 순서대로 실행하고 JSON/SQLite/분석 매니페스트를 기록한다. 기존 결과 복구(`finalize`) 및 재정렬(`realign`)도 제공한다. |
| `projects.py` | 완료된 단일 영상 분석의 목록, 여러 분석을 묶는 프로젝트 생성, 기존 분석·콜라주·오디오 참조 마이그레이션, 공유 오디오 경로 확인. |
| `media.py` | PyAV로 영상 메타데이터를 확인하고 16 kHz 모노 WAV를 캐시에 한 번 추출한다. 추출 중 영상 타임스탬프로 진행률을 알린다. |
| `models.py` | Whisper·CTC·HuBERT 모델의 기존 파일을 확인하고 누락된 모델을 내려받는다. 파일 전송량을 알리고 필요한 OpenVINO 모델을 변환한다. |
| `transcription.py` | faster-whisper 또는 OpenVINO Whisper 전사, 단어 타임스탬프, Silero VAD 기반 발화/비발화 구간 구성. 전사된 영상 구간을 진행률 콜백으로 알린다. |
| `hierarchy.py` | 전사 단어를 문장으로 묶고 phone 정렬용 목표 발음을 구성한다. |
| `phonetics.py` | g2pk를 이용해 한국어 발음을 구하고 음절을 phone ID와 IPA로 변환한다. |
| `alignment.py` | 단어 시간 안에서 phone 위치를 추정하거나 CTC로 강제 정렬하여 phone 발생 구간을 만든다. |
| `ctc_alignment.py` | Wav2Vec2 CTC의 IPA 토큰화, 프레임 구간 탐색 및 정렬 경계 계산. |
| `acoustic_features.py` | phone별 RMS, peak, F0, 유성 확률 계산. |
| `acoustic_units.py` | 선택적으로 HuBERT 임베딩을 추출·군집화하고 phone에 음향 단위 ID를 부여한다. |
| `storage.py` | 분석 JSON 직렬화·복원, SQLite 테이블/인덱스 생성·마이그레이션과 분석 데이터 저장. |
| `search.py` | 입력 문장을 phone으로 바꾸고 코퍼스에서 연속 일치 구간 또는 유사 발음 후보를 찾아 점수를 매긴다. |
| `compositions.py` | 프로젝트 하나를 참조하는 독립 콜라주 JSON을 생성·조회·갱신하고 기존 콜라주·출력을 이전한다. |
| `time_stretch.py` | 콜라주 조각의 길이를 조정하는 오디오 시간 늘이기. |
| `exporters.py` | 조각을 합성하고 크로스페이드 처리해 WAV를 만들며 JSON, MP4, EDL, FCPXML도 내보낸다. |
| `viewer.py` | FastAPI 엔드포인트: 서버 영상 선택·비동기 분석 상태, 분석 목록·프로젝트 생성, 타임라인/파형/미디어 조회, 후보 검색, 콜라주 미리 듣기·저장·내보내기. 빌드된 웹 앱이 있으면 `/`에서 제공한다. |
| `types/common.py` | Python 전체의 열거형, 데이터 클래스, 요청 모델, 전사 프로토콜 등 공통 데이터 계약. |
| `types/__init__.py` | 공통 타입을 `madnolia.types`에서 재노출한다. |

## 웹 파일: `web/`

| 파일 | 역할 |
| --- | --- |
| `package.json` | React/Vite/TypeScript 의존성과 `dev`, `build`, `preview` 명령. |
| `package-lock.json` | npm 의존성 버전 잠금. |
| `index.html` | `#root`와 프런트엔드 모듈을 선언하는 HTML 진입점. |
| `vite.config.ts` | React 플러그인 및 개발 서버 `127.0.0.1:5173`의 `/api` → `127.0.0.1:8000` 프록시. |
| `tsconfig.json` | 앱과 Vite 설정용 TypeScript 프로젝트 참조. |
| `tsconfig.app.json` | React 앱의 엄격한 타입 검사와 JSX 설정. |
| `tsconfig.node.json` | `vite.config.ts` 타입 검사 설정. |
| `src/vite-env.d.ts` | Vite 클라이언트 타입 참조. |
| `src/main.tsx` | React 루트를 만들고 스타일 및 `App`을 연결한다. |
| `src/App.tsx` | 분석·프로젝트·콜라주 화면 주소를 연결하고, 프로젝트/영상 선택과 동영상 재생, 파형·타임라인 요청, 선택 구간 재생 상태를 관리한다. |
| `src/api.ts` | 백엔드 `/api` 호출, 콜라주 미리 듣기 및 내보내기 다운로드 함수. |
| `src/types/index.ts` | 프런트엔드가 공유하는 API 응답, 타임라인, 후보, 콜라주 타입. |
| `src/constants.ts` | 타임라인 범위·파형 해상도·색상·속도 조절 등 UI 공통 상수. |
| `src/styles.css` | 뷰어 화면 스타일. |
| `src/components/Timeline.tsx` | Canvas 파형/발화/단어/phone 표시와 확대, 이동, 구간 선택. |
| `src/components/CollagePanel.tsx` | 텍스트 검색, 후보 듣기·배치·순서/간격/속도 편집, 미리 듣기, 저장 및 내보내기 UI. |
| `src/components/AnalysisPage.tsx` | 입력 영상 선택, 분석 생성, 단계명·퍼센트 표시와 완료 후 다음 화면 이동. 서버 진행률 이하에서만 화면 숫자와 막대를 보간한다. |
| `src/components/ProjectsPage.tsx` | 분석 여러 개 선택 후 프로젝트 생성과 기존 프로젝트 열기. |

## 테스트 파일: `tests/`

| 파일 | 검증 대상 |
| --- | --- |
| `test_transcription.py` | VAD 구간 구성, 전사 창 분할, 문맥 프롬프트. |
| `test_media.py` | 추출 오디오 캐시 재사용과 원본 변경 시 갱신. |
| `test_phonetics.py` | 한글 발음→IPA 변환 및 단어 내 phone 시간. |
| `test_ctc_alignment.py` | IPA 토큰화와 CTC 프레임 정렬. |
| `test_acoustic_features.py` | F0와 무음의 유성 판별. |
| `test_acoustic_units.py` | 임베딩 군집 분리. |
| `test_storage.py` | confidence가 없는 phone의 저장. |
| `test_search.py` | 겹치는 정확 검색 구간과 유사 발음 후보. |
| `test_compositions.py` | 콜라주 저장·로드, WAV 내보내기와 미리 듣기/간격 일치. |
| `test_projects.py` | 기존 분석/콜라주 이전과 여러 분석을 선택한 프로젝트 조회 및 오디오 경로. |
| `test_analysis_progress.py` | 전사한 영상 구간의 진행률과 실패 시 마지막 진행 상태 보존. |
| `test_model_downloads.py` | 누락된 모델 파일 다운로드 진행률과 캐시 재사용. |

## 전체 워크플로우

1. `data/input/videos/`에 영상을 넣고 웹의 분석 생성 또는 `madnolia ingest`를 실행한다. CLI 기본 명령은 폴더의 영상을 하나씩 독립적인 분석으로 처리한다. `--file`로 폴더 내 특정 파일을 선택할 수 있다.
2. `models.py`가 필요한 모델 파일을 확인하고 누락됐으면 다운로드한다. 웹에서는 파일 전송량을 별도의 퍼센트로 보여준다. 파이프라인이 지원 확장자의 영상을 순회하며 `media.py`로 메타데이터를 확인하고 공유 캐시에 16 kHz 모노 WAV를 만든다. 분석 디렉터리에는 WAV를 복제하지 않고 `project.json`에 원본 영상 경로와 캐시 WAV 경로를 기록한다.
3. `transcription.py`가 발화/비발화 구간을 탐지하고 선택한 Whisper 백엔드로 한국어 문장과 단어·시간 정보를 만든다. `--candidate-model`을 지정했다면 같은 발화 구간에 추가 모델을 적용해 전사 후보도 보관한다.
4. `hierarchy.py`가 단어를 문장으로 묶는다. `phonetics.py`가 발음을 IPA phone으로 변환하고, 기본 설정에서는 `alignment.py`가 단어 시간으로 phone 구간을 추정한다. `--alignment ctc`면 `ctc_alignment.py`를 통해 강제 정렬한다.
5. `acoustic_features.py`가 phone별 특성을 계산한다. `--acoustic-units` 선택 시 `acoustic_units.py`가 HuBERT 특징을 군집화해 단위 ID와 중심점을 추가한다.
6. `storage.py`가 영상별 분석 JSON과 SQLite를 `data/output/proj_.../`에 기록한다. 웹에서는 `data/input/videos/`에 있는 영상을 선택해 분석 작업을 시작하고 진행 상태를 확인한다. 분석 JSON이 있으나 DB/매니페스트 작성이 실패했으면 `madnolia finalize --project ... --backend ...`로 복구할 수 있다. 기존 분석을 CTC로 다시 계산하려면 `madnolia realign --project ...`를 사용한다.
7. 웹에서 완료된 분석 여러 개를 선택하고 이름을 입력해 프로젝트를 만든다. 프로젝트 정의는 `data/projects/<project-id>/project.json`에 분석 ID와 영상별 연결 정보를 기록하며 원본 오디오와 분석 파일을 복제하지 않는다. 서버는 시작 시 기존 단일 영상 분석을 각각 프로젝트로 등록하고 기존 콜라주를 `data/collages/`로 이전한다.
8. 프로젝트를 열면 FastAPI가 선택된 분석들에서 미디어/파형/타임라인 데이터를 읽는다. 콜라주 패널에서 문장을 검색하면 `search.py`가 모든 선택 분석의 phone 후보를 모은다. 조각 배치·미리 듣기·저장은 `compositions.py`와 `exporters.py`를 거쳐 독립된 콜라주 디렉터리에 기록된다. 각 콜라주는 프로젝트 ID 하나를 참조한다.

```text
입력 영상 → 공유 캐시 WAV → 영상별 전사·phone 분석 → data/output/<analysis-id>/
          → 분석 여러 개 선택 → data/projects/<project-id>/
          → 프로젝트 전체 검색 → data/collages/<collage-id>/ (프로젝트 ID 참조)
```

### 실행 예시

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev,web,intel,alignment]"
madnolia ingest --backend faster-whisper --device CPU --model tiny --alignment estimated --no-acoustic-units
cd web
npm install
npm run build
cd ..
madnolia viewer
```

웹에서 `data/input/videos/`의 영상을 선택하고 `#/analysis`(분석 생성), `#/projects`(분석 선택·프로젝트 생성), `#/collage/<project-id>`(콜라주 제작) 화면을 순서대로 사용할 수 있다. 저장된 콜라주는 `#/collages/<collage-id>`로 직접 열 수 있다. 분석 화면에서 모델, 백엔드, CPU/GPU, 정렬, 추가 전사 모델, 음향 단위 분석을 설정할 수 있다. 웹 기본값은 OpenVINO GPU `large-v3` 전사, CTC 정렬, HuBERT 음향 단위 분석이다. 모델 파일이 없으면 필요한 파일을 다운로드하며 파일 전송량 기준 진행률을 별도 막대로 표시한다. CTC/HuBERT의 OpenVINO 변환은 별도 단계로 표시한다. 일시정지·중단 요청은 현재 처리 구간이 끝나는 검사 지점에서 반영되며, 중단 시 미완료 분석 디렉터리는 정리하고 공유 오디오 캐시는 보존한다. 분석 진행률은 남은 시간의 추정치가 아니다. CLI로 만든 단일 영상 분석도 웹에서 선택할 수 있다. 개발 중에는 뷰어를 `cd web; npm run dev`로 실행하면 Vite가 API 요청을 FastAPI로 프록시한다. CTC 기능을 사용하려면 Python 선택 의존성 `alignment`가, Intel GPU OpenVINO를 사용하려면 `intel`이 추가로 필요하다. Python 검증은 저장소 루트에서 `pytest`, 프런트엔드 타입 검사와 빌드는 `cd web; npm run build`로 실행한다.

### 결과 디렉터리 예시

```text
data/output/proj_<생성시각>/          # 단일 영상 분석
├─ project.json                     # 분석 매니페스트, 원본 경로·캐시 WAV 참조(audio_files)
├─ corpus.sqlite3                   # 영상·phone·발화·음향 특성 테이블
├─ analysis/<source_id>.json        # 원본별 전사/구간/phone 분석
└─ analysis/acoustic_unit_centroids.npy  # --acoustic-units 선택 시

data/projects/<project-id>/          # 분석들의 집합
└─ project.json                     # 선택 분석 ID·원본별 분석 연결

data/collages/<collage-id>/          # 콜라주: 프로젝트 ID 하나 참조
├─ collage.json                     # 배치한 구간·연결된 프로젝트 ID
└─ exports/                         # 요청한 출력 파일

data/cache/audio/<캐시키>.wav       # 공유 PCM 오디오
data/cache/audio/<캐시키>.json      # 원본 영상 경로·WAV 경로·영상 변경 정보
```

입력 영상의 경로는 `project.json`에 저장되며 뷰어의 영상 재생은 해당 원본 파일을 참조한다. 따라서 생성된 프로젝트를 뷰어에서 재생할 때는 원본 영상도 그 경로에 있어야 한다.
