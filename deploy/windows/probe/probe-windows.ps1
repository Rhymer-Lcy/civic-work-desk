<#
.SYNOPSIS
    CivicWorkDesk -- Windows 11 deployment probe (Phase 4, Stage A). Read-only.

.DESCRIPTION
    Characterises a Windows 11 machine so a local-server mechanism can be chosen from evidence instead
    of from analogy with the UOS deployment. It answers questions; it does not install, configure or
    change anything.

    What it will NOT do, by construction:
      * require or request administrator rights;
      * install, download, or modify any program;
      * change a setting, a registry value, a firewall rule, a URL ACL or any policy;
      * read browser profiles, cookies, history, bookmarks, passwords or any document;
      * leave a server running -- the two bind tests release their sockets immediately;
      * contact the network. Every check is local.
      * test browser PWA capability. Service worker / IndexedDB / Cache Storage / Web Crypto need a
        page served at the canonical origin, so they belong to Stage B, after a server is chosen.

    STATUS TOKENS. Every measured line carries one, so results compare across machines:

      [PASS]        an operation we wanted to succeed, succeeded
      [PRESENT]     the thing exists / is available
      [NOT PRESENT] the thing does not exist -- valid evidence, not a failure
      [DENIED]      permission or policy refused it -- valid evidence, not a failure
      [IN USE]      the resource is occupied by something else
      [INFO]        a plain fact with no pass/fail meaning
      [ERROR]       the query itself failed unexpectedly; the message is quoted verbatim

    ABSENCE IS EVIDENCE. [NOT PRESENT] and [DENIED] are answers we need as much as [PASS] is. The
    probe keeps going rather than stopping at the first one.

    ASCII ONLY. Windows PowerShell 5.1 reads a BOM-less .ps1 in the machine's ANSI code page, so any
    non-ASCII byte in this file is corrupted before the script runs -- which is exactly how an earlier
    revision produced a mojibake report. The bundle builder enforces this.

.NOTES
    Run as an ORDINARY user. If you are prompted for administrator rights, something is wrong -- stop
    and report that instead.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\probe-windows.ps1
#>

[CmdletBinding()]
param(
    [string]$OutDir
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

# $PSScriptRoot is NOT populated inside a param() default value under Windows PowerShell 5.1 -- the
# version colleagues actually have -- so a `Join-Path $PSScriptRoot 'out'` default fails there with
# "Cannot bind argument to parameter 'Path' because it is an empty string". Resolved here instead.
if (-not $OutDir) {
    $root = $PSScriptRoot
    if (-not $root) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }
    if (-not $root) { $root = (Get-Location).Path }
    $OutDir = Join-Path $root 'out'
}

$CanonicalHost = '127.0.0.1'
$CanonicalPort = 8765
$CanonicalOrigin = 'http://127.0.0.1:8765/'

