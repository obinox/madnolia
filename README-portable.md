# Windows에서 Madnolia 사용하기

Madnolia는 Windows 10·11 64비트에서 실행됩니다. 설치판과 포터블판 중 하나를 선택하세요.

## 설치판

GitHub Release에서 `Madnolia-Setup.exe`를 내려받아 실행한 뒤 안내에 따라 설치하세요. 설치가 끝나면 시작 메뉴나 바탕 화면의 **Madnolia**를 실행합니다. 설치기는 프로그램 파일을 온라인으로 내려받아 무결성을 확인하므로 인터넷 연결이 필요합니다. Python이나 CUDA Toolkit은 따로 설치하지 않아도 됩니다.

프로그램이 열리면 영상을 선택하거나 창에 끌어 놓고, 모델을 고른 뒤 분석을 시작하세요. 필요한 전사 모델은 처음 사용할 때 자동으로 내려받습니다.

설치 위치는 `%LOCALAPPDATA%\Programs\Madnolia`입니다. 영상, 모델, 프로젝트와 분석 결과는 `%LOCALAPPDATA%\Madnolia\data`에, 로그는 `%LOCALAPPDATA%\Madnolia\logs`에 저장됩니다. 새 설치기를 실행해 업데이트하거나 Windows 설정에서 앱을 제거해도 사용자 데이터는 남습니다. 앱과 데이터까지 모두 지우려면 필요한 결과를 백업한 뒤 `%LOCALAPPDATA%\Madnolia` 폴더를 직접 삭제하세요.

## 포터블판

GitHub Release에서 `Madnolia-Portable-windows-x64.zip`을 내려받아 원하는 폴더에 압축을 푸세요. 압축을 푼 폴더에서 `MadnoliaLauncher.exe`를 실행하면 됩니다. 프로그램은 같은 폴더의 `data`에 영상, 모델, 프로젝트와 결과를 저장합니다.

업데이트하려면 Madnolia를 종료하고 새 ZIP을 다른 폴더에 푼 뒤, 기존 폴더의 `data`를 새 폴더에 복사하세요. 새 폴더의 `MadnoliaLauncher.exe`를 실행하면 이전 결과와 모델을 계속 사용할 수 있습니다. 포터블 폴더를 삭제하면 그 안의 데이터도 함께 삭제되므로 먼저 `data`를 백업하세요. 포터블판은 자동 업데이트를 지원하지 않습니다.

설치판과 포터블판은 프로그램과 데이터를 서로 다른 위치에 보관합니다. 판을 바꿀 때는 Madnolia를 종료하고 이전 위치의 `data`를 새 위치로 복사하세요.

## 모델 다운로드와 하드웨어

처음 분석할 때 필요한 모델을 인터넷에서 내려받습니다. 설치와 모델 다운로드에 수 GB의 여유 공간이 필요할 수 있습니다.

CPU 분석을 지원합니다. NVIDIA GPU에서는 CUDA 기반 faster-whisper가 Whisper 전사를 가속하고, 정렬과 음향 분석은 CPU에서 실행됩니다. Intel GPU에서는 OpenVINO를 사용해 Whisper 전사와 정렬·음향 분석을 가속할 수 있습니다. 배포판에는 CPU 전용 PyTorch가 포함되어 있어 Qwen3-ASR는 CPU에서 실행되며 GPU 가속은 제공하지 않습니다. GPU를 사용할 때는 그래픽 드라이버를 최신 버전으로 유지하세요.

## 개발자용 배포 빌드

`v0.2.2` 형식의 버전 태그를 푸시하면 GitHub Actions가 설치판과 `Madnolia-Portable-windows-x64.zip`을 빌드해 GitHub Release에 게시합니다. 수동 실행은 검토용 아티팩트만 만들며 Release에는 게시하지 않습니다. 수동 실행에 입력한 태그가 실제 Release에 게시되어야 온라인 설치기의 다운로드가 작동합니다. 설치기는 Release에 올라간 해당 버전의 분할 파일과 SHA256을 사용합니다. 사용자는 `.part` 파일을 따로 받을 필요가 없습니다. 포터블 ZIP은 GitHub의 파일당 2 GB 제한을 넘을 수 없습니다.

설치기 설정은 `installer/Madnolia.iss`, 분할 파일 생성은 `installer/package_release.py`에서 관리합니다. 빌드에는 Inno Setup 6.7.3을 사용합니다.
