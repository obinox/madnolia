# 정적 웹 앱

구현 전 조사 기록인 [정적 웹 parity 보고서](STATIC_WEB_PARITY_REPORT.md)와 [정적 웹 타당성 조사](STATIC_WEB_FEASIBILITY.md)는 일부 항목에서 당시의 작은 모델·기능 상태를 설명합니다. 현재 구현과 검증 상태는 이 문서를 기준으로 확인하세요.

## 실행과 배포

최신 Chrome 또는 Edge에서 HTTPS로 접속하거나 `localhost` 개발 서버를 사용하세요. 로컬 폴더 읽기와 쓰기는 브라우저의 File System Access API를 사용합니다.

앱은 정적 파일로 제공되며 분석, 편집, 저장과 내보내기는 브라우저에서 실행됩니다. 별도 백엔드 서버나 Madnolia 애플리케이션 API는 필요하지 않습니다. 내부 호환 경로 `/api/...`도 브라우저 안에서 처리합니다. 모델 저장소의 파일 목록과 가중치, 샘플 같은 외부 리소스는 기능을 실행할 때 내려받을 수 있습니다.

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

배포물은 정적 웹 앱 파일, 브라우저용 WASM 모듈과 음성사전 등 앱에 포함된 리소스입니다. Python 소스·런타임, 기존 사용자 데이터와 모델 캐시, Python 가상환경, 플랫폼 실행 파일은 `web/dist`에 들어가지 않습니다. Whisper·CTC·HuBERT 모델 가중치는 별도 모델 다운로드 및 브라우저 캐시를 사용합니다.

## 로컬 작업공간과 모델

처음 작업공간을 등록하면 앱은 `madnolia-browser.json` 표시를 만들고 `analyses/`, `projects/`, `collages/`, `media/`, `models/`, `jobs/`를 사용합니다. 표시가 있는 작업공간은 같은 브라우저에서 다시 선택하거나, 권한을 허용해 다른 브라우저·PC 또는 웹사이트 주소가 바뀐 뒤에도 열 수 있습니다. 폴더 핸들은 IndexedDB에 저장되며 브라우저가 권한을 유지하지 않으면 다시 허용해야 합니다. 표시가 없는 기존 데이터 폴더는 자동 등록하지 않습니다. Python 앱의 `data/`는 자동 병합하지 않으며, 작업공간 상단의 **Python 데이터 가져오기**에서 Python `data/` 폴더를 선택해 명시적으로 가져옵니다. 분석을 가져오려면 `output/`이 필요하고, `projects/` 컬렉션은 그 안의 분석을 참조할 때 함께 가져옵니다. manifest에 지정된 분석 JSON과 캐시 오디오를 새 브라우저 분석·프로젝트로 복사합니다. SQLite는 `legacy-imports/<id>/corpus.sqlite3`에 원본 그대로 보존되며 브라우저에서 열거나 변환하지 않습니다. HuBERT centroid NPY는 브라우저 JSON으로 변환하고 원본 NPY도 보존합니다. `output/<id>/compositions/`와 `projects/<id>/compositions/`의 콜라주는 새 프로젝트 및 소스 ID로 연결해 브라우저 `collages/`에 변환합니다. 부모 콜라주 ID도 변환하며, 원본 export 파일은 `legacy-imports/<id>/collages/`에 보존합니다. 인덱스에 이미 있는 동명 미디어는 덮어쓰지 않습니다. 원본 미디어가 없으면 분석과 오디오는 가져오되 누락을 집계하며, 해당 미디어가 필요한 작업에는 `data/input/videos`에 원본을 연결한 뒤 다시 가져오라는 안내가 표시됩니다. 캐시 오디오가 없으면 해당 분석은 가져오지 못합니다. Python `versions/`의 JSON, SQLite, centroid 파일은 `legacy-imports/<id>/analysis-versions/`에 보존되지만 브라우저의 버전 전환 이력으로 통합되지는 않습니다. 가져오기에 실패하면 그 시도에서 만든 브라우저 분석·프로젝트·콜라주·보존 파일을 정리합니다. 가져오기 중에는 다른 전역 작업과 작업공간 폴더 변경이 잠깁니다. 표시는 호환 형식만 식별하며 서명, 신뢰 또는 모델 캐시 경로 검증 수단이 아닙니다.

