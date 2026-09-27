#include "Version.iss"

[Setup]
AppId={{7DD81AAD-10A2-4516-930E-243F417DFE33}
AppName=Madnolia
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\Madnolia
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=.
OutputBaseFilename=Madnolia-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
CloseApplicationsFilter=Madnolia.exe,MadnoliaLauncher.exe
RestartApplications=no
UninstallDisplayIcon={app}\runtime\MadnoliaLauncher.exe

[Languages]
Name: korean; MessagesFile: "compiler:Languages\Korean.isl"

[Files]
Source: "InstallPayload.ps1"; Flags: dontcopy
Source: "payload.json"; Flags: dontcopy

[Tasks]
Name: desktopicon; Description: "바탕 화면에 바로가기 만들기"; Flags: checkedonce

[Icons]
Name: "{autoprograms}\Madnolia"; Filename: "{app}\runtime\MadnoliaLauncher.exe"
Name: "{autodesktop}\Madnolia"; Filename: "{app}\runtime\MadnoliaLauncher.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\runtime\MadnoliaLauncher.exe"; Description: "Madnolia 실행하기"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\runtime.pending"
Type: filesandordirs; Name: "{app}\runtime.previous"
Type: dirifempty; Name: "{app}"

[Code]
var
  DownloadPage: TDownloadWizardPage;

#include "PayloadMetadata.iss"

procedure InitializeWizard;
begin
  DownloadPage := CreateDownloadPage('Madnolia 다운로드',
    '프로그램을 다운로드하고 확인하고 있습니다. 잠시 기다려 주세요.', nil);
end;

procedure RegisterExtraCloseApplicationsResources;
begin
  RegisterExtraCloseApplicationsResource(False, ExpandConstant('{app}\runtime\Madnolia.exe'));
  RegisterExtraCloseApplicationsResource(False, ExpandConstant('{app}\runtime\MadnoliaLauncher.exe'));
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = wpReady then begin
    DownloadPage.Clear;
    AddPayloadDownloads;
    DownloadPage.Show;
    try
      try
        DownloadPage.Download;
      except
        if not DownloadPage.AbortedByUser then
          SuppressibleMsgBox(AddPeriod(GetExceptionMessage), mbCriticalError, MB_OK, IDOK);
        Result := False;
      end;
    finally
      DownloadPage.Hide;
    end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  Details: AnsiString;
begin
  Result := '';
  ExtractTemporaryFile('InstallPayload.ps1');
  ExtractTemporaryFile('payload.json');
  WizardForm.StatusLabel.Caption := 'Madnolia를 설치하고 있습니다. 몇 분 정도 걸릴 수 있습니다.';
  if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{tmp}\InstallPayload.ps1') + '" -DownloadDirectory "' +
    ExpandConstant('{tmp}') + '" -Destination "' + ExpandConstant('{app}') + '"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then begin
    Result := 'Madnolia를 설치하지 못했습니다. 실행 중인 Madnolia를 종료하고 디스크 여유 공간을 확인한 뒤 다시 시도해 주세요.';
    if LoadStringFromFile(ExpandConstant('{tmp}\install-error.txt'), Details) then
      Log(Details);
  end;
end;
