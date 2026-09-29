; CivicWorkDesk -- Windows x64 per-user installer
;
; This file carries NO release identity. Every version string, the publisher and the release id arrive
; as defines from scripts/windows/build-release.mjs, which derives them once from package.json,
; product-identity.json and the release id (scripts/windows/release-identity.mjs). A missing define is a
; compile error, never a default. RC2 shipped with VersionInfoDescription hard-coded to "RC1", and RC1-RC3
; all named "CivicWorkDesk" -- the product -- as their publisher; scripts/windows/assert-release-identity.mjs
; reads every one of these fields back out of the built bytes.
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
; ## Supported systems
;
; Windows 11 x64 (primary) and Windows 10 22H2 x64 (build 19045, legacy target). MinVersion and
; ArchitecturesAllowed below are the first gate, with their refusals reworded in [Messages]; the bundled
; civic-admin preflight is the second, and the one that tells Windows Server and other Windows 10
; versions apart (internal/platform in the Go module).
;
; ## The ordering that makes a failure safe
;
; Files are extracted into releases\<id>\, which is a new directory and therefore inherently a staging
; area: while extraction runs, current.txt still names whatever was working before. Only afterwards does
; [Run] call `civic-admin activate`, which verifies the payload against its own manifest, refuses an
; older browser-database schema, proves the server can bind 127.0.0.1:8765 and answer, and only then
; rewrites current.txt. A failure at any earlier point leaves the previous version usable, and the final
; check requires THIS release to be the active one before Setup may report success.
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
  #error Define CivicAppVersion with the numeric Windows version (four numbers, e.g. 0.2.0.0)
#endif
#ifndef CivicDisplayVersion
  #error Define CivicDisplayVersion with the display version, e.g. 0.2.0-rc.1
#endif
#ifndef CivicPublisher
  #error Define CivicPublisher from product-identity.json#publisherDisplayName
#endif
#ifndef CivicSchemaVersion
  #error Define CivicSchemaVersion with the browser-database schema of this release
#endif
#ifndef CivicOutDir
  #error Define CivicOutDir
#endif
#ifndef CivicOutBase
  #error Define CivicOutBase
#endif

#define CivicAppName "政务工作记录台"
#define CivicAppNameEn "CivicWorkDesk"
#define CivicOrigin "http://127.0.0.1:8765/"
#define CivicIcon "civic-work-desk.ico"
; The year the release is dated, from the release id (YYYY.MM.DD-...), so the copyright line cannot drift.
#define CivicCopyrightYear Copy(CivicReleaseId, 1, 4)

