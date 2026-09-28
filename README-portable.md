# Madnolia Windows 설치

Windows 10·11 64비트에서 **`Madnolia-Setup.exe` 하나만 받아 실행**하세요. Python이나 CUDA Toolkit을 직접 설치할 필요가 없습니다.

1. 설치기를 실행하고 설치를 누릅니다. 인터넷에서 프로그램을 내려받고 무결성을 확인합니다.
2. 설치가 끝나면 바탕 화면이나 시작 메뉴의 **Madnolia**를 실행합니다.
3. 열린 화면에서 영상 파일을 선택하거나 끌어다 놓습니다.
4. 모델을 선택하고 분석을 시작합니다. 처음 쓰는 모델은 인터넷으로 자동 다운로드합니다.

Intel·NVIDIA GPU를 자동 감지하며 CPU 실행도 지원합니다. 그래픽 드라이버는 제조사의 최신 버전을 권장합니다. NVIDIA CUDA 가속은 Whisper 전사에 사용하고, 정렬·음향 분석은 CPU에서 실행합니다. Intel GPU에서는 OpenVINO 가속을 지원합니다. 이 설치판의 Qwen3-ASR는 CPU에서 실행하며, PyTorch XPU는 포함하지 않습니다.

프로그램은 `%LOCALAPPDATA%\Programs\Madnolia`에 설치됩니다. 영상, 모델, 프로젝트와 결과는 `%LOCALAPPDATA%\Madnolia\data`, 로그는 `%LOCALAPPDATA%\Madnolia\logs`에 저장됩니다. 새 설치기로 업데이트하거나 Windows 설정에서 앱을 제거해도 이 사용자 데이터는 유지됩니다. 완전히 지우려면 필요한 결과를 백업한 뒤 `%LOCALAPPDATA%\Madnolia`를 직접 삭제하세요.

설치와 첫 모델 준비에는 인터넷과 충분한 디스크 여유 공간이 필요합니다. 프로그램과 모델 다운로드는 수 GB 이상일 수 있습니다. 설치 오류가 나면 인터넷 연결과 디스크 공간을 확인하고 설치기를 다시 실행하세요.

## 포터블 ZIP

설치하지 않고 사용하려면 `Madnolia-Portable-windows-x64.zip`을 받아 원하는 폴더에 압축을 푼 뒤 `MadnoliaLauncher.exe`를 실행하세요. 영상, 프로젝트, 모델과 캐시는 해당 폴더의 `data` 아래 저장됩니다. 첫 모델 다운로드에는 인터넷 연결이 필요합니다.

포터블 버전을 업데이트할 때는 Madnolia를 종료하고 기존 폴더의 `data`를 백업하세요. 새 ZIP은 새 폴더에 풀고 기존 `data`를 새 폴더로 복사한 뒤 실행합니다. 자동 업데이트나 데이터 이동은 제공하지 않습니다.

기존 ZIP 사용자는 기존 `data` 폴더를 `%LOCALAPPDATA%\Madnolia\data`로 복사하면 결과와 모델을 이어서 사용할 수 있습니다. 이미 새 설치판을 사용했다면 두 폴더를 먼저 백업하세요.

## 배포 빌드

`v0.2.2` 같은 버전 태그를 푸시하면 GitHub Actions가 웹 화면과 실행 파일을 빌드하고, 설치기와 포터블 ZIP을 같은 GitHub Release에 게시합니다. 포터블 ZIP은 GitHub의 파일당 2 GB 제한 안에 들어와야 합니다. 설치기는 해당 버전의 정확한 URL과 SHA256만 사용합니다. 사용자는 설치기용 `.part` 파일을 따로 받을 필요가 없습니다.

Actions의 수동 실행은 게시하지 않고 검토용 아티팩트만 만듭니다. 입력한 `release_tag`의 파일이 실제 Release에 게시되기 전에는 그 설치기의 온라인 다운로드가 작동하지 않습니다. 설치기 소스는 `installer/Madnolia.iss`, 패키징 스크립트는 `installer/package_release.py`입니다. 컴파일러는 Inno Setup 6.7.3을 사용합니다.
