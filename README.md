# Madnolia

Madnolia는 브라우저에서 음성 분석, 편집, 검색, 프로젝트와 콜라주 관리를 하는 정적 웹 앱입니다. 로컬 폴더를 연결하면 분석, 편집, 모델 다운로드와 내보내기가 사용자 기기에서 실행됩니다. 애플리케이션 백엔드는 필요하지 않습니다.

## 실행

최신 Chrome 또는 Edge를 사용하세요. 로컬 개발 서버(`localhost`) 또는 HTTPS에서 로컬 폴더 기능을 사용할 수 있습니다.

```powershell
cd web
npm ci
npm run dev
```

개발 확인과 프로덕션 빌드:

```powershell
npm test
npm run build
npm run preview
```

Vite 빌드는 상대 경로(`./`)를 사용하고 화면 경로는 hash 라우팅을 사용하므로 `https://USER.github.io/REPO/` 같은 GitHub Pages 하위 경로에 배포할 수 있습니다.

## 로컬 작업공간

앱에서 사용자가 폴더를 선택하면 그 폴더 안의 `media/`, `models/`, `analyses/`, `projects/`, `collages/`, `jobs/`를 읽고 씁니다. 선택한 폴더 핸들은 IndexedDB에 저장됩니다. 브라우저가 권한을 유지하지 않으면 다시 폴더 접근을 허용해야 합니다. 분석과 편집, 내보내기는 브라우저에서 처리되고 결과는 선택한 폴더에 저장됩니다.

첫 ASR 분석 때 Whisper 모델 파일을 인터넷에서 내려받아 작업공간의 `models/_transformers-cache/`에 둡니다. 지원 모델은 tiny(약 150 MB), base(약 290 MB), small(약 950 MB)입니다. `models/`에서 캐시된 모델을 관리할 수 있습니다. 웹페이지와 모델을 처음 불러올 때는 네트워크가 필요할 수 있으며, 서비스 워커를 제공하지 않으므로 앱 실행 전체가 오프라인이라고 보장하지 않습니다.

브라우저 작업공간은 Python 앱의 `data/` 형식과 다릅니다. 기존 Python 데이터와 모델은 그대로 두고, 별도 빈 폴더를 브라우저 작업공간으로 선택하세요. Python 구현은 `legacy/python` 브랜치의 `5528ab02b63338ce59bf049f7596d5e50657b53b` 커밋에 보존되어 있습니다. 웹 변경 사항이 있는 상태에서 브랜치를 전환하지 마세요.

## 브라우저 엔진과 한계

ASR은 Transformers.js와 ONNX Runtime Web을 사용합니다. 실행 장치로 지원되는 경우 WebGPU를 선택할 수 있고, WASM은 CPU에서 실행됩니다. GitHub Pages는 교차 출처 격리 헤더를 제공하지 않으므로 WASM은 단일 스레드로 동작합니다. 더 큰 모델은 더 많은 저장 공간과 메모리, 처리 시간을 사용하며 속도와 인식 품질은 기기와 모델에 따라 다릅니다.

인식된 단어 구간 안에서 에너지가 낮은 지점을 사용해 음소 시각을 추정하며, CTC 정렬과 HuBERT 음향 단위 분석은 제공하지 않습니다. 반복 음향 단위는 로컬 스펙트럼 특징 클러스터링을 사용합니다. 피치 추정과 시간 늘이기는 자체 상관 기반 피치 탐지, WSOLA와 FFT 기반 처리를 사용하며 PyWORLD 엔진과 결과가 다를 수 있습니다.

미디어 입력은 최대 1 GB 및 30분입니다. WAV 출력은 최대 30분, MP4 출력은 최대 10분이며 브라우저 메모리와 디코더 지원에도 영향을 받습니다.

## GitHub Pages 수동 배포

저장소 설정의 **Settings > Pages**에서 빌드 및 배포 소스를 **GitHub Actions**로 선택하세요. 이후 **Actions**에서 **Deploy web to GitHub Pages** 워크플로를 열고 **Run workflow**를 실행하면 `web/dist`만 배포됩니다. Python 소스, 로컬 사용자 데이터, 모델과 캐시는 배포 아티팩트에 포함되지 않습니다. 배포 설정과 상세 내용은 [정적 웹 안내](docs/static-web.md)를 참고하세요. 이 저장소에는 자동 배포 트리거가 설정되어 있지 않습니다.

음성 콜라주를 편집하고 JSON, WAV, MP4, EDL, FCPXML 형식으로 내보낼 수 있습니다. EDL/FCPXML을 NLE에서 사용할 때는 원본 미디어를 다시 연결해야 합니다. 브라우저는 원본 파일의 절대 경로를 제공하지 않습니다.