먼저 BrowserWorkspace에서 별도 로컬 모델 폴더를 연결하세요. AnalysisPage의 **선택 모델 일괄 준비**는 미디어를 불러오거나 분석하기 전에 현재 설정의 기본·후보 ASR 모델과 켜 둔 CTC·HuBERT 모델을 선택한 정밀도와 실행 장치로 준비합니다. 모델별 컨트롤로 각각 준비할 수도 있습니다. 같은 모델·리비전·dtype의 호환 ONNX 파일은 재사용하고 빠진 파일만 내려받아 `.madnolia-models/files/`에 저장하며 `.madnolia-models/index.json`에 기록합니다. BrowserWorkspace의 모델 저장소에서도 모델 하나씩 준비할 수 있습니다. 분석 중에는 모델을 자동으로 준비하거나 내려받지 않으며, 분석 요청은 연결된 폴더에서 선택한 모델들이 준비됐는지 확인합니다. 브라우저가 폴더 권한을 유지하지 않으면 저장된 폴더를 다시 연결해 권한을 허용하세요. 모델 폴더는 모델 파일의 보관 위치이며 추론 중 메모리 요구량을 줄이지 않습니다. 이 경로가 지원하는 모델 파일은 ONNX입니다. Python PyTorch 및 `.safetensors` 가중치는 브라우저에서 직접 읽을 수 없으므로, 같은 체크포인트의 호환 ONNX export가 필요합니다.

선택 가능한 Transformers.js 모델은 다음과 같습니다.

| 모델 | 대략적인 크기 |
| --- | ---: |
| Whisper tiny | 150 MB |
| Whisper base | 290 MB |
| Whisper small | 950 MB |
| Whisper large-v3 / large-v3-turbo | varies by device and precision |

브라우저 저장공간 여유와 추론 중 메모리에 따라 사용 가능 여부가 달라질 수 있습니다. 기본 정밀도 선택은 FP32이며 큰 모델의 메모리 요구량을 자동으로 줄이거나 다른 모델로 바꾸지 않습니다. `장치별 양자화`의 dtype은 모델 종류와 실행 장치에 따라 다릅니다. 앱 파일이나 모델을 처음 받을 때 네트워크가 필요할 수 있고 서비스 워커가 없으므로, 완전한 오프라인 앱 로딩을 보장하지 않습니다.

브라우저 작업공간 형식은 Python 앱의 `data/` 저장 형식과 다릅니다. Python 데이터를 가져오려면 대상 브라우저 작업공간을 먼저 연결한 뒤 명시적 가져오기를 실행하세요. `madnolia-browser.json` 표식이 있는 호환 브라우저 작업공간은 기존 작업공간 열기로 다시 열 수 있습니다. 기존 Python 구현은 `legacy/python`의 `5528ab02b63338ce59bf049f7596d5e50657b53b` 커밋에 보존되어 있습니다. 작업 중인 웹 변경 사항을 보존하려면 브랜치를 전환하지 마세요.

## 엔진 차이와 제한

음성 인식은 Transformers.js와 ONNX Runtime Web을 사용합니다. 기본은 Whisper large-v3 FP32이며 large-v3-turbo와 small, base, tiny도 명시적으로 선택할 수 있습니다. 사용자는 정밀도와 WASM/WebGPU 장치를 선택하며 실패 시 모델·dtype 자동 대체는 없습니다. 저장한 분석 provenance에는 실제 사용한 모델 ID, revision, dtype, 장치와 CTC·HuBERT 사용 여부 및 설정이 기록됩니다. GitHub Pages는 cross-origin isolation 헤더를 설정하지 않으므로 WASM 추론은 한 스레드로 실행됩니다.

