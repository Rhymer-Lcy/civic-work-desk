; CivicWorkDesk -- Windows x64 per-user installer (Phase 4 RC1, field-validation candidate)
;
; Built with Inno Setup 7. Its licence grants permission to use it "for any purpose, including
; commercial applications"; condition 3 invites but does not require an acknowledgement, which the
; project documentation carries anyway.
;
; ## Why per-user, and what that buys
;
; PrivilegesRequired=lowest means no UAC prompt, no Program Files, no HKLM, no service, no scheduled
; task, no firewall rule and no machine-wide PATH. A colleague on a managed government desktop can
; install this without asking anyone for rights. Everything lands under %LOCALAPPDATA%\CivicWorkDesk
; and the Start Menu entry is the per-user one.
;
; ## The ordering that makes a failure safe
;
; Files are extracted into releases\<id>\, which is a new directory and therefore inherently a staging
; area: while extraction runs, current.txt still names whatever was working before. Only afterwards does
; [Run] call `civic-admin activate`, which verifies the payload against its own manifest, proves the
; server can bind 127.0.0.1:8765 and answer, and only then rewrites current.txt. A failure at any
; earlier point leaves the previous version usable.
;
; Preflight runs before a single file is written, in InitializeSetup, so a machine that cannot run this
; is told so instead of being left with a half-install.

#ifndef CivicPayload
  #error Define CivicPayload with the path to the built release payload
#endif
#ifndef CivicReleaseId
  #error Define CivicReleaseId
#endif
#ifndef CivicAppVersion
  #define CivicAppVersion "0.1.0"
#endif
#ifndef CivicOutDir
  #define CivicOutDir "..\..\..\release\windows"
#endif
#ifndef CivicOutBase
  #define CivicOutBase "CivicWorkDesk-Windows-x64-Setup"
#endif

#define CivicAppName "政务工作记录台"
#define CivicAppNameEn "CivicWorkDesk"
#define CivicPublisher "CivicWorkDesk"
#define CivicOrigin "http://127.0.0.1:8765/"

