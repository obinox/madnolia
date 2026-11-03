# Madnolia

Madnolia는 브라우저에서 음성 분석, 편집, 검색, 프로젝트와 콜라주 관리를 하는 정적 웹 앱입니다. 로컬 폴더를 연결하면 분석, 편집, 저장과 내보내기가 사용자 기기에서 실행됩니다. 애플리케이션 백엔드는 필요하지 않습니다.

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

처음 작업공간을 등록하면 `madnolia-browser.json` 표시를 만들고 그 폴더 안의 `media/`, `models/`, `analyses/`, `projects/`, `collages/`, `jobs/`를 사용합니다. 표시가 있는 작업공간은 같은 브라우저에서 다시 선택하거나, 권한을 허용해 다른 브라우저·PC 또는 웹사이트 주소가 바뀐 뒤에도 열 수 있습니다. 브라우저가 저장된 권한을 유지하지 않으면 다시 허용해야 합니다. 이 표시는 호환 형식을 확인하며 폴더의 신뢰성이나 안전성을 보증하지 않습니다.

ASR 모델을 쓰려면 BrowserWorkspace에서 별도 로컬 모델 폴더를 연결한 뒤, AnalysisPage의 **선택 모델 일괄 준비** 또는 개별 모델 컨트롤로 미디어를 불러오거나 분석하기 전에 설정된 기본·후보 ASR 모델과 활성화한 CTC·HuBERT 모델을 준비하세요. 같은 모델·revision·dtype의 호환 ONNX 파일은 재사용하고 누락된 파일만 내려받습니다. 분석은 모델을 자동 준비하거나 내려받지 않습니다. 기본 ASR은 Whisper large-v3 FP32이며 large-v3-turbo, small, base, tiny도 선택할 수 있습니다. VAD는 번들된 Silero VADv6를 별도 WASM worker에서 먼저 실행하고 완료 후 ASR을 시작합니다. 전사는 독립된 최대 30초 구간과 5초 중첩을 사용하며, 중첩 경계는 중간점으로 소유 구간을 나눕니다. 인접한 음성 구간 사이가 10초 이하면 직전 전사 최대 24단어를 문맥으로 전달합니다. 원래 VAD 임계값·패딩·병합, 토큰 상한과 반복 거부 정책을 유지합니다. 메모리 부족 시 정밀도나 모델을 자동으로 낮추지 않습니다. 모델 폴더는 파일 보관 위치이며 추론 메모리 사용량을 줄이지 않습니다. Python PyTorch와 `.safetensors` 체크포인트는 직접 읽을 수 없으며 같은 체크포인트의 호환 ONNX export가 필요합니다. 앱이나 모델의 첫 로딩은 네트워크가 필요할 수 있고, 서비스 워커가 없어 앱 전체의 오프라인 실행을 보장하지 않습니다.

최종 `dist`의 large-v3 Q4 WASM/WebGPU와 turbo Q8 WASM 스모크가 통과했습니다. 실행 조건과 범위는 [정적 웹 안내](docs/static-web.md#브라우저-음성-인식-검증)를 참고하세요.

브라우저 작업공간은 Python 앱의 `data/` 형식과 다르며 기존 Python 데이터를 자동으로 가져오지 않습니다. 기존 Python 데이터와 모델은 그대로 보존됩니다. Python 구현은 `legacy/python` 브랜치의 `5528ab02b63338ce59bf049f7596d5e50657b53b` 커밋에 보존되어 있습니다. Python 버전 이력은 브라우저 버전 전환 이력으로 통합되지 않습니다. 웹 변경 사항이 있는 상태에서 브랜치를 전환하지 마세요. 가져오기와 세부 제한은 [정적 웹 안내](docs/static-web.md)를 참고하세요.

## 브라우저 엔진과 한계

ASR은 Transformers.js와 ONNX Runtime Web을 사용합니다. 실행 장치로 지원되는 경우 WebGPU를 선택할 수 있고, WASM은 CPU에서 실행됩니다. GitHub Pages는 교차 출처 격리 헤더를 제공하지 않으므로 WASM은 단일 스레드로 동작합니다. 더 큰 모델은 더 많은 저장 공간과 메모리, 처리 시간을 사용하며 속도와 인식 품질은 기기와 모델에 따라 다릅니다.

Whisper 단어 timestamp는 실제 encoder frame에 맞춘 cross-attention 정렬과 DTW로 계산하며 균등 timestamp를 만들지 않습니다. Silero VADv6 출력과 Python 참조 간 확률 최대 오차는 1.37e-6입니다. 음소 정렬은 CTC logits와 IPA 토큰 동적 계획법을 사용합니다. HuBERT 음향 단위 분석은 768차원 구간 평균을 추출해 클러스터링합니다. 가져온 Python 버전 이력은 브라우저에서 전환할 수 없고, HuBERT 교차 분석 클러스터링은 Python 구현과 동등하지 않습니다. WER/CER은 측정하지 않았습니다. 음소 단위 피치 분석·자동 보정과 시간 늘이기는 자체 상관 기반 피치 탐지, WSOLA와 FFT 기반 처리를 사용합니다. 편집 구간의 region pitch points와 pitch note overlay는 PyWORLD 0.3.5 기반 WORLD WASM 경로를 사용하고, 다른 편집 구간은 상대 피치 DSP 분기를 유지합니다.

미디어 입력은 최대 1 GB 및 30분입니다. WAV 출력은 최대 30분, MP4 출력은 최대 10분이며 브라우저 메모리와 디코더 지원에도 영향을 받습니다.

## GitHub Pages 수동 배포

저장소 설정의 **Settings > Pages**에서 빌드 및 배포 소스를 **GitHub Actions**로 선택하세요. 이후 **Actions**에서 **Deploy web to GitHub Pages** 워크플로를 열고 **Run workflow**를 실행하면 `web/dist`만 배포됩니다. Python 소스, 로컬 사용자 데이터, 모델과 캐시는 배포 아티팩트에 포함되지 않습니다. 배포 설정과 상세 내용은 [정적 웹 안내](docs/static-web.md)를 참고하세요. 이 저장소에는 자동 배포 트리거가 설정되어 있지 않습니다.

음성 콜라주를 편집하고 JSON, WAV, MP4, EDL, FCPXML 형식으로 내보낼 수 있습니다. EDL/FCPXML을 NLE에서 사용할 때는 원본 미디어를 다시 연결해야 합니다. 브라우저는 원본 파일의 절대 경로를 제공하지 않습니다.

기존 분석은 프로젝트 화면의 분석 목록에서 선택해 CTC와 선택형 HuBERT를 재처리할 수 있습니다. ASR 전사 결과를 바꾸지 않으며 백업과 중단 복구를 지원합니다. ASR 작업은 저장된 체크포인트를 명시적으로 재개할 수 있습니다. 입력 영상의 메타데이터를 보존해 MP4, EDL, FCPXML 출력에 사용합니다. 기능과 검증 범위는 [정적 웹 안내](docs/static-web.md)를 참고하세요.