전사 전에 번들된 Silero VADv6 ONNX를 별도 WASM worker에서 실행하고, 그 worker를 종료한 뒤 ASR을 시작합니다. 16 kHz 입력을 독립 30초 블록으로 처리하며 원래 임계값(시작 0.5, 종료 0.35), 최소 음성 250ms·무음 500ms, 200ms 패딩, 블록별 상태 초기화와 400ms 병합 정책을 따릅니다. Silero Python 참조와 비교한 확률의 최대 오차는 1.37e-6입니다. ASR은 음성 구간을 최대 30초 창으로 나누고 5초 중첩 창의 경계를 중간점 기준으로 소유합니다. 10초 이내 간격이면 직전 최대 24단어를 문맥으로 전달합니다. `max_new_tokens`는 Python 방식으로 반올림한 (창 길이(초)×10)을 32~300으로 제한하며, 8단어 이상에서 특정 단어 빈도가 0.75 이상이면 반복 전사를 거부합니다.

Whisper의 단어 timestamp는 autoregressive cross-attention을 encoder의 실제 20ms 프레임 범위로 잘라 DTW로 계산합니다. 10ms mel 프레임과 혼동하지 않으며, 분산이 0인 attention은 정규화 결과 0으로 처리합니다. 이전 문맥 토큰은 DTW 전에 제외하고 tokenizer decode 전에 token ID와 timestamp에서 함께 제거합니다. 디코더에는 실제 prompt token ID를 전달합니다. timestamp를 균등 분배하는 대체 경로는 없습니다. 아래 production smoke 결과는 명시된 모델·장치 조합에만 해당하며 기기별 성능, Python 대비 인식 품질, 모든 조합의 성공은 보장하지 않습니다.

기본 음소 정렬은 wav2vec2 CTC 모델의 logits와 IPA 토큰 동적 계획법을 사용합니다. 정렬 모델은 Whisper와 별도의 기존 espeak phoneme CTC checkpoint 변환본입니다. 사용할 수 없는 음소 토큰은 `MISSING` 및 낮은 confidence로 저장하며 단어 구간 기반 경계를 보존합니다. 모델이 유효한 단어 timestamp를 반환하지 않으면 균등 분할로 바꾸지 않고 분석을 실패시킵니다. 대형 Whisper 및 CTC 양자화 결과는 Python 기준과 아직 비교하지 않았습니다.

영어 발음 변환은 CMU 발음 사전과 OOV용 GRU 모델을, 한국어는 g2pK와 MeCab 사전을 사용합니다. 일본어 읽기 데이터는 pykakasi 2.3.0의 Kanwa·Itaiji·Hepburn 자료에서 생성되며 GPLv3 라이선스와 작성자 표기는 `web/src/browser/phonetics/assets/ja-g2p/`에 포함되어 있습니다. 프로덕션 브라우저 smoke에서 한국어 `국물` 6 phones, 영어 OOV `madnolia` 9 phones, 일본어 `がっこう` 5 phones가 fixture와 일치했습니다. 이 fixture 검증은 전체 발음 품질이나 모든 입력에 대한 Python과의 동등성을 보장하지 않습니다. 다른 음성 자산의 라이선스 고지도 각 자산 디렉터리에 포함됩니다.

음향 단위 분석은 HuBERT base hidden output의 768차원 구간 평균을 추출하고 현재 분석에 포함된 음소 구간에서 최대 64개 군집을 세 번 반복해 계산합니다. centroid는 분석별 `analyses/<id>/acoustic-units.json`에 저장합니다. 여러 분석이나 프로젝트를 합친 군집화와 Python 군집 ID의 완전한 일치는 지원하지 않습니다. 음향 특징의 RMS, peak, F0와 유성도는 브라우저 추정입니다. 음소 음향 특징 계산은 원본 구현처럼 음소 경계 앞뒤 40ms 문맥을 사용하며 FFT, 자기상관 기반 피치 및 유성도 특징을 추출합니다.

남은 호환성 공백은 Python `versions/` 기록이 보존되지만 브라우저에서 live-switch 가능한 버전 이력으로 통합되지 않는 점, HuBERT cross-analysis clustering이 Python 동작과 동등하지 않은 점입니다. WER/CER은 측정하지 않았습니다. 확인된 smoke는 명시된 fixture와 모델 조합에 한정되며 모든 모델·dtype·장치의 성공이나 인식 동등성을 뜻하지 않습니다.