[Setup]
AppId={{8B3F2C71-4D5E-4A19-9C42-7E1D6F0B8A53}
AppName={#CivicAppName}
AppVersion={#CivicReleaseId}
AppVerName={#CivicAppName} {#CivicReleaseId}
VersionInfoVersion={#CivicAppVersion}
VersionInfoProductName={#CivicAppNameEn}
VersionInfoDescription={#CivicAppNameEn} Windows x64 RC1 (field-validation candidate)
AppPublisher={#CivicPublisher}
AppPublisherURL=https://github.com/Rhymer-Lcy/civic-work-desk
AppSupportURL=https://github.com/Rhymer-Lcy/civic-work-desk/issues
AppUpdatesURL=https://github.com/Rhymer-Lcy/civic-work-desk/releases

; --- per-user, no elevation -------------------------------------------------------------------------
PrivilegesRequired=lowest
DefaultDirName={localappdata}\CivicWorkDesk
DisableDirPage=yes
DefaultGroupName={#CivicAppName}
DisableProgramGroupPage=yes
UsePreviousAppDir=yes
UsePreviousGroup=yes

; The uninstall entry is the per-user one under HKCU, which is the only registry this installer touches.
Uninstallable=yes
UninstallDisplayName={#CivicAppName}
UninstallDisplayIcon={app}\bin\civic-launch.exe
CreateUninstallRegKey=yes

; --- x64 only ---------------------------------------------------------------------------------------
ArchitecturesAllowed=x64compatible
; Windows 11 is 10.0.22000 and later. Inno checks this itself, so an old machine is refused by the
; installer's own gate as well as by the preflight below.
MinVersion=10.0.22000

OutputDir={#CivicOutDir}
OutputBaseFilename={#CivicOutBase}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ShowLanguageDialog=no
DisableWelcomePage=no
DisableReadyPage=no
SetupLogging=yes

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Messages]
chinesesimplified.WelcomeLabel1=安装 {#CivicAppName}
chinesesimplified.WelcomeLabel2=即将在当前用户目录下安装 {#CivicAppName}（版本 {#CivicReleaseId}）。%n%n本程序不需要管理员权限，不安装任何运行环境，不修改系统设置，也不需要联网。%n%n这是一个待现场验证的候选版本，尚未通过 Windows 兼容性认证。%n%n请先关闭正在运行的政务工作记录台。
chinesesimplified.FinishedHeadingLabel=安装完成
chinesesimplified.FinishedLabel=已安装 {#CivicAppName}。%n%n从“开始菜单 → {#CivicAppName}”打开即可使用。程序会在本机启动一个只监听 127.0.0.1:8765 的本地服务，然后用你默认的浏览器打开。%n%n如果出现异常，请运行“收集诊断信息”，把生成的 txt 发回。
chinesesimplified.ClickFinish=点击“完成”结束安装。

[CustomMessages]
chinesesimplified.LaunchAfterInstall=立即打开 {#CivicAppName}
chinesesimplified.DiagName=收集诊断信息
chinesesimplified.StatusName=查看运行状态
chinesesimplified.StopName=停止服务
chinesesimplified.PlatformName=浏览器兼容性检查
chinesesimplified.UninstallName=卸载 {#CivicAppName}

[Dirs]
Name: "{app}"
Name: "{app}\releases"
Name: "{app}\releases\{#CivicReleaseId}"
Name: "{app}\bin"
Name: "{app}\state"
Name: "{app}\logs"

[Files]
; The payload goes into its own release directory. Extraction into a NEW directory is what makes this a
; staging step rather than an in-place overwrite: reinstalling the same version rewrites only that
; version's own files, and a different version cannot damage the one currently in use.
Source: "{#CivicPayload}\app\*"; DestDir: "{app}\releases\{#CivicReleaseId}\app"; \
    Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#CivicPayload}\server\*"; DestDir: "{app}\releases\{#CivicReleaseId}\server"; Flags: ignoreversion
Source: "{#CivicPayload}\VERSION"; DestDir: "{app}\releases\{#CivicReleaseId}"; Flags: ignoreversion
Source: "{#CivicPayload}\SHA256SUMS.txt"; DestDir: "{app}\releases\{#CivicReleaseId}"; Flags: ignoreversion

; Extracted into Setup's temp directory so InitializeSetup can run the preflight BEFORE anything is
; written. ExtractTemporaryFile only works on an entry flagged dontcopy, and that entry must have no
; DestDir -- a missing dontcopy entry makes InitializeSetup fail at run time with "file not found",
; which would turn the whole preflight into a crash on every machine.
Source: "{#CivicPayload}\server\civic-admin.exe"; Flags: dontcopy

; bin\ is populated by `civic-admin activate` from the release, so the Start Menu shortcut has one
; stable target across upgrades. civic-admin itself has to be here first to be able to do that.
Source: "{#CivicPayload}\server\civic-admin.exe"; DestDir: "{app}\bin"; Flags: ignoreversion
Source: "{#CivicPayload}\server\civic-launch.exe"; DestDir: "{app}\bin"; Flags: ignoreversion
Source: "{#CivicPayload}\server\civic-server.exe"; DestDir: "{app}\bin"; Flags: ignoreversion
Source: "{#CivicPayload}\server\civic-diag.exe"; DestDir: "{app}\bin"; Flags: ignoreversion

[Icons]
Name: "{group}\{#CivicAppName}"; Filename: "{app}\bin\civic-launch.exe"; \
    WorkingDir: "{app}"; Comment: "{#CivicAppName} — {#CivicOrigin}"
Name: "{group}\{cm:DiagName}"; Filename: "{app}\bin\civic-diag.exe"; WorkingDir: "{app}"
Name: "{group}\{cm:StatusName}"; Filename: "{app}\bin\civic-launch.exe"; Parameters: "status"; \
    WorkingDir: "{app}"
Name: "{group}\{cm:StopName}"; Filename: "{app}\bin\civic-launch.exe"; Parameters: "stop"; \
    WorkingDir: "{app}"
Name: "{group}\{cm:PlatformName}"; Filename: "{app}\bin\civic-launch.exe"; Parameters: "platform"; \
    WorkingDir: "{app}"
Name: "{group}\{cm:UninstallName}"; Filename: "{uninstallexe}"

[Run]
; Activation is the last step and the only destructive one. It verifies the payload, proves the server
; serves it, and only then repoints current.txt.
Filename: "{app}\bin\civic-admin.exe"; \
    Parameters: "activate --root ""{app}"" --release {#CivicReleaseId}"; \
    StatusMsg: "正在校验并启用版本 {#CivicReleaseId}…"; \
    Flags: runhidden waituntilterminated
Filename: "{app}\bin\civic-launch.exe"; Description: "{cm:LaunchAfterInstall}"; \
    WorkingDir: "{app}"; Flags: postinstall nowait skipifsilent unchecked

[UninstallRun]
; Stop the server before removing its files, or the running executable cannot be deleted. Records are
; untouched: this only ends the process.
Filename: "{app}\bin\civic-admin.exe"; Parameters: "deactivate --root ""{app}"""; \
    Flags: runhidden waituntilterminated; RunOnceId: "civicdeactivate"

[UninstallDelete]
; Deployment state and logs are ours and go. Note what is NOT listed here: nothing under the user's
; browser profile, nothing in Downloads, no exported document. See the uninstall message below.
Type: filesandordirs; Name: "{app}\state"
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\releases"
Type: filesandordirs; Name: "{app}\bin"
Type: files; Name: "{app}\current.txt"
Type: files; Name: "{app}\previous.txt"
Type: dirifempty; Name: "{app}"

[Code]
var
  PreflightReport: string;

function PreflightExePath(): string;
begin
  { Preflight has to run before anything is installed, so the checker is extracted to a temporary
    directory and run from there. Setup's own temp folder is removed automatically. }
  Result := ExpandConstant('{tmp}\civic-admin.exe');
end;

function RunPreflight(var Output: string): Integer;
var
  ResultCode: Integer;
  ReportPath: string;
  Lines: TArrayOfString;
  I: Integer;
begin
  ReportPath := ExpandConstant('{tmp}\civic-preflight.txt');
  if not Exec(PreflightExePath(),
              'preflight --root "' + ExpandConstant('{localappdata}\CivicWorkDesk') + '"' +
              ' --report "' + ReportPath + '"',
              '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    Output := '无法运行安装前检查程序。';
    Result := -1;
    exit;
  end;
  Output := '';
  if LoadStringsFromFile(ReportPath, Lines) then
    for I := 0 to GetArrayLength(Lines) - 1 do
      Output := Output + Lines[I] + #13#10;
  Result := ResultCode;
end;

{ True when bin\civic-server.exe is absent or can be opened for writing -- i.e. no process still
  holds its image. This is the condition Setup's own file copy needs, asked directly rather than
  inferred from a timeout. }
function CanWriteServerBinary(): Boolean;
var
  Path: string;
  Stream: TFileStream;
begin
  Path := ExpandConstant('{app}\bin\civic-server.exe');
  if not FileExists(Path) then
  begin
    Result := True;
    exit;
  end;
  try
    Stream := TFileStream.Create(Path, fmOpenReadWrite or fmShareExclusive);
    Stream.Free;
    Result := True;
  except
    Result := False;
  end;
end;

{ Stop a server left running by a previous installation, before a single file is copied.

  Windows will not let Setup overwrite a running executable. With /SUPPRESSMSGBOXES the file-in-use
  error aborts silently with exit code 5, which is what happened during the RC1 rehearsal: an
  uninstall could not delete civic-server.exe because the server was up, and the following reinstall
  then aborted on the locked file. The tree was left holding one orphaned binary and nothing else.

  PrepareToInstall is the right place -- it runs after the wizard and before the file copy, and a
  non-empty result aborts with the message shown to the user. The old installation's own civic-admin
  is used, because it is the program that knows how to prove ownership of the server and refuse to
  touch anything else. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  OldAdmin: string;
  ResultCode: Integer;
  I: Integer;
begin
  Result := '';
  { Nothing installed here yet: there is nothing to stop. }
  if not DirExists(ExpandConstant('{app}\bin')) then
    exit;

  { Prefer the installed civic-admin, which belongs to the version being replaced. Fall back to the copy
    already extracted for the preflight: an interrupted uninstall can leave a running server behind with
    no civic-admin next to it, and exiting early in that state is what let the following install abort on
    the locked executable. }
  OldAdmin := ExpandConstant('{app}\bin\civic-admin.exe');
  if not FileExists(OldAdmin) then
  begin
    OldAdmin := ExpandConstant('{tmp}\civic-admin.exe');
    if not FileExists(OldAdmin) then
      exit;
  end;

  if not Exec(OldAdmin, 'deactivate --root "' + ExpandConstant('{app}') + '"',
              '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    { Cannot even run it. Say so rather than proceeding into a locked-file abort whose message
      explains nothing. }
    Result := '无法停止正在运行的政务工作记录台（' + OldAdmin + ' 无法执行）。' + #13#10 +
              '请手动关闭它，或从开始菜单运行“停止服务”，然后重新安装。';
    exit;
  end;

  { deactivate returns 0 when the server is stopped or was never running. Anything else means it
    refused, which it does deliberately when it cannot prove ownership -- never force past that. }
  if ResultCode <> 0 then
  begin
    Result := '有一个占用本机 8765 端口的服务无法被安全停止。' + #13#10#13#10 +
              '程序不会强行结束一个无法证明归属的进程。' + #13#10 +
              '请手动关闭占用该端口的程序后重新安装。';
    exit;
  end;

  { The executables are released a moment after the process exits. Give Windows that moment, or the copy
    that follows races the handle being closed. Waiting on state\server.json would be wrong: an
    interrupted uninstall may already have deleted it while the server was still up. }
  for I := 1 to 60 do
  begin
    if CanWriteServerBinary() then
      break;
    Sleep(250);
  end;
  Sleep(500);
end;

function InitializeSetup(): Boolean;
var
  Code: Integer;
  Report: string;
  Shown: string;
begin
  ExtractTemporaryFile('civic-admin.exe');
  Code := RunPreflight(Report);
  PreflightReport := Report;

  if Code = 0 then
  begin
    Result := True;
    exit;
  end;

  { A blocker must not become a half-install. Say what is wrong, in Chinese, and stop -- and leave the
    full report on disk so it can be sent back. Re-running as administrator is deliberately NOT offered:
    nothing here needs elevation, so an elevated retry would only hide the real problem. }
  Shown := '这台机器还不能安装政务工作记录台。' + #13#10#13#10;
  if Pos('[FAIL       ] Windows 11', Report) > 0 then
    Shown := Shown + '• 系统不是 Windows 11（本候选版本只支持 Windows 11 x64）。' + #13#10;
  if Pos('[FAIL       ] x64 architecture', Report) > 0 then
    Shown := Shown + '• 处理器架构不是 x64。' + #13#10;
  if Pos('[FAIL       ] LOCALAPPDATA writable', Report) > 0 then
    Shown := Shown + '• 用户目录不可写。' + #13#10;
  if Pos('[FAIL       ] Start Menu writable', Report) > 0 then
    Shown := Shown + '• 开始菜单目录不可写。' + #13#10;
  if Pos('[IN USE     ] port 8765', Report) > 0 then
    Shown := Shown + '• 端口 8765 已被其他程序占用。应用的数据绑定在这个地址上，' + #13#10 +
                     '  不能改用其他端口，请先关闭占用它的程序。' + #13#10;
  if Code = -1 then
    Shown := Shown + '• 安装前检查程序无法运行（可能被安全软件拦截）。' + #13#10;

  Shown := Shown + #13#10 + '详细检查结果已保存在：' + #13#10 +
           ExpandConstant('{tmp}\civic-preflight.txt') + #13#10 +
           '（该文件会随安装程序退出一起清理，如需回报请先复制出来。）' + #13#10#13#10 +
           '没有安装任何文件，系统未被修改。';

  MsgBox(Shown, mbCriticalError, MB_OK);
  Result := False;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  { ssPostInstall runs after every [Run] entry flagged waituntilterminated, so activate has already
    happened. Ask it to verify what it activated: without this, a silent activation failure would be
    followed by a "finished" page, which is the most misleading outcome available. }
  if CurStep <> ssPostInstall then
    exit;
  if not Exec(ExpandConstant('{app}\bin\civic-admin.exe'),
              'verify --root "' + ExpandConstant('{app}') + '"',
              '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    ResultCode := -1;

  if ResultCode <> 0 then
    MsgBox('版本已解压，但启用校验没有通过。' + #13#10#13#10 +
           '之前可用的版本（如果有）没有被破坏，仍然可以正常使用。' + #13#10 +
           '请从开始菜单运行“收集诊断信息”，把生成的 txt 发回。',
           mbError, MB_OK);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  { Said at the moment it matters, not buried in a document: removing the program is not removing the
    records. The browser holds them at the canonical origin, and reinstalling a compatible version at
    the same origin makes them available again. }
  if CurUninstallStep = usPostUninstall then
    MsgBox('政务工作记录台已卸载。' + #13#10#13#10 +
           '请注意：卸载程序不等于删除数据。' + #13#10 +
           '你的工作记录保存在浏览器里（地址 ' + '{#CivicOrigin}' + '），' + #13#10 +
           '已导出的 JSON 备份、Excel 和 Word 文件也都还在原处，本次卸载都没有删除。' + #13#10#13#10 +
           '以后在同一地址重新安装兼容版本，这些记录会重新出现。' + #13#10#13#10 +
           '如果确实要清除浏览器中的数据，需要在浏览器的“站点数据”里手动删除。',
           mbInformation, MB_OK);
end;
