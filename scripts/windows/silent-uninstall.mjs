/**
 * Silent uninstall for the Windows acceptance scripts, including the part that runs after unins000.exe
 * has returned.
 *
 * Inno Setup's unins000.exe copies itself to %TEMP% as `_unins.tmp`, starts that copy with
 * `/SECONDPHASE="<root>\unins000.exe"` and exits at once; the copy does the actual work. A caller that
 * waits for unins000.exe alone therefore learns nothing about how the uninstall ended. That hid a defect
 * until Phase 6: the uninstaller's closing notice was a plain MsgBox, which ignores /SUPPRESSMSGBOXES, so
 * every "silent" uninstall left a dialog waiting on the operator's screen with nobody to close it.
 *
 * `silentUninstall` waits, bounded, for the second phase to end by itself and says whether it did. If it
 * has not, the phase is still waiting on a message box: its window is closed the way its OK button would
 * close it, so the uninstall completes and no dialog is left behind, and the result says so. Only a
 * second phase whose command line names this installation root is touched.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Second-phase uninstallers of `root` still running; with `dismiss`, their windows are closed first. */
function secondPhases(root, dismiss) {
  const script = [
    '$root = $env:CIVIC_UNINSTALL_ROOT.ToLowerInvariant()',
    '$found = @(Get-CimInstance Win32_Process -Filter "Name=\'_unins.tmp\'" | Where-Object {',
    '  $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($root) })',
    "if ($env:CIVIC_UNINSTALL_DISMISS -eq '1') {",
    '  foreach ($p in $found) {',
    '    $h = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue',
    '    if ($h) { [void]$h.CloseMainWindow() } } }',
    '$found.Count',
  ].join('\n');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      CIVIC_UNINSTALL_ROOT: join(root, 'unins000.exe'),
      CIVIC_UNINSTALL_DISMISS: dismiss ? '1' : '0',
    },
  });
  const count = Number.parseInt((r.stdout ?? '').trim(), 10);
  return Number.isNaN(count) ? -1 : count;
}

/**
 * @param {string} root the installation root holding unins000.exe
 * @param {{ waitMs?: number }} [options]
 * @returns {Promise<{ code: number | null, finishedByItself: boolean, dismissed: boolean }>}
 *   code is unins000.exe's exit code, or -1 when there is no uninstaller in `root`.
 */
export async function silentUninstall(root, { waitMs = 60_000 } = {}) {
  const unins = join(root, 'unins000.exe');
  if (!existsSync(unins)) return { code: -1, finishedByItself: true, dismissed: false };
  const r = spawnSync(unins, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const deadline = Date.now() + waitMs;
  for (;;) {
    const running = secondPhases(root, false);
    if (running === 0) return { code: r.status, finishedByItself: true, dismissed: false };
    if (Date.now() > deadline) break;
    await sleep(1000);
  }
  secondPhases(root, true);
  for (let i = 0; i < 20 && secondPhases(root, false) > 0; i += 1) await sleep(500);
  return { code: r.status, finishedByItself: false, dismissed: true };
}