편집 구간의 region pitch points와 pitch note overlay는 PyWORLD 0.3.5 submodule revision에 고정된 WASM 경로를 사용합니다. 원래 WSOLA 렌더링을 바탕으로 WORLD 결과는 피치 점 또는 음표가 지정된 구간에만 덮어씁니다. WORLD 프레임 간격은 5ms이고 출력 마지막 프레임의 종단 매핑과 전체 구간의 peak limit을 적용합니다. worker 출력을 원본 PyWORLD 0.3.5와 전체 타임라인으로 비교했으며 파형 RMS 차이는 약 `1e-10`이었습니다. 이 수치는 해당 비교 fixture의 파형 일치 결과이며 다른 입력의 음질 동등성을 보증하지 않습니다.

구현에 설정된 입력 상한은 미디어 파일 1 GB, 길이 30분입니다. WAV 출력은 최대 30분, MP4 출력은 최대 10분이며, 실제 처리 가능 범위는 기기의 메모리와 브라우저 디코더가 제한할 수 있습니다.

## 확인

Verified 2026-11-02: canonical tests passed 145/145 with 0 skipped; final production build, static smoke, and production WAV and H.264/AAC MP4 media smoke passed.

2026-11-02 기준 프로덕션 언어는 한국어(`ko`), 작업은 전사(`transcribe`)이며 기존 Python 구현도 같습니다. JFK ASR 스모크는 영어(`en`)를 명시적으로 설정합니다. 발음 fixture의 언어 설정은 별도이며, 이 검증은 일반적인 발음 품질이나 구현 동등성을 입증하지 않습니다.

재현 명령은 다음과 같습니다.

```powershell
cd web
npm test
npm run build
```

브라우저 스모크 테스트는 빌드 후 `node tests/browser-static-smoke.mjs`로 실행합니다. 이 스크립트는 Pages 하위 경로로 정적 파일을 서빙해 OPFS 폴더 선택과 새로고침 복원, 앱 API 네트워크 호출이 없는지 확인합니다. Chrome과 Edge 기본 설치 위치를 찾으며, 다른 위치의 실행 파일은 `CHROME_PATH` 환경 변수로 지정할 수 있습니다.

음성 콜라주를 편집하고 JSON, WAV, MP4, EDL, FCPXML 형식으로 내보낼 수 있습니다. EDL/FCPXML을 NLE에서 사용할 때는 원본 미디어를 다시 연결해야 합니다. 브라우저는 원본 파일의 절대 경로를 제공하지 않습니다.

### 브라우저 음성 인식 검증

Whisper large-v3의 기본 정밀도는 FP32입니다. `Xenova/whisper-large-v3` revision `67bf02d92b7754a1ff82a7f8545f8b8c378b2ef0`의 external-data sidecar는 6,173,962,240 bytes(약 5.75 GiB)입니다. 이는 wasm32의 4 GiB 주소 공간 한계를 넘으며, 해당 고정 FP32 WASM artifact는 현재 inference load 전에 preflight에서 거부됩니다. 모델 폴더에 수동 준비하는 것은 가능합니다. FP32 WebGPU 오류 `51636776`은 미해결입니다.

최종 `dist`의 large-v3 Q4 스모크는 실제 artifact `musetric/whisper-large-v3-onnx`, revision `228b20358cc86d1f8cc30299dc940438a3a7e4a0`를 사용했습니다. Q4와 turbo의 표기 시간은 동시 검증 작업이 포함된 로컬 스모크 기록이며 성능 벤치마크가 아닙니다.

| 구성 | 두 실제 실행 시간 | JFK 결과 |
| --- | --- | --- |
| Whisper large-v3 Q4 WASM | 371,443 ms / 339,877 ms | 22단어, 76음소; `And` 120–400ms, `country` 9,880–10,300ms |
| Whisper large-v3 Q4 WebGPU | 98,215 ms / 98,155 ms | 22단어, 76음소; `And` 120–400ms, `country` 9,880–10,300ms |
| Whisper large-v3-turbo compact Q8 WASM | 200,882 ms / 215,945 ms | 22단어, 76음소; `And` 220–520ms, `country` 9,980–10,380ms |

