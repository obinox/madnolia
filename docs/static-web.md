# 정적 웹 앱

## 실행과 배포

최신 Chrome 또는 Edge에서 HTTPS로 접속하거나 `localhost` 개발 서버를 사용하세요. 로컬 폴더 읽기와 쓰기는 브라우저의 File System Access API를 사용합니다.

```powershell
cd web
npm ci
npm run dev
npm test
npm run build
npm run preview
```

Vite는 상대 asset 경로 `./`를 빌드하며 앱 화면은 hash 라우팅을 사용합니다. 따라서 저장소 하위 경로인 `https://USER.github.io/REPO/`에서 동작합니다. GitHub Pages 런타임은 COOP/COEP 격리 헤더에 의존하지 않습니다.

Pages를 켜려면 저장소 **Settings > Pages**에서 배포 소스를 **GitHub Actions**로 설정합니다. `.github/workflows/release.yml`은 `workflow_dispatch`만 제공하므로, **Actions > Deploy web to GitHub Pages > Run workflow**에서 수동으로 시작합니다. 워크플로는 Ubuntu에서 Node 24로 `web/`의 `npm ci`, `npm test`, `npm run build`를 실행하고 `web/dist`를 업로드한 뒤 Pages에 배포합니다. 자동 배포나 Python 의존성은 없습니다. 이 안내는 배포 절차이며, 이 작업에서는 워크플로 실행이나 게시를 하지 않습니다.

배포물은 빌드된 정적 웹 파일뿐입니다. Python 소스, 기존 로컬 데이터와 모델, 캐시, 가상환경, 바이너리는 `web/dist`에 들어가지 않습니다.

## 로컬 작업공간과 모델

사용자가 읽기/쓰기 폴더를 선택하면 앱은 `madnolia-browser.json` 매니페스트를 만들고 `analyses/`, `projects/`, `collages/`, `media/`, `models/`, `jobs/`를 사용합니다. 폴더 핸들은 IndexedDB에 저장되며, 브라우저가 권한을 유지하지 않은 경우 재접속할 때 권한을 다시 허용해야 합니다. 분석, 편집, 프로젝트와 콜라주 저장, 미디어와 내보내기는 브라우저에서 실행되고 선택한 폴더에 기록됩니다. 앱 백엔드는 필요하지 않습니다.

첫 음성 인식 때 선택한 Whisper 모델 파일을 네트워크에서 받아 `models/_transformers-cache/`에 저장합니다. 선택 가능한 Transformers.js 모델은 다음과 같습니다.

| 모델 | 대략적인 크기 |
| --- | ---: |
| Whisper tiny | 150 MB |
| Whisper base | 290 MB |
| Whisper small | 950 MB |

브라우저 저장공간 여유와 메모리에 따라 사용 가능 여부가 달라질 수 있습니다. 앱 파일이나 모델을 처음 받을 때 네트워크가 필요할 수 있고 서비스 워커가 없으므로, 완전한 오프라인 앱 로딩을 보장하지 않습니다.

브라우저 작업공간 형식은 Python 앱의 `data/` 저장 형식과 다릅니다. 기존 폴더와 파일을 보존하고 새 빈 폴더를 브라우저 작업공간으로 연결하세요. 기존 Python 구현은 `legacy/python`의 `5528ab02b63338ce59bf049f7596d5e50657b53b` 커밋에 보존되어 있습니다. 작업 중인 웹 변경 사항을 보존하려면 브랜치를 전환하지 마세요.

## 엔진 차이와 제한

음성 인식은 Transformers.js와 ONNX Runtime Web을 사용합니다. 최신 브라우저에서 WebGPU를 쓸 수 있으면 GPU 추론을 선택할 수 있고, WASM CPU 추론도 지원합니다. GitHub Pages는 cross-origin isolation 헤더를 설정하지 않으므로 WASM 추론은 한 스레드로 실행됩니다. tiny는 가장 가볍고 small은 더 많은 로컬 저장공간과 메모리를 사용합니다. 처리 속도와 인식 품질은 모델, 브라우저, GPU, 기기에 따라 달라지며 기존 Python 엔진과 결과가 다를 수 있습니다.

단어 시각을 음소에 나눠 배정하는 에너지 기반 추정값을 사용합니다. CTC 강제 정렬이나 HuBERT 추론은 지원하지 않습니다. 반복 음향 특징 분석은 스펙트럼 특징을 클러스터링하는 방식입니다. 피치 추정은 자기상관 기반이고 시간 늘이기에는 WSOLA 계열 overlap-add 처리를 사용합니다. FFT 기반 DSP는 Python의 PyWORLD 처리와 음질 및 분석 결과가 다를 수 있습니다.

구현에 설정된 입력 상한은 미디어 파일 1 GB, 길이 30분입니다. WAV 출력은 최대 30분, MP4 출력은 최대 10분이며, 실제 처리 가능 범위는 기기의 메모리와 브라우저 디코더가 제한할 수 있습니다.

## 확인

Node 테스트와 프로덕션 빌드는 다음 명령으로 확인합니다.

```powershell
cd web
npm test
npm run build
```

브라우저 스모크 테스트는 빌드 후 `node tests/browser-static-smoke.mjs`로 실행합니다. 이 스크립트는 Pages 하위 경로로 정적 파일을 서빙해 폴더 선택과 새로고침 복원, API 네트워크 호출이 없는지 확인합니다. Chrome과 Edge 기본 설치 위치를 찾으며, 다른 위치의 실행 파일은 `CHROME_PATH` 환경 변수로 지정할 수 있습니다.

음성 콜라주를 편집하고 JSON, WAV, MP4, EDL, FCPXML 형식으로 내보낼 수 있습니다. EDL/FCPXML을 NLE에서 사용할 때는 원본 미디어를 다시 연결해야 합니다. 브라우저는 원본 파일의 절대 경로를 제공하지 않습니다.

브라우저 런타임 검증은 `web/`에서 실행합니다.

```powershell
node tests/browser-runtime-smoke.mjs
node tests/browser-runtime-smoke.mjs --asr
```

첫 명령은 실제 프로덕션 편집으로 WAV, 피치 및 오토튠 처리, H.264/AAC MP4 내보내기를 확인합니다. `--asr`는 공개 JFK 샘플과 Whisper tiny 모델을 내려받아 실제 추론을 실행하고, 이어 외부 모델 URL을 차단한 상태에서 두 번째 실행을 확인합니다. 두 모드는 임시 OPFS 브라우저 작업공간을 사용하며 공개 샘플과 모델을 내려받습니다. 사용자 파일에는 접근하지 않습니다.
