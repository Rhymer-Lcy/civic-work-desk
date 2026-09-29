/**
 * Drive a real Inno Setup wizard to its Ready page, read what the page says, and cancel.
 *
 * The silent installs the acceptance suites use never draw a page, so the Ready page -- which must always
 * state the effective installation directory and whether this run is a fresh install, an upgrade or a
 * repair -- can only be checked by clicking through the wizard as a person would. This does that through
 * UI Automation, then cancels, so nothing is installed.
 *
 * Inno's Setup.exe is a loader: the wizard window belongs to a child process it extracts and starts, so
 * the window is found by its title ("安装 - <AppName>"), not by the loader's process id.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const BOM = String.fromCharCode(0xfeff);

const PROBE = String.raw`
param($out, $setup, $appName)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
# Not $True: that is PowerShell's read-only automatic variable, the assignment fails, and every FindAll
# below then receives a boolean -- which is how the first run of this probe found no window at all.
$Every = [System.Windows.Automation.Condition]::TrueCondition
# Inno's controls are custom classes (TNewButton, TNewStaticText, TNewMemo): UI Automation sees them as
# plain panes with no Invoke or Value pattern -- measured by dumping the live tree. So UI Automation only
# FINDS them; clicking and reading go through Win32 messages, which Windows marshals across processes.
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class CivicWin32 {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, StringBuilder l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static string Text(IntPtr h) {
    int n = (int)SendMessage(h, 0x000E, IntPtr.Zero, IntPtr.Zero);
    StringBuilder s = new StringBuilder(n + 1);
    SendMessage(h, 0x000D, (IntPtr)(n + 1), s);
    return s.ToString();
  }
  public static void Click(IntPtr h) { PostMessage(h, 0x00F5, IntPtr.Zero, IntPtr.Zero); }
}
'@
$log = @()

function Find-Wizard {
  foreach ($w in $AE::RootElement.FindAll($Scope::Children, $Every)) {
    if ($w.Current.Name -eq ('安装 - ' + $appName)) { return $w }
  }
  return $null
}
# Visible elements only: every wizard page exists at once, and the hidden ones still carry their text.
function Find-Named($root, $pattern) {
  foreach ($e in $root.FindAll($Scope::Descendants, $Every)) {
    if (-not $e.Current.IsOffscreen -and $e.Current.Name.Trim() -match $pattern) { return $e }
  }
  return $null
}
function Click($e) { [CivicWin32]::Click([IntPtr]$e.Current.NativeWindowHandle) }

$p = Start-Process -FilePath $setup -PassThru
$wizard = $null
for ($i = 0; $i -lt 150 -and -not $wizard; $i++) { Start-Sleep -Milliseconds 200; $wizard = Find-Wizard }
$memo = ''
$reached = $false
if ($wizard) {
  for ($step = 0; $step -lt 8 -and -not $reached; $step++) {
    Start-Sleep -Milliseconds 1200
    if (Find-Named $wizard '^准备安装$') { $reached = $true; break }
    foreach ($title in ('^安装' + $appName + '$'), '^选择目标位置$', '^选择附加任务$') {
      if (Find-Named $wizard $title) { $log += ('page ' + $title.Trim('^', '$')) }
    }
    $next = Find-Named $wizard '^下一步'
    if (-not $next) { $log += 'no next button'; break }
    Click $next
  }
  if ($reached) {
    $log += 'page 准备安装'
    foreach ($e in $wizard.FindAll($Scope::Descendants, $Every)) {
      if ($e.Current.ClassName -match 'Memo' -and -not $e.Current.IsOffscreen) {
        $v = [CivicWin32]::Text([IntPtr]$e.Current.NativeWindowHandle)
        if ($v.Length -gt $memo.Length) { $memo = $v }
      }
    }
  }
  $cancel = Find-Named $wizard '^取消$'
  if ($cancel) {
    Click $cancel
    for ($i = 0; $i -lt 50; $i++) {
      Start-Sleep -Milliseconds 200
      # The confirmation is owned by the wizard, so UI Automation lists it UNDER the wizard, not at the
      # root -- measured; searching the root found nothing and left the wizard open.
      $confirm = Find-Named $wizard '^退出安装程序$'
      if ($confirm) { $yes = Find-Named $confirm '^是'; if ($yes) { Click $yes; break } }
    }
  }
}
for ($i = 0; $i -lt 100; $i++) { if (-not (Find-Wizard)) { break }; Start-Sleep -Milliseconds 200 }
$lines = @()
$lines += 'wizard=' + [bool]$wizard
$lines += 'reached=' + $reached
$lines += 'pages=' + ($log -join ',')
$lines += 'closed=' + (-not (Find-Wizard))
$lines += 'memo=' + ($memo -replace '\r?\n', ' | ')
[System.IO.File]::WriteAllText($out, ($lines -join [char]10), [System.Text.Encoding]::UTF8)
`;

/**
 * @param {string} setupPath the installer to drive
 * @param {string} appName its AppName, which titles the wizard window
 * @returns {{ wizard: boolean, reached: boolean, pages: string, closed: boolean, memo: string }}
 */
export function readyPageOf(setupPath, appName) {
  const tmp = process.env.TEMP ?? '.';
  const scriptPath = join(tmp, `civic-wizard-probe-${process.pid}.ps1`);
  const outPath = join(tmp, `civic-wizard-probe-${process.pid}.out`);
  rmSync(outPath, { force: true });
  writeFileSync(scriptPath, `${BOM}${PROBE}\n`, 'utf8');
  spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, outPath, setupPath, appName],
    { encoding: 'utf8', windowsHide: true, timeout: 120000 },
  );
  const text = existsSync(outPath) ? readFileSync(outPath, 'utf8').replace(BOM, '') : '';
  rmSync(outPath, { force: true });
  rmSync(scriptPath, { force: true });
  // Whatever happened above, no wizard may outlive the probe: an abandoned one sits on its Welcome page
  // holding Setup's temp directory. It has installed nothing at that point, so stopping it is harmless.
  const base = basename(setupPath).replace(/\.exe$/i, '');
  const leftover = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Get-Process | Where-Object { $_.ProcessName -eq '${base}' -or $_.ProcessName -eq '${base}.tmp' } | ForEach-Object { Stop-Process -Id $_.Id -Force; $_.Id }`,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  const fields = Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  return {
    wizard: fields.wizard === 'True',
    reached: fields.reached === 'True',
    pages: fields.pages ?? '',
    closed: fields.closed === 'True',
    memo: fields.memo ?? '',
    strayProcessesStopped: (leftover.stdout ?? '').trim().split(/\s+/).filter(Boolean).length,
  };
}