각 Q4 구성은 페이지와 4개 worker 세션에서 외부 모델 호스트를 차단한 상태로 두 번 통과했습니다. Turbo Q8 WASM 구성도 같은 조건에서 두 번 통과했습니다. 실제 decoder prompt의 문맥 길이는 실행별로 0, 8, 11 토큰이었습니다. 모든 구성에서 앱 API 요청, 로컬 asset 실패, 외부 요청 실패는 0건이었습니다. 표의 단어 구간은 구성별 출력이며 서로 같은 timestamp를 뜻하지 않습니다. 이 fixture 실행은 해당 모델·정밀도·장치 조합의 동작 확인이며 품질 동등성, 기기별 성능, Python 대비 인식 품질, WER/CER 또는 모든 구성의 성공을 입증하지 않습니다. FP32 WebGPU 오류 `51636776`은 미해결이며 대형 FP32 WASM artifact는 wasm32 4 GiB 주소 공간 한계를 넘어 preflight에서 거부됩니다. 이전 Xenova Q8 오류 `2509303192` 및 `2506362344`는 과거 기록입니다.

Turbo 검증 artifact는 `onnx-community/whisper-large-v3-turbo_timestamped`, revision `b3f77bf9a8c4d5ea3415827033d1ffea7955fd9a`입니다. FP16 및 Q4F16 turbo는 과거 빈 전사만 있어 현재 구성 검증으로 간주하지 않습니다.

생산 번들의 발음 변환 smoke는 한국어 `국물` 6 phones, 영어 OOV `madnolia` 9 phones, 일본어 `がっこう` 5 phones 결과가 fixture와 일치했고, 외부 앱 API 네트워크 요청은 0건이었습니다. 이 영어 fixture는 프로덕션 기본 언어나 전사 언어 설정을 뜻하지 않습니다.

2026-11-02 최종 `dist`의 tiny + CTC + HuBERT 스모크에서는 Whisper tiny Q8 WASM, CTC Q4, HuBERT를 준비해 20개 파일을 처리했습니다. 외부 모델 호스트를 차단한 두 추론은 각각 108,669ms와 98,133ms였고, 새 decoder 출력은 JFK 22단어·75음소였으며 47개 음소가 `CTC_FORCED ALIGNED`였습니다. HuBERT는 64개 centroid와 768차원 검증을 통과했습니다. 페이지와 4개 worker 세션에서 실행했으며 앱 API 요청, 로컬 asset 실패, 외부 요청 실패는 모두 0건이었습니다. 이 로컬 스모크 시간은 동시 검증 작업이 포함된 성능 벤치마크가 아닙니다. 이 결과는 해당 구성 확인이며 WER/CER와 Python 대비 인식 품질은 측정하지 않았습니다.

2026-11-02 별도의 모델 폴더 전용 스모크에서는 OPFS 모델 파일 13개를 준비하고 sentinel 파일을 보존했습니다. 누락 ONNX만 복구했고 수정하지 않은 peer ONNX의 크기와 수정 시각은 유지됐습니다. 선택 취소 후 연결 유지와 새로고침 후 재연결도 확인했습니다. tiny Q8 WASM의 두 차단 호스트 추론은 9,068ms와 9,052ms에 완료됐으며, 새 decoder 출력은 22단어·75음소였습니다. 이 실행은 HuBERT와 CTC 정렬을 끈 estimated alignment 구성입니다. 페이지와 4개 worker 세션에서 앱 API 요청, 로컬 asset 실패, 외부 요청 실패가 모두 0건이었습니다. 스모크 시간은 동시 검증 작업이 포함된 성능 벤치마크가 아닙니다. 폴더 선택기는 OPFS handle과 권한 메서드를 주입해 검증했으므로 네이티브 OS 권한 프롬프트는 자동화하지 않았습니다.

브라우저 런타임 검증은 `web/`에서 실행합니다.

