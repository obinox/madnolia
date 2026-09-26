# Madnolia Windows portable

ZIP 파일을 원하는 위치에 압축 해제하고 `Madnolia.exe`를 실행하세요. 브라우저에서 `http://127.0.0.1:8000`이 열립니다. 실행 중 콘솔 창을 닫으면 서버도 종료됩니다.

분석할 영상은 `data/input/videos/`에 넣으세요. 분석 화면에서 선택한 모델은 처음 사용할 때 다운로드되며, 다운로드 진행 상황이 표시됩니다. 모델, 다운로드 캐시, 프로젝트, 분석 결과는 모두 이 폴더의 `data/` 아래에 저장됩니다. ZIP 파일에는 모델과 개인 데이터가 포함되지 않습니다.

폴더 전체를 다른 위치로 옮길 수 있습니다. 기존 데이터까지 유지하려면 `data/` 폴더도 함께 옮기세요. 업데이트할 때에는 새 ZIP을 압축 해제한 후 기존 `data/` 폴더를 새 폴더로 복사하세요.

GPU에 맞는 ZIP을 선택하세요: Intel GPU 또는 CPU는 `Madnolia-windows-intel-cpu.zip`, NVIDIA GPU는 `Madnolia-windows-nvidia-cuda.zip`, AMD GPU는 `Madnolia-windows-amd-vulkan.zip`입니다. 모든 ZIP은 CPU 실행과 OpenVINO 기반 정렬·음향 분석을 지원합니다. NVIDIA ZIP에는 CUDA 라이브러리, AMD ZIP에는 Vulkan 전사 실행 파일이 추가됩니다. GPU 제조사에 맞는 그래픽 드라이버가 필요합니다. 프로그램은 포함된 실행 방식을 확인해 GPU를 자동 선택하며, 사용할 수 없으면 CPU로 실행합니다. 분석 화면에서 실행 방식을 변경할 수 있습니다.

첫 모델 다운로드에는 인터넷 연결이 필요합니다. NVIDIA/AMD에서는 전사를 GPU에서 실행하고 CTC 정렬과 HuBERT 음향 분석은 CPU에서 실행합니다. AMD는 별도 GGML Whisper 모델을 `data/cache/models/vulkan/`에 다운로드합니다. 뷰어는 `127.0.0.1`에서만 접속할 수 있습니다.

CLI를 사용하려면 PowerShell에서 `./Madnolia.exe --help`를 실행하세요.