if (-not (Test-Path -LiteralPath $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$report = Join-Path $OutDir "civic-work-desk-windows-probe-$stamp.txt"

$script:Lines = New-Object System.Collections.Generic.List[string]
$script:Summary = New-Object System.Collections.Generic.List[string]

function Emit {
    param([string]$Text = '')
    $script:Lines.Add($Text) | Out-Null
    Write-Host $Text
}

function Section {
    param([string]$Title)
    Emit ''
    Emit ('=' * 78)
    Emit $Title
    Emit ('=' * 78)
}

function Status {
    param(
        [string]$Token,
        [string]$Name,
        $Detail = '',
        [switch]$Key
    )
    Emit ('  [{0,-11}] {1,-32} {2}' -f $Token, $Name, $Detail)
    if ($Key) { $script:Summary.Add(('{0,-11}  {1}' -f $Token, $Name)) | Out-Null }
}

function Info {
    param([string]$Name, $Value)
    if ($null -eq $Value -or "$Value" -eq '') { $Value = '(not available)' }
    Status 'INFO' $Name $Value
}

# A probe must never die on one unavailable API. Every query runs inside this, and a failure is
# reported verbatim rather than swallowed -- a policy or permission message is exactly the diagnostic
# we need back.
function Show-Fact {
    param([string]$Name, [scriptblock]$Probe)
    try {
        Info $Name (& $Probe)
    } catch {
        Status 'ERROR' $Name ("query failed: {0}" -f $_.Exception.Message)
    }
}

function Show-Presence {
    param([string]$Name, [scriptblock]$Probe, [switch]$Key)
    try {
        $value = & $Probe
        if ($value) { Status 'PRESENT' $Name $value -Key:$Key }
        else { Status 'NOT PRESENT' $Name '' -Key:$Key }
    } catch {
        Status 'ERROR' $Name ("query failed: {0}" -f $_.Exception.Message) -Key:$Key
    }
}

Emit 'CivicWorkDesk -- Windows 11 deployment probe (Phase 4, Stage A)'
Emit ''
Emit "collected       : $(Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz')"
Emit "canonical origin: $CanonicalOrigin"
Emit 'read-only       : installs nothing, changes nothing, contacts no network'
Emit ''
Emit 'STATUS TOKENS: [PASS] [PRESENT] [NOT PRESENT] [DENIED] [IN USE] [INFO] [ERROR]'
Emit 'NOT PRESENT and DENIED are evidence, not test failures.'
Emit ''
Emit 'PRIVACY NOTE: this report contains the machine name, the account name and installed-software'
Emit 'versions. It contains no browser data, no documents and no file contents. Redact the account or'
Emit 'machine name before sharing if you prefer; the technical meaning does not depend on them.'

# ---------------------------------------------------------------- 1. Windows identity
Section '1. Windows identity'
Show-Fact 'OS caption' { (Get-CimInstance Win32_OperatingSystem).Caption }
Show-Fact 'OS version' { (Get-CimInstance Win32_OperatingSystem).Version }
Show-Fact 'build' {
    $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop
    '{0}.{1}  DisplayVersion {2}' -f $cv.CurrentBuild, $cv.UBR, $cv.DisplayVersion
}
Show-Fact 'edition' {
    (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop).EditionID
}
Show-Fact 'OS architecture' {
    $a = (Get-CimInstance Win32_OperatingSystem).OSArchitecture
    "$a   (PROCESSOR_ARCHITECTURE=$env:PROCESSOR_ARCHITECTURE)"
}
# Keyed: an ARM64 machine rules out shipping any x64-only binary, so it changes the decision even
# though it is neither a pass nor a failure.
# The verdict is in the NAME, not the detail, because the SUMMARY block prints names only -- an
# "ARM64 machine" line there would otherwise be silent about the answer.
if ($env:PROCESSOR_ARCHITECTURE -match 'ARM' -or $env:PROCESSOR_ARCHITEW6432 -match 'ARM') {
    Status 'INFO' 'ARM64 machine: YES' 'an x64-only binary would not run here' -Key
} else {
    Status 'INFO' 'ARM64 machine: no (x64)' '' -Key
}
Show-Fact 'CPU' { (Get-CimInstance Win32_Processor | Select-Object -First 1).Name }
Show-Fact 'memory (GB)' {
    [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
}

# ---------------------------------------------------------------- 2. account and elevation
Section '2. Account and elevation'
Show-Fact 'user' { "$env:USERDOMAIN\$env:USERNAME" }
$elevated = $false
try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $elevated = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }
if ($elevated) {
    Status 'INFO' 'running elevated' 'TRUE -- please re-run WITHOUT administrator rights' -Key
} else {
    Status 'PASS' 'running as ordinary user' 'not elevated (this is what we need)' -Key
}
Show-Fact 'in local Administrators' {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    ($id.Groups | ForEach-Object { $_.Translate([Security.Principal.NTAccount]).Value }) -contains
        'BUILTIN\Administrators'
}

# ---------------------------------------------------------------- 3. PowerShell and policy
Section '3. PowerShell and execution policy'
Show-Fact 'PSVersion (this host)' { $PSVersionTable.PSVersion.ToString() }
Show-Fact 'PSEdition' { $PSVersionTable.PSEdition }
Show-Presence 'Windows PowerShell 5.1' {
    $p = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (Test-Path -LiteralPath $p) { $p } else { $null }
} -Key
Show-Presence 'PowerShell 7+' {
    $c = Get-Command pwsh.exe -ErrorAction SilentlyContinue
    if ($c) {
        $v = & $c.Source -NoProfile -Command '$PSVersionTable.PSVersion.ToString()' 2>$null
        "$v   $($c.Source)"
    } else { $null }
} -Key
Show-Fact 'ExecutionPolicy (effective)' { Get-ExecutionPolicy }
Show-Fact 'ExecutionPolicy (per scope)' {
    (Get-ExecutionPolicy -List | ForEach-Object { "$($_.Scope)=$($_.ExecutionPolicy)" }) -join '  '
}
Show-Fact '.NET runtime' { [System.Runtime.InteropServices.RuntimeInformation]::FrameworkDescription }

# ---------------------------------------------------------------- 4. tools
Section '4. Tools'
foreach ($tool in 'curl.exe', 'tar.exe', 'certutil.exe', 'where.exe', 'explorer.exe') {
    Show-Presence $tool {
        $c = Get-Command $tool -ErrorAction SilentlyContinue
        if ($c) { $c.Source } else { $null }
    }
}
Show-Presence 'Get-FileHash' {
    if (Get-Command Get-FileHash -ErrorAction SilentlyContinue) { 'cmdlet available' } else { $null }
} -Key
Show-Presence 'Expand-Archive' {
    if (Get-Command Expand-Archive -ErrorAction SilentlyContinue) { 'cmdlet available' } else { $null }
}

# ---------------------------------------------------------------- 5. writable user locations
Section '5. Writable user locations'
$locations = [ordered]@{
    'LOCALAPPDATA' = $env:LOCALAPPDATA
    'APPDATA'      = $env:APPDATA
    'USERPROFILE'  = $env:USERPROFILE
    'TEMP'         = $env:TEMP
    'Desktop'      = [Environment]::GetFolderPath('Desktop')
    'Start Menu'   = [Environment]::GetFolderPath('Programs')
    'Downloads'    = (Join-Path $env:USERPROFILE 'Downloads')
}
foreach ($name in $locations.Keys) {
    $path = $locations[$name]
    # LOCALAPPDATA is where the install would live, so its result is keyed into the summary; the rest
    # are context.
    $key = ($name -eq 'LOCALAPPDATA')
    if (-not $path) { Status 'NOT PRESENT' $name '(environment variable unset)' -Key:$key; continue }
    try {
        $probeFile = Join-Path $path (".civic-probe-{0}.tmp" -f ([guid]::NewGuid().ToString('N')))
        Set-Content -LiteralPath $probeFile -Value 'probe' -ErrorAction Stop
        Remove-Item -LiteralPath $probeFile -Force -ErrorAction SilentlyContinue
        Status 'PASS' ("$name writable") $path -Key:$key
    } catch {
        Status 'DENIED' ("$name writable") ("{0}   ({1})" -f $path, $_.Exception.Message) -Key:$key
    }
}
Show-Fact 'proposed install root' {
    if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'CivicWorkDesk' } else { '(no LOCALAPPDATA)' }
}

# ---------------------------------------------------------------- 6. browsers
Section '6. Browsers'
Emit '  Only version and path are read. No profile, cookie, history or bookmark data is touched.'
Emit ''
$browsers = [ordered]@{
    'Microsoft Edge' = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'))
    'Google Chrome'  = @(
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'))
    '360 Browser'    = @(
        (Join-Path $env:LOCALAPPDATA '360Chrome\Chrome\Application\360chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} '360\360se6\Application\360se.exe'),
        (Join-Path ${env:ProgramFiles(x86)} '360Chrome\Chrome\Application\360chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} '360se6\Application\360se.exe'))
    'Firefox'        = @(
        (Join-Path $env:ProgramFiles 'Mozilla Firefox\firefox.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Mozilla Firefox\firefox.exe'))
}
foreach ($name in $browsers.Keys) {
    $found = $null
    foreach ($candidate in $browsers[$name]) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { $found = $candidate; break }
    }
    if ($found) {
        $version = 'version unreadable'
        try { $version = (Get-Item -LiteralPath $found).VersionInfo.ProductVersion } catch { }
        Status 'PRESENT' $name "$version   $found" -Key
    } else {
        Status 'NOT PRESENT' $name 'not in the usual install locations' -Key
    }
}
Show-Fact 'default http handler' {
    $key = 'HKCU:\SOFTWARE\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice'
    (Get-ItemProperty -Path $key -ErrorAction Stop).ProgId
}
Show-Fact 'default https handler' {
    $key = 'HKCU:\SOFTWARE\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice'
    (Get-ItemProperty -Path $key -ErrorAction Stop).ProgId
}

# ---------------------------------------------------------------- 7. the port
Section "7. Port $CanonicalPort"
$portOwner = $null
try {
    $portOwner = Get-NetTCPConnection -LocalPort $CanonicalPort -State Listen -ErrorAction SilentlyContinue
} catch { }
if ($portOwner) {
    $desc = ($portOwner | ForEach-Object {
        $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
        "{0} pid {1} ({2})" -f $_.LocalAddress, $_.OwningProcess, $(if ($p) { $p.ProcessName } else { 'unknown' })
    }) -join '; '
    Status 'IN USE' "port $CanonicalPort" $desc -Key
} else {
    Status 'PASS' "port $CanonicalPort free" 'nothing is listening' -Key
}
# Hyper-V, WSL2 and Docker reserve large dynamic TCP ranges at boot. A reserved range makes the bind
# fail with no process visible as the owner, which reads like a mystery unless it is measured here.
try {
    $excl = & netsh int ipv4 show excludedportrange protocol=tcp 2>&1 | Out-String
    $hits = @()
    foreach ($line in ($excl -split "`r?`n")) {
        if ($line -match '^\s*(\d+)\s+(\d+)') {
            $lo = [int]$Matches[1]
            $hi = [int]$Matches[2]
            if ($lo -le $CanonicalPort -and $hi -ge $CanonicalPort) { $hits += "$lo-$hi" }
        }
    }
    if ($hits.Count -gt 0) {
        Status 'IN USE' "port $CanonicalPort reserved" ('excluded range(s): ' + ($hits -join ', ')) -Key
    } else {
        Status 'PASS' "port $CanonicalPort not reserved" 'no excluded TCP range covers it' -Key
    }
} catch {
    Status 'ERROR' "port $CanonicalPort reservation" ("query failed: {0}" -f $_.Exception.Message) -Key
}

# ---------------------------------------------------------------- 8. Candidate B
Section '8. Candidate B -- raw TcpListener bind on 127.0.0.1:8765'
try {
    $addr = [System.Net.IPAddress]::Parse($CanonicalHost)
    $listener = New-Object System.Net.Sockets.TcpListener($addr, $CanonicalPort)
    $listener.Start()
    $ep = $listener.LocalEndpoint.ToString()
    $listener.Stop()
    Status 'PASS' 'TcpListener bind' "bound $ep as an ordinary user, then released it" -Key
} catch {
    Status 'DENIED' 'TcpListener bind' ("{0}" -f $_.Exception.Message) -Key
}
Emit ''
Emit '  This is the load-bearing measurement for a PowerShell socket server. DENIED here is a genuine'
Emit '  finding and must not be worked around by asking for administrator rights.'

# ---------------------------------------------------------------- 9. Candidate A
Section '9. Candidate A -- HttpListener prefix http://127.0.0.1:8765/'
try {
    $hl = New-Object System.Net.HttpListener
    $hl.Prefixes.Add("http://$CanonicalHost`:$CanonicalPort/")
    $hl.Start()
    $hl.Stop()
    $hl.Close()
    Status 'PASS' 'HttpListener prefix' 'http.sys accepted the literal 127.0.0.1 prefix, un-elevated' -Key
} catch {
    Status 'DENIED' 'HttpListener prefix' ("{0}" -f $_.Exception.Message) -Key
}
Emit ''
Emit '  Both outcomes are real measurements. http.sys requires a URL ACL for wildcard prefixes'
Emit '  (+, *, a hostname) but generally permits a literal 127.0.0.1 prefix without one. If this is'
Emit '  DENIED while section 8 passes, Candidate A is out for this machine.'
Show-Fact 'URL ACL mentioning 8765' {
    $out = & netsh http show urlacl 2>&1 | Out-String
    if ($out -match '8765') { 'an ACL referencing 8765 exists' } else { 'none' }
}

# ---------------------------------------------------------------- 10. shortcut / pointer feasibility
Section '10. Shortcut and pointer feasibility (nothing is created outside TEMP)'
Show-Presence 'WScript.Shell (shortcuts)' {
    $null = New-Object -ComObject WScript.Shell
    'available -- Start Menu shortcut creation is possible'
} -Key
try {
    $base = Join-Path $env:TEMP ("civic-probe-{0}" -f ([guid]::NewGuid().ToString('N')))
    $target = Join-Path $base 'target'
    $link = Join-Path $base 'link'
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    $r = & cmd.exe /c mklink /J "`"$link`"" "`"$target`"" 2>&1 | Out-String
    $ok = Test-Path -LiteralPath $link
    Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue
    if ($ok) { Status 'PASS' 'directory junction' 'junctions work without elevation' -Key }
    else { Status 'DENIED' 'directory junction' ($r.Trim()) -Key }
} catch {
    Status 'ERROR' 'directory junction' ("{0}" -f $_.Exception.Message) -Key
}
Show-Fact 'Developer Mode (symlinks)' {
    $k = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock'
    $v = (Get-ItemProperty -Path $k -ErrorAction Stop).AllowDevelopmentWithoutDevLicense
    if ($v -eq 1) { 'enabled' } else { 'disabled' }
}

# ---------------------------------------------------------------- summary
Section 'SUMMARY -- the lines that decide the Windows server mechanism'
foreach ($line in $script:Summary) { Emit ("  {0}" -f $line) }
Emit ''
Emit '  Stage A deliberately does NOT test service worker, IndexedDB, Cache Storage or Web Crypto.'
Emit '  Those need a page served at the canonical origin and belong to Stage B.'

Section 'END'
Emit ''
Emit 'Nothing was installed, started or left running. Both bind tests released their sockets.'
Emit ''

Set-Content -LiteralPath $report -Value ($script:Lines -join "`r`n") -Encoding UTF8
Write-Host ''
Write-Host 'Report written to:'
Write-Host "    $report"
Write-Host ''
Write-Host 'Please return that file. You may read it first -- it contains no browser data and no'
Write-Host 'document contents, only machine and software facts.'