```powershell
node tests/browser-runtime-smoke.mjs
node tests/browser-runtime-smoke.mjs --asr
```

첫 명령은 실제 프로덕션 편집으로 WAV, 피치 및 오토튠 처리, H.264/AAC MP4 내보내기를 확인합니다. `--asr`는 공개 JFK 샘플과 선택한 Whisper 모델로 실제 추론을 실행합니다. 테스트한 tiny compact WASM + CTC Q4 + HuBERT 조합은 호스트 차단 상태의 두 실행을 통과했습니다. `MADNOLIA_SMOKE_ASR_MODEL`, `MADNOLIA_SMOKE_PRECISION`, `MADNOLIA_SMOKE_ALIGNMENT`, `MADNOLIA_SMOKE_ACOUSTIC_UNITS`, `MADNOLIA_SMOKE_DEVICE`, `MADNOLIA_SMOKE_LANGUAGE` 환경 변수로 검증 대상을 바꿀 수 있습니다. 두 모드는 임시 OPFS 브라우저 작업공간을 사용하며 공개 샘플과 모델을 내려받습니다. 사용자 파일에는 접근하지 않습니다.

모델 폴더 UI 확인에는 `node tests/browser-model-folder-smoke.mjs`를 사용합니다. 2026-11-02 프로덕션 UI 검증에서는 모델 수동 준비와 재사용, 누락 파일 복구, 선택 취소, 새로고침 후 재연결을 확인했습니다. 네이티브 권한 프롬프트는 자동화하지 않았으며, 테스트하지 않은 기기·정밀도·모델 조합도 검증 범위에 포함되지 않습니다. 모든 모델 조합의 성공이나 인식 품질 동등성을 의미하지 않습니다.

## Parity follow-up status

### 기존 분석 재처리와 프로젝트 복구

**Projects > 분석 목록**에서 기존 분석을 **재처리 선택**한 뒤 정밀도와 장치를 고릅니다. HuBERT 음향 특징은 선택 사항입니다. 필요한 CTC·HuBERT 모델만 선택한 설정으로 준비하고 추론합니다. ASR은 다시 실행하지 않습니다.

재처리는 원본 transcript, 단어와 후보, ASR provenance를 보존하고 별도 `reprocessing_metadata`에 새 설정과 결과를 기록합니다. 기존 phone ID는 일치하는 음소에서 유지하며 콜라주 파일은 바꾸지 않습니다. 분석 및 참조 프로젝트 스냅샷의 백업은 각각 `analyses/<id>/reprocess-backups/<transaction-id>/`와 `projects/<id>/reprocess-backups/<transaction-id>/`에 남습니다. 게시 중단은 journal을 이용해 다음 작업공간 접근 때 롤백합니다. 이 작업은 같은 페이지 안에서 직렬화됩니다. 여러 탭이 같은 작업공간을 동시에 편집할 때의 원자성은 검증되지 않았습니다.

프로젝트 목록에는 읽을 수 있는 프로젝트만 표시됩니다. 파일이 없거나 손상된 프로젝트는 목록에서 빠지며 손상 파일 자체는 보존됩니다. 그 프로젝트가 참조하던 저장 분석을 목록에서 선택해 **새 프로젝트 만들기**로 다시 구성할 수 있습니다.

### ASR 재개와 페이지 이탈

앱은 음성 창 단위로 raw timed words를 작업공간에 체크포인트합니다. 재개 시 PCM hash, 창 내용과 순서, 모델 ID·revision·dtype·장치, 입력 샘플과 언어·정책·전체 창 문맥이 일치하는 연속 구간만 재사용합니다. 불완전하거나 일치하지 않는 창은 다시 추론합니다. 페이지 안에서 일시정지한 작업은 **계속하기**를 선택해 이어서 처리합니다. 중단·실패한 작업이나 새로고침 뒤 저장된 중단 작업은 **저장 분석 이어하기**를 명시적으로 선택해야 하며, 같은 job/result ID를 이어 씁니다. 무거운 추론은 자동으로 재시작하지 않습니다. 재개 후 CTC와 선택형 HuBERT는 다시 실행됩니다.

