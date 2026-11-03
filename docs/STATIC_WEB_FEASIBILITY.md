# 정적 웹 이식 가능성 조사

조사일: 2026-11-02. 공개 모델 저장소·소스와 설치된 Transformers.js 코드를 확인했다. 모델 가중치 다운로드, 추론, WASM 컴파일 및 음질 비교는 수행하지 않았다. 아래 판정은 구현 경로의 존재에 관한 판단이며 품질·성능 검증 완료를 의미하지 않는다.

> 이 문서는 기능 구현 전 조사 스냅샷이며 현재 웹 기능을 설명하지 않습니다. 이후 구현과 검증 상태는 [정적 웹 앱 안내](static-web.md)를 참조하세요.

## 판정

| 대상 | 조사 결과 | 남은 핵심 조건 |
| --- | --- | --- |
| Whisper large-v3 | Transformers.js용 ONNX 모델 존재 | 실제 WebGPU 실행·메모리·단어 timestamp |
| Whisper large-v3-turbo | ONNX 모델과 WebGPU 공개 데모 존재 | 공개 alignment 설정 불일치 확인·수정 검증 |
| 기존 wav2vec2 CTC | 같은 원본 체크포인트의 ONNX 변환본 존재 | tokenizer 우회, logits 기반 기존 정렬 이식 |
| 기존 HuBERT | Transformers.js용 같은 모델 계열 존재 | hidden output·전처리·기준 OpenVINO와 비교 |
| WORLD | C++ 원본과 Emscripten 래퍼 사례 존재 | 기준 버전으로 재빌드, StoneMask 포함, 메모리·음질 비교 |
| 발음기 | 이번 조사로 동등 실행 경로 미확정 | g2pk/g2p-en/pykakasi의 사전·모델·의존성 조사 |

두 영역 모두 정적 웹으로 복원할 현실적인 경로가 있다. 그러나 현재 앱에 모델 이름이나 패키지만 추가해서 완료할 수는 없다. 가장 명확한 미해결 요소는 발음기 동등성, turbo timestamp 설정, 실제 GPU 호환성과 WORLD 재빌드다.

## 인식·정렬

### Whisper