[Setup]
AppId={{8B3F2C71-4D5E-4A19-9C42-7E1D6F0B8A53}
AppName={#CivicAppName}
AppVersion={#CivicDisplayVersion}
AppVerName={#CivicAppName} {#CivicDisplayVersion}
AppPublisher={#CivicPublisher}
AppCopyright=© {#CivicCopyrightYear} {#CivicPublisher}. 保留所有权利。
VersionInfoVersion={#CivicAppVersion}
VersionInfoProductVersion={#CivicAppVersion}
VersionInfoTextVersion={#CivicAppVersion}
VersionInfoProductTextVersion={#CivicDisplayVersion}
VersionInfoCompany={#CivicPublisher}
VersionInfoProductName={#CivicAppName} ({#CivicAppNameEn})
VersionInfoDescription={#CivicAppName} {#CivicDisplayVersion} 安装程序（Windows x64）
AppPublisherURL=https://github.com/Rhymer-Lcy/civic-work-desk
AppSupportURL=https://github.com/Rhymer-Lcy/civic-work-desk/issues
AppUpdatesURL=https://github.com/Rhymer-Lcy/civic-work-desk/releases

; --- per-user, no elevation -------------------------------------------------------------------------
PrivilegesRequired=lowest
DefaultDirName={localappdata}\CivicWorkDesk
DefaultGroupName={#CivicAppName}
DisableProgramGroupPage=yes
UsePreviousAppDir=yes
UsePreviousGroup=yes

; RC2 offers the directory page on a CLEAN install -- a user with a small system drive, or a policy about
; where programs live, needs somewhere else to put this -- while `auto` keeps it suppressed when a
; previous installation is detected, so an upgrade cannot quietly become a SECOND installation in a
; different place. Whichever way the path was decided, the Ready page states it (UpdateReadyMemo).
DisableDirPage=auto

; The icon the installer itself carries, and the one Windows shows for the uninstall entry.
SetupIconFile={#CivicIcon}
WizardStyle=modern

; The uninstall entry is the per-user one under HKCU, which is the only registry this installer touches.
Uninstallable=yes
UninstallDisplayName={#CivicAppName}
UninstallDisplayIcon={app}\bin\civic-launch.exe,0
CreateUninstallRegKey=yes

; --- x64 Windows 11, or Windows 10 22H2 ---------------------------------------------------------------
; x64os, not x64compatible: x64compatible also admits Windows 11 on ARM64 running x64 code under
; emulation, which this release does not support. Setup itself stays a 32-bit program so that it can
; start on an x86 or ARM64 machine and say why it will not install, instead of failing to launch.
ArchitecturesAllowed=x64os
; 19045 is Windows 10 22H2; every Windows 11 build is higher. Windows Server and the Insider builds in
; between are refused by the preflight, which can read the product type.
MinVersion=10.0.19045

OutputDir={#CivicOutDir}
OutputBaseFilename={#CivicOutBase}
Compression=lzma2/max
SolidCompression=yes
ShowLanguageDialog=no
DisableWelcomePage=no
DisableReadyPage=no
SetupLogging=yes

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Messages]
chinesesimplified.WelcomeLabel1=安装{#CivicAppName}
chinesesimplified.WelcomeLabel2=即将安装{#CivicAppName}（版本 {#CivicDisplayVersion}，发布者 {#CivicPublisher}）。%n%n本程序仅安装到当前用户可写的目录，不需要管理员权限，不安装任何运行环境，也不修改系统设置。安装和使用不依赖互联网。%n%n这是一个待现场验证的候选版本，尚未通过 Windows 兼容性认证。支持的系统：Windows 11 x64，或 Windows 10 22H2 x64。%n%n如果{#CivicAppName}正在运行，请先关闭。
chinesesimplified.FinishedHeadingLabel=安装完成
chinesesimplified.FinishedLabel=已安装{#CivicAppName} {#CivicDisplayVersion}。%n%n从开始菜单或桌面打开即可使用。程序会在本机启动一个只监听 127.0.0.1:8765 的本地服务，再用你默认的浏览器打开固定访问地址：{#CivicOrigin}%n%n如果是从旧版本升级：打开时会先显示一个检查页面，确认浏览器使用的是新版本；如提示仍有页面打开，请先保存并关闭这些页面，再按提示进入新版本。%n%n如问题仍然存在，请运行“收集诊断信息”，并将生成的诊断文件（TXT）反馈给维护人员。
chinesesimplified.ClickFinish=点击“完成”结束安装。
; Inno's own refusals, reworded so a person is told what IS supported. The originals name a bare version
; number ("需要 Windows 版本 10.0.19045 或更高") and a list of architecture codes.
chinesesimplified.WinVersionTooLowError=这台计算机的 Windows 版本不在支持范围内，无法安装{#CivicAppName}。%n%n支持的系统：Windows 11 x64，或 Windows 10 22H2（内部版本 19045）x64。%n%n未写入任何安装文件。
chinesesimplified.OnlyOnTheseArchitectures={#CivicAppName}只能安装在使用 x64（Intel 或 AMD 64 位）处理器的 64 位 Windows 上。%n%n不支持 32 位 Windows，也不支持 ARM64 设备（包括 x64 仿真）。%n%n未写入任何安装文件。
chinesesimplified.WindowsVersionNotSupported=这台计算机的 Windows 版本不在支持范围内，无法安装{#CivicAppName}。%n%n支持的系统：Windows 11 x64，或 Windows 10 22H2（内部版本 19045）x64。

[CustomMessages]
chinesesimplified.LaunchAfterInstall=立即打开{#CivicAppName}
chinesesimplified.DiagName=收集诊断信息
chinesesimplified.StatusName=查看运行状态
chinesesimplified.StopName=停止本地服务
chinesesimplified.PlatformName=浏览器兼容性检查
chinesesimplified.UninstallName=卸载{#CivicAppName}
chinesesimplified.MaintenanceGroup=维护工具
chinesesimplified.DesktopIcon=创建桌面快捷方式

[Tasks]
; Checked by default on a first installation, because a desktop icon is what most users here will
; actually look for. `checkedonce` keeps a user's later decision to remove it from being undone by the
; next repair or upgrade -- ticking it again on every run would silently recreate a shortcut somebody
; deliberately deleted.
Name: "desktopicon"; Description: "{cm:DesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; \
    Flags: checkedonce

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
; One entry at the top level -- the application -- and everything a user only needs when something is
; wrong one level down. RC1 put six shortcuts side by side, which made "stop the service" look like an
; ordinary thing to do. Diagnostics stays one click from the top so a field tester can still find it.
Name: "{group}\{#CivicAppName}"; Filename: "{app}\bin\civic-launch.exe"; \
    WorkingDir: "{app}"; IconFilename: "{app}\bin\civic-launch.exe"; IconIndex: 0; \
    Comment: "{#CivicAppName} — {#CivicOrigin}"
; {userdesktop}, never {commondesktop}: the all-users desktop needs administrator rights, which
; this installer deliberately does not have.
Name: "{userdesktop}\{#CivicAppName}"; Filename: "{app}\bin\civic-launch.exe"; \
    WorkingDir: "{app}"; IconFilename: "{app}\bin\civic-launch.exe"; IconIndex: 0; \
    Comment: "{#CivicAppName} — {#CivicOrigin}"; Tasks: desktopicon
Name: "{group}\{cm:MaintenanceGroup}\{cm:DiagName}"; Filename: "{app}\bin\civic-diag.exe"; \
    WorkingDir: "{app}"; IconFilename: "{app}\bin\civic-diag.exe"; IconIndex: 0
Name: "{group}\{cm:MaintenanceGroup}\{cm:StatusName}"; Filename: "{app}\bin\civic-launch.exe"; \
    Parameters: "status"; WorkingDir: "{app}"; IconFilename: "{app}\bin\civic-launch.exe"; IconIndex: 0
Name: "{group}\{cm:MaintenanceGroup}\{cm:StopName}"; Filename: "{app}\bin\civic-launch.exe"; \
    Parameters: "stop"; WorkingDir: "{app}"; IconFilename: "{app}\bin\civic-launch.exe"; IconIndex: 0
Name: "{group}\{cm:MaintenanceGroup}\{cm:PlatformName}"; Filename: "{app}\bin\civic-launch.exe"; \
    Parameters: "platform"; WorkingDir: "{app}"; IconFilename: "{app}\bin\civic-launch.exe"; IconIndex: 0
Name: "{group}\{cm:MaintenanceGroup}\{cm:UninstallName}"; Filename: "{uninstallexe}"

[Run]
; Activation is the last step and the only destructive one. It verifies the payload, refuses an older
; browser-database schema, proves the server serves it, and only then repoints current.txt.
Filename: "{app}\bin\civic-admin.exe"; \
    Parameters: "activate --root ""{app}"" --release {#CivicReleaseId}"; \
    StatusMsg: "正在校验并启用版本 {#CivicDisplayVersion}…"; \
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
; Inno removes shortcuts it created, but only those still recorded in its own log. Listing the desktop
; shortcut explicitly means a repair that recreated it, or a log that lost it, cannot leave an icon on
; the desktop pointing at a program that is gone.
Type: files; Name: "{userdesktop}\{#CivicAppName}.lnk"

[Code]
var
  DiagnosticPath: string;
  { True when the only writable location was Setup's own temp directory, which is removed on exit. }
  DiagnosticIsTemporary: Boolean;

function CheckerPath(): string;
begin
  { The checker runs before anything is installed, so it is extracted to Setup's own temporary
    directory. That directory is deleted when Setup exits -- which is exactly why the diagnostic
    REPORT must not be written there. See WriteDiagnostic below. }
  Result := ExpandConstant('{tmp}\civic-admin.exe');
end;

{ Somewhere the user will still be able to find the report after Setup has gone.

  RC1 wrote the preflight report into Setup's temp directory and then told the user to copy it before
  the dialog was dismissed. That is a race an ordinary tester cannot be expected to win, and when they
  lose it the evidence is gone.

  The Desktop is tried first because it needs no explanation, then the profile root. Both are durable.
  Setup's temp directory is the LAST resort and is NOT durable -- it is deleted when Setup exits -- so
  reaching it is reported differently: the message says so and asks the user to save the file first. }
function DiagnosticCandidates(Stamp: string): TArrayOfString;
var
  Names: TArrayOfString;
begin
  SetArrayLength(Names, 3);
  Names[0] := ExpandConstant('{userdesktop}') + '\CivicWorkDesk-安装诊断-' + Stamp + '.txt';
  Names[1] := ExpandConstant('{%USERPROFILE}') + '\CivicWorkDesk-安装诊断-' + Stamp + '.txt';
  Names[2] := ExpandConstant('{tmp}') + '\CivicWorkDesk-安装诊断-' + Stamp + '.txt';
  Result := Names;
end;

{ Run one preflight stage, writing its report to a durable path. Returns the checker's exit code, or
  -1 when the checker itself could not be run. }
function RunPreflight(Stage, Root: string): Integer;
var
  ResultCode, I: Integer;
  Candidates: TArrayOfString;
  Params: string;
begin
  Candidates := DiagnosticCandidates(GetDateTimeString('yyyymmdd-hhnnss', #0, #0));
  DiagnosticPath := '';
  DiagnosticIsTemporary := False;

  for I := 0 to GetArrayLength(Candidates) - 1 do
  begin
    Params := 'preflight --stage ' + Stage;
    if Root <> '' then
      Params := Params + ' --root "' + Root + '"';
    Params := Params + ' --report "' + Candidates[I] + '"';

    if not Exec(CheckerPath(), Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    begin
      Result := -1;
      exit;
    end;
    { The checker writes its report before it exits, so the file's existence tells us the location was
      usable. Stop at the first one that worked. }
    if FileExists(Candidates[I]) then
    begin
      { A PASSING stage must not leave anything behind. Every stage writes a report so that a blocked
        one has something to hand over, but an ordinary successful install ran three of them -- and left
        three files on the user's Desktop to show for it. Only a blocker is worth keeping. }
      if ResultCode = 0 then
      begin
        DeleteFile(Candidates[I]);
        DiagnosticPath := '';
      end
      else
      begin
        DiagnosticPath := Candidates[I];
        { Index 2 is Setup's temp directory -- see DiagnosticCandidates. }
        DiagnosticIsTemporary := (I = 2);
      end;
      Result := ResultCode;
      exit;
    end;
  end;

  { Every location refused the write. The check itself still ran, so its verdict is honest even though
    there is no file to hand over. }
  Result := ResultCode;
end;

function DiagnosticSentence(): string;
begin
  if DiagnosticPath = '' then
  begin
    Result := '无法写出诊断文件（桌面、用户目录与临时目录均不可写）。';
    exit;
  end;

  { The temp directory is not durable. Saying "saved to <path>" about a file Setup is about to delete
    would be the same false promise RC1 made, so this case says what is actually true and asks for the
    one action that preserves it. }
  if DiagnosticIsTemporary then
    Result := '诊断文件已写入临时目录：' + #13#10 + DiagnosticPath + #13#10#13#10 +
              '该目录会在安装程序退出时被清理。' + #13#10 +
              '请先将该文件另存到桌面或其他目录，再关闭本窗口，然后反馈给维护人员。'
  else
    Result := '诊断文件已保存至：' + #13#10 + DiagnosticPath + #13#10#13#10 +
              '如需协助，请将该诊断文件（TXT）反馈给维护人员。';
end;

{ What is true after a blocked preflight, and nothing more.

  RC1 said "系统未被修改", which is too broad: Setup has already extracted its own temporary files by
  this point. These two sentences are what the implementation actually proves. }
function NothingInstalledSentence(): string;
begin
  Result := '未写入正式安装目录，安装未完成。' + #13#10 +
            '未创建应用快捷方式，也未启用任何新版本。';
end;

{ True on Windows 10 22H2 -- the legacy target, which is supported but past the end of support. The
  preflight has already refused every other Windows 10 build and every server edition, so the build
  number alone identifies it here. }
function IsWindows10LegacyTarget(): Boolean;
var
  Version: TWindowsVersion;
begin
  GetWindowsVersionEx(Version);
  Result := (Version.Major = 10) and (Version.Build = 19045);
end;

function InitializeSetup(): Boolean;
var
  Code: Integer;
  Shown: string;
begin
  ExtractTemporaryFile('civic-admin.exe');

  { Machine-level only. The installation directory has not been chosen yet, so anything that depends on
    it -- writability, path safety -- belongs to the directory page, and anything that depends on a
    release belongs to PrepareToInstall. RC1 checked all three here against a hard-coded
    %LOCALAPPDATA% path, which made a custom directory impossible to support. }
  Code := RunPreflight('machine', '');
  if Code = 0 then
  begin
    { Informs; never blocks. The same sentence is civic-diag's and the preflight's
      (platform.EndOfSupportNotice in the Go module), so every surface says one thing. }
    if IsWindows10LegacyTarget() and not WizardSilent() then
      MsgBox('Windows 10 已于 2025 年 10 月 14 日结束支持。本程序可以在 Windows 10 22H2 上安装和使用，' +
             '但建议尽早升级到 Windows 11。', mbInformation, MB_OK);
    Result := True;
    exit;
  end;

  Shown := '这台计算机还不能安装政务工作记录台。' + #13#10#13#10;
  if Code = -1 then
    Shown := Shown + '· 安装前检查程序无法运行，可能被安全策略或安全软件拦截。' + #13#10 +
                     '  请不要为此关闭安全软件，请把情况反馈给维护人员。' + #13#10
  else
    Shown := Shown + '· Windows 版本或处理器架构不在支持范围内。' + #13#10 +
                     '  支持的系统：Windows 11 x64，或 Windows 10 22H2（内部版本 19045）x64。' + #13#10;

  Shown := Shown + #13#10 + NothingInstalledSentence() + #13#10#13#10 + DiagnosticSentence();
  SuppressibleMsgBox(Shown, mbCriticalError, MB_OK, IDOK);
  Result := False;
end;

{ Validate a chosen installation directory before the wizard moves on.

  A rejected path is never silently replaced with the default: the user chose it for a reason, and
  installing somewhere else without saying so is how a person ends up with two installations. The
  message names the reason and the wizard stays on the page so another path can be chosen. }
function NextButtonClick(CurPageID: Integer): Boolean;
var
  Code: Integer;
begin
  Result := True;
  if CurPageID <> wpSelectDir then
    exit;

  Code := RunPreflight('directory', WizardDirValue);
  if Code = 0 then
    exit;

  if Code = -1 then
    SuppressibleMsgBox('无法运行安装前检查程序，可能被安全软件拦截。' + #13#10#13#10 + DiagnosticSentence(),
           mbCriticalError, MB_OK, IDOK)
  else
    SuppressibleMsgBox('这个安装位置不能使用：' + #13#10 + WizardDirValue + #13#10#13#10 +
           '请选择一个当前用户可写的本地目录，例如：' + #13#10 +
           '  ' + ExpandConstant('{localappdata}') + '\CivicWorkDesk' + #13#10 +
           '  D:\Applications\CivicWorkDesk' + #13#10#13#10 +
           '不能使用系统目录、Program Files、驱动器根目录或网络位置。' + #13#10#13#10 +
           DiagnosticSentence(),
           mbError, MB_OK, IDOK);
  Result := False;
end;

{ The release id currently active in a directory, or '' when nothing is installed there. }
function ActiveReleaseIn(Dir: string): string;
var
  Raw: AnsiString;
begin
  Result := '';
  if LoadStringFromFile(AddBackslash(Dir) + 'current.txt', Raw) then
    Result := Trim(String(Raw));
end;

{ The browser-database schema of an installed release: the databaseSchemaVersion in its
  deployment-health.json, 1 when the release predates the field (RC1-RC3), -1 when unreadable. }
function InstalledSchemaVersion(Dir, ReleaseId: string): Integer;
var
  Raw: AnsiString;
  Text, Digits: string;
  At, I: Integer;
begin
  Result := -1;
  if not LoadStringFromFile(AddBackslash(Dir) + 'releases\' + ReleaseId + '\app\deployment-health.json', Raw) then
    exit;
  Text := String(Raw);
  At := Pos('"databaseSchemaVersion":', Text);
  if At = 0 then
  begin
    Result := 1;
    exit;
  end;
  I := At + Length('"databaseSchemaVersion":');
  while (I <= Length(Text)) and (Text[I] = ' ') do
    I := I + 1;
  Digits := '';
  while (I <= Length(Text)) and (Text[I] >= '0') and (Text[I] <= '9') do
  begin
    Digits := Digits + Text[I];
    I := I + 1;
  end;
  Result := StrToIntDef(Digits, -1);
end;

{ What this run will do, in the words the Ready page uses. }
function InstallKindText(): string;
var
  Active: string;
begin
  Active := ActiveReleaseIn(WizardDirValue);
  if Active = '{#CivicReleaseId}' then
    Result := '修复（重新安装同一版本 {#CivicDisplayVersion}，沿用原安装位置）'
  else if Active <> '' then
    Result := '升级（从已安装的 ' + Active + ' 升级到 {#CivicDisplayVersion}，沿用原安装位置）'
  else if WizardForm.PrevAppDir <> '' then
    Result := '重新安装（沿用上一次的安装位置）'
  else
    Result := '全新安装';
end;

{ The Ready page always states the effective installation directory and what kind of run this is.

  On an upgrade or a repair the directory page is skipped (DisableDirPage=auto) and Inno's own memo can
  omit the directory entirely, so a person could not see where the program was going. This memo is built
  from WizardDirValue, which is the directory that will actually be used in every case. }
function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo,
  MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
var
  Active: string;
begin
  Active := ActiveReleaseIn(WizardDirValue);
  Result := '安装位置：' + NewLine + Space + WizardDirValue + NewLine + NewLine +
            '安装类型：' + NewLine + Space + InstallKindText() + NewLine + NewLine +
            '版本：' + NewLine + Space + '{#CivicDisplayVersion}（{#CivicReleaseId}）' + NewLine + NewLine +
            '固定访问地址：' + NewLine + Space + '{#CivicOrigin}' + NewLine;
  if MemoTasksInfo <> '' then
    Result := Result + NewLine + MemoTasksInfo + NewLine;
  { Only on a real upgrade: a repair reinstalls the version already running, so there is no old page to
    close and no update to apply. The first probe of this page showed the note on a repair. It is said
    BEFORE installing because the pages to close are the previous version's; after the upgrade the update
    check page (civic-server /api/civic/start) refuses to switch while any of them is still open. }
  if (Active <> '') and (Active <> '{#CivicReleaseId}') then
    Result := Result + NewLine + '升级前请保存并关闭已打开的{#CivicAppName}页面。' + NewLine;
end;

{ True when bin\civic-server.exe is absent or can be opened for writing -- i.e. no process still holds
  its image. This is the condition Setup's own file copy needs, asked directly rather than inferred
  from a timeout. }
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

{ Refuse, before anything is copied, to install this release over one whose application uses a newer
  browser-database schema. civic-admin refuses the same activation; saying it here, in words, is what
  keeps the person from finishing a wizard that then leaves the newer version running. }
function NewerSchemaInstalled(var Message: string): Boolean;
var
  Active: string;
  Installed: Integer;
begin
  Result := False;
  Active := ActiveReleaseIn(ExpandConstant('{app}'));
  if (Active = '') or (Active = '{#CivicReleaseId}') then
    exit;
  Installed := InstalledSchemaVersion(ExpandConstant('{app}'), Active);
  if Installed > {#CivicSchemaVersion} then
  begin
    Message := '已安装的版本 ' + Active + ' 使用较新的数据格式（第 ' + IntToStr(Installed) + ' 版），' +
               '本安装程序的版本 {#CivicDisplayVersion} 使用第 {#CivicSchemaVersion} 版。' + #13#10#13#10 +
               '浏览器中的记录已由较新的版本升级，较旧的版本可能在编辑或删除时损坏上下级关系，' +
               '而数据格式不能降级。' + #13#10#13#10 +
               '请继续使用已安装的版本。未写入任何文件。';
    Result := True;
  end;
end;

{ Stop a local service left running by a previous installation, then check the runtime preconditions,
  before a single file is copied.

  Windows will not let Setup overwrite a running executable. With /SUPPRESSMSGBOXES the file-in-use
  error aborts silently with exit code 5, which is what happened during the RC1 rehearsal: an uninstall
  could not delete civic-server.exe because the local service was up, and the following reinstall then
  aborted on the locked file, leaving the tree holding one orphaned binary and nothing else.

  Order matters here. The schema check comes first, because it must refuse before anything is stopped.
  The running service is stopped next, so that the port check afterwards is not looking at our own local
  service and calling it a blocker -- an upgrade legitimately runs while the previous version is up. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  OldAdmin, Refusal: string;
  ResultCode, I: Integer;
begin
  Result := '';

  if NewerSchemaInstalled(Refusal) then
  begin
    Result := Refusal;
    exit;
  end;

  if DirExists(ExpandConstant('{app}\bin')) then
  begin
    { Prefer the installed civic-admin, which belongs to the version being replaced. Fall back to the
      copy already extracted for the preflight: an interrupted uninstall can leave a running local
      service behind with no civic-admin next to it, and exiting early in that state is what let the
      following install abort on the locked executable. }
    OldAdmin := ExpandConstant('{app}\bin\civic-admin.exe');
    if not FileExists(OldAdmin) then
      OldAdmin := CheckerPath();

    if FileExists(OldAdmin) then
    begin
      if not Exec(OldAdmin, 'deactivate --root "' + ExpandConstant('{app}') + '"',
                  '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
      begin
        { DiagnosticSentence() must NOT be used here. It reports the last preflight report, and a
          passing stage deletes its own report -- so on the ordinary path into this branch the
          variable is empty and the sentence would announce that the Desktop, profile and temp
          directory are all unwritable. That would be an invented failure. }
        Result := '无法停止正在运行的政务工作记录台：停止工具无法执行。' + #13#10#13#10 +
                  '请从开始菜单运行“维护工具 → 停止本地服务”，然后重新安装。' + #13#10#13#10 +
                  '技术细节（反馈时请一并提供）：' + #13#10 + OldAdmin;
        exit;
      end;

      { deactivate returns 0 when the local service is stopped or was never running. Anything else means
        it refused, which it does deliberately when it cannot confirm ownership -- never force past that. }
      if ResultCode <> 0 then
      begin
        Result := '端口 8765 上的服务无法安全停止。' + #13#10#13#10 +
                  '程序不会强行结束无法确认归属的进程。' + #13#10 +
                  '请关闭占用该端口的程序后重新安装。';
        exit;
      end;

      { The executables are released a moment after the process exits. Give Windows that moment, or the
        copy that follows races the handle being closed. }
      for I := 1 to 60 do
      begin
        if CanWriteServerBinary() then
          break;
        Sleep(250);
      end;
      Sleep(500);
    end;
  end;

  ResultCode := RunPreflight('runtime', ExpandConstant('{app}'));
  if ResultCode = 0 then
    exit;

  if ResultCode = -1 then
    Result := '无法运行安装前检查程序，可能被安全软件拦截。' + #13#10#13#10 + DiagnosticSentence()
  else
    Result := '端口 8765 已被其他程序占用，政务工作记录台无法启动。' + #13#10#13#10 +
              '程序不会强行结束无法确认归属的进程，也不会改用其他端口。' + #13#10 +
              '更换端口会改变浏览器来源，原有记录不会在新的来源下显示。' + #13#10#13#10 +
              '请关闭占用该端口的程序后重试。' + #13#10#13#10 +
              NothingInstalledSentence() + #13#10#13#10 + DiagnosticSentence();
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  { ssPostInstall runs after every [Run] entry flagged waituntilterminated, so activation has already
    happened. The check names THIS release and requires it to be the active one: RC1-RC3 verified
    whatever current.txt named, so an activation that had been refused left the previous release
    active, the check passed on that, and Setup reported a finished installation of a version that was
    not running. }
  if CurStep <> ssPostInstall then
    exit;

  if not Exec(ExpandConstant('{app}\bin\civic-admin.exe'),
              'verify --root "' + ExpandConstant('{app}') + '" --release {#CivicReleaseId} --expect-active',
              '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    ResultCode := -1;

  if ResultCode <> 0 then
    SuppressibleMsgBox('版本文件已解压，但版本 {#CivicDisplayVersion} 没有被启用。' + #13#10#13#10 +
           '之前可用的版本（如果有）没有被破坏，仍然可以正常使用。' + #13#10 +
           '请从开始菜单运行“维护工具 → 收集诊断信息”，' + #13#10 +
           '并将生成的诊断文件（TXT）反馈给维护人员。',
           mbError, MB_OK, IDOK);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  { Said at the moment it matters, not buried in a document: removing the program is not removing the
    records. Suppressible, like every message box a silent run can reach: a plain MsgBox ignores
    /SUPPRESSMSGBOXES, and a scripted silent uninstall then waited on this box with nobody to close it
    (found in Phase-6 acceptance, 2026-09-30). }
  if CurUninstallStep = usPostUninstall then
    SuppressibleMsgBox('政务工作记录台已卸载。' + #13#10#13#10 +
           '卸载程序不等于删除数据。' + #13#10#13#10 +
           '工作记录保存在浏览器的站点数据中。卸载不会删除该站点数据，' + #13#10 +
           '也不会删除已导出的 JSON、Excel（.xlsx）、Word（.docx）文件。' + #13#10#13#10 +
           '若以后使用同一浏览器及同一浏览器配置文件，并通过同一固定访问地址' + #13#10 +
           '{#CivicOrigin} 安装兼容版本，原有记录仍可访问。' + #13#10#13#10 +
           '如果确实要清除浏览器中的数据，需要在浏览器的“站点数据”里手动删除。',
           mbInformation, MB_OK, IDOK);
end;