실행 중 이탈에는 브라우저 `beforeunload` 경고를 등록합니다. 표시 여부와 문구는 브라우저가 통제하고 사용자 상호작용이 필요할 수 있습니다. OS가 브라우저를 강제 종료하는 상황에서는 경고나 저장 완료를 보장하지 않습니다. 탭 간 owner lease는 최선 노력 보호이며, 같은 작업공간을 여러 탭에서 동시에 편집하는 동작은 검증되지 않았습니다.

### 미디어 정보와 검색

영상 소스의 첫 manifest는 원본 너비·높이·FPS를 저장합니다. FPS는 Python의 정수 반올림을 따르므로 29.97은 30이 됩니다. MP4 인코딩에서 홀수 너비·높이는 최소한 패딩합니다. 가능한 경우 FFmpeg 메타데이터를 읽고 기존 분석에 누락된 값을 채웁니다. 조회할 수 없으면 기존 값을 보존하며, 여전히 값이 없을 때만 1280×720, 30 FPS를 기본값으로 씁니다. 원본 영상 파일이 없는 EDL/FCPXML은 저장된 소스 정보를 사용합니다.

일본어·한국어 phone 검색은 고정 Python revision `5528ab02b63338ce59bf049f7596d5e50657b53b`의 47개 override와 10개 fallback 표를 사용합니다. 표는 AST 비교로 해당 Python 구현과 대조했습니다.

### parity follow-up 확인

2026-11-03 기준 canonical 테스트는 171/171 통과, 0 skipped였고 production build와 Pages static smoke가 통과했습니다. 실제 최종 `dist` 확인에서 모델 폴더, 미디어 내보내기, large-v3 Q4 WebGPU가 통과했습니다. 미디어 출력은 160×90, 12 FPS H.264/AAC MP4와 6.2초 WAV였으며 EDL/FCPXML은 같은 소스 규격을 사용했습니다. large-v3 Q4 WebGPU는 22단어·76음소 결과로 실제 첫 실행 86,119ms에 완료했습니다. 두 번째 실행은 저장 체크포인트를 재사용해 1,514ms에 끝났으며 독립 추론이나 성능 벤치마크가 아닙니다.

브라우저 재처리 시나리오는 실제 `step:passed`를 기록했고 transcript·단어·ASR provenance, phone ID, 콜라주 보존과 백업, CTC·HuBERT 결과를 확인했습니다. 2026-11-03 복구 시나리오도 전체 `step:passed`를 기록했습니다. 실제 UI에서 모델 폴더를 초기화해 재개 readiness 오류를 만든 뒤, 동일 job ID와 record ID가 유지되고 이어하기 버튼이 다시 활성화되는 것을 확인했습니다. 폴더를 다시 연결한 후 신뢰된 UI 클릭으로 재개해 첫 체크포인트 창 1개를 재사용하고 새 창 19개를 추론했으며 단어 60개인 분석 1개를 완료했습니다. idle `beforeunload`는 막지 않았고 실행 중에는 막았으며, 모델 호스트 차단·API 네트워크 요청 0건·외부 실패 0건도 확인했습니다. 이 tiny Q8 WASM 스모크는 복구 동작 검증이며 전사 품질 측정은 아닙니다.

런타임 확인 명령은 `web/`에서 실행합니다.

```powershell
node tests/browser-runtime-smoke.mjs --reprocess
node tests/browser-runtime-smoke.mjs --recovery
```

입력 상한은 미디어 파일 1 GB·30분, WAV 출력 30분, MP4 출력 10분입니다. 큰 Whisper FP32 WASM sidecar는 6,173,962,240 bytes로 wasm32 4 GiB 주소 공간 제약 때문에 추론 전 검사에서 거부됩니다. FP32 WebGPU 오류 `51636776`은 미해결이며 원인은 확정되지 않았습니다. 해당 파일을 모델 폴더에 수동 준비할 수 있지만 자동 정밀도 대체는 없습니다. HuBERT 교차 분석 클러스터링, Python 버전 이력의 브라우저 내 전환, WER/CER 측정은 지원되지 않거나 수행되지 않았습니다.