- [Xenova/whisper-large-v3](https://huggingface.co/Xenova/whisper-large-v3): `library_name=transformers.js`, base model은 `openai/whisper-large-v3`. fp32/fp16/양자화 encoder·decoder와 일부 external data 파일을 확인했다. revision `67bf02d92b7754a1ff82a7f8545f8b8c378b2ef0`.
- [onnx-community/whisper-large-v3-turbo](https://huggingface.co/onnx-community/whisper-large-v3-turbo): fp32/fp16/q4/q4f16 등 파일 존재. revision `360ebcde2559d60bb474678be3c1de9ef347d01a`. [공개 WebGPU 데모](https://huggingface.co/spaces/webml-community/whisper-large-v3-turbo-webgpu)가 모델 메타데이터에 연결되어 있다. 이번 조사에서 데모 실행은 하지 않았다.
- 로컬 Transformers.js에는 `WhisperForConditionalGeneration`과 word timestamp 경로가 있다. 단어 timestamp는 attention 출력이 필요하며, 필요한 출력 없이 export된 모델에 대한 오류 처리도 있다.
- **turbo 설정 문제:** 공개 `config.json`의 `decoder_layers`는 4인데 `generation_config.json`의 `alignment_heads`에는 9·11·22·23번 레이어가 들어 있다. 이 설정을 그대로 단어 정렬에 사용하면 유효한 decoder 레이어를 참조하지 못한다. 공개 모델 존재와 word timestamp 지원 완료는 구분해야 한다. 검증된 alignment 설정 또는 재export가 필요하다.
- 현재 앱의 WebGPU fp32 일괄 적용은 대형 모델용 정책으로 검증되지 않았다. 모델별 지원 정밀도와 external data 로딩·캐시도 점검해야 한다. 공개 저장소의 전체 `usedStorage`는 모든 변형의 합계이므로 사용자 다운로드 크기로 사용할 수 없다.

### CTC

[qnighy/wav2vec2-xlsr-53-espeak-cv-ft-ONNX](https://huggingface.co/qnighy/wav2vec2-xlsr-53-espeak-cv-ft-ONNX)는 기존 `facebook/wav2vec2-xlsr-53-espeak-cv-ft`의 변환본이다. revision `d2987af7ae07d53eafee15dc7190479062faa1e8`.

모델 카드가 제시하는 크기는 fp32 1,205 MB, fp16 603 MB, q4 230 MB, q4f16 188 MB다. 이는 제작자의 표기이며 이번에 파일 다운로드로 재측정하지 않았다. 제작자는 두 음성 클립에서 변환 결과를 비교했지만 한국어 음소 경계 품질의 근거로 일반화할 수 없다.

중요한 제약:

- 원본 tokenizer는 `Wav2Vec2PhonemeCTCTokenizer`이며, 모델 카드에 따르면 Transformers.js의 `pipeline`/`AutoTokenizer`로 바로 로딩할 수 없다.
- 대신 `AutoModelForCTC` 또는 직접 모델 호출로 logits를 얻고 `vocab.json`을 직접 사용한다. 로컬 패키지에 `Wav2Vec2ForCTC`가 존재함을 확인했다.
- 기존 앱은 이미 IPA vocab 매핑과 CTC 동적 계획법을 직접 수행한다. 따라서 이 제약은 이식 경로를 막지 않는다. 공개 예시의 greedy phoneme recognition은 강제 정렬이 아니므로 그대로 대체하면 안 된다.
- 이 변환본에는 q8 파일이 없다. 현재 ASR의 WASM q8 정책을 재사용하면 안 된다. 품질 기준용 fp32/fp16과 최적화 후보를 분리해 비교해야 한다.

### HuBERT

[Xenova/hubert-base-ls960](https://huggingface.co/Xenova/hubert-base-ls960)에 fp32/fp16/quantized ONNX가 있다. revision `26a36c4d330d0b28be1d453e3eee92fd8dd10aac`. 로컬 Transformers.js에도 `HubertModel`과 feature extraction 경로가 있다.

기존 코드의 768차원 hidden output, 정규화·패딩, 음소 구간 평균과 군집화를 유지하는 경로가 가능하다. 같은 모델명이라도 변환 revision·선택 hidden layer·출력 시간축이 기준 OpenVINO와 맞는지는 별도 비교해야 한다.

### 정확도 복원의 남은 공백

Whisper·CTC·HuBERT의 실행 경로는 확인했지만 기존 발음기는 해결되지 않았다. 음소열이 달라지면 CTC 모델이 같아도 경계와 검색 결과가 달라진다. g2pk, g2p-en, pykakasi와 사전·보조 모델의 브라우저 실행 방법을 추가로 조사해야 한다. 일반적인 eSpeak 교체를 동등한 구현으로 간주할 수 없다.

## 피치·합성

[WORLD 원본](https://github.com/mmorise/World)의 CMake 설정은 C++ 정적 라이브러리에 DIO·StoneMask·CheapTrick·D4C·Synthesis 등을 포함한다. [라이선스](https://github.com/mmorise/World/blob/master/LICENSE.txt)는 고지 유지 등 조건 아래 소스·바이너리 재배포와 수정을 허용한다. 실제 배포 시 고지 파일을 포함해야 한다.

[turbocast/world-wasm](https://github.com/turbocast/world-wasm)은 Emscripten을 사용하는 공개 래퍼 사례다. Makefile의 `em++`, `--bind`와 DIO·CheapTrick·D4C·Synthesis 바인딩을 확인했다. 그러나 다음 이유로 그대로 도입할 완성품으로 판단하지 않는다.

- 저장소의 마지막 push는 2018년이다.
- Makefile은 예전 `TOTAL_MEMORY=512MB` 설정과 별도 `World` 경로에 의존한다.
- StoneMask 헤더는 있지만 공개 함수 바인딩 목록에 StoneMask가 없다.
- 커스텀 synthesis 경로 등 기준 PyWORLD와 다른 부분이 있어 버전·기능 일치를 보장하지 못한다.

따라서 **기준 PyWORLD가 사용하는 WORLD revision을 고정하고 필요한 함수만 새 WASM 래퍼로 노출하는 방식**이 적합하다. 기존 사례는 이식 선례이지 현재 환경에서 빌드·음질 검증이 끝났다는 증거는 아니다.

Float64 분석, 5 ms 프레임, 120 ms 문맥, spectrum·aperiodicity 보간, 무성 처리와 무편집 원본 반환을 함께 유지해야 한다. 단일 스레드 Worker부터 검증할 수 있으며 멀티스레드는 필수 전제는 아니다. 긴 구간의 행렬 메모리와 JS↔WASM 복사가 주요 제약이다.

## 로컬 환경과 다음 실증 단계

현재 PATH에서 Node·npm·Git·Python 3.14는 확인했으나 `emcc`, `cmake`, `clang`은 찾지 못했다. 기존 프로젝트 요구 Python은 3.11이므로 현재 확인한 Python만으로 기준 환경이 준비됐다고 볼 수 없다. PATH 밖의 설치 유무는 확인하지 않았다.

1. **ASR 검증:** large-v3와 turbo를 각각 짧은 PCM으로 실행한다. transcript와 word timestamp를 구분해서 검사하고, turbo alignment 불일치를 먼저 해결한다. GPU 제한·실제 다운로드·최대 메모리를 기록한다.
2. **CTC/HuBERT 검증:** 동일 PCM·정규화·패딩으로 logits/hidden output을 얻어 기준 엔진과 비교한다. tokenizer 없이 기존 정렬 로직을 이식하는 경로를 검증한다.
3. **WORLD 검증:** Emscripten 빌드 환경을 준비해 고정 revision의 다섯 핵심 함수와 메모리 해제를 노출한다. 기준 Python과 같은 PCM의 분석값·무편집·음정/시간 편집 결과를 비교한다.
4. **발음기 조사:** 기존 발음기 동등성을 확보할 수 있는 의존성·사전·모델 실행 경로를 확정한다. 이 항목이 해결되기 전에는 전체 정확도 복원 완료로 판정하지 않는다.

이번 조사에서는 빌드 도구 설치나 대용량 가중치 다운로드를 하지 않았다. 실행 성능·최소 RAM/VRAM·품질 일치율은 아직 산출할 수 없다.
