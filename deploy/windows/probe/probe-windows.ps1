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
      * change a setting, a registry value, a firewall rule or a URL ACL;
      * read browser profiles, cookies, history, bookmarks or any document;
      * leave a server running -- the two bind tests release their sockets immediately;
      * contact the network. Every check is local.

    ABSENCE IS A VALID RESULT. "not present", "denied" and "in use" are measurements. The probe is not
    failing when it reports them, and it deliberately keeps going rather than stopping at the first.

.NOTES
    Run as an ORDINARY user. If you are prompted for administrator rights, something is wrong -- stop
    and report that instead.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\probe-windows.ps1
#>

[CmdletBinding()]
param(
    [string]$OutDir
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

# $PSScriptRoot is NOT populated inside a param() default value under Windows PowerShell 5.1 -- the
# version colleagues actually have -- so a `Join-Path $PSScriptRoot 'out'` default fails there with
# "Cannot bind argument to parameter 'Path' because it is an empty string". Resolved here instead,
# with a fallback for the case where the script is piped rather than invoked by path.
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

function Emit {
    param([string]$Text = '')
    $script:Lines.Add($Text) | Out-Null
    Write-Host $Text
}

function Section {
    param([string]$Title)
    Emit ''
    Emit ('=' * 70)
    Emit $Title
    Emit ('=' * 70)
}

function Item {
    param([string]$Name, $Value)
    if ($null -eq $Value -or "$Value" -eq '') { $Value = '(not available)' }
    Emit ('  {0,-34} {1}' -f $Name, $Value)
}

# A probe must never die on one unavailable API. Every check runs inside this.
function Try-Item {
    param([string]$Name, [scriptblock]$Probe)
    try {
        Item $Name (& $Probe)
    } catch {
        Item $Name ("(query failed: {0})" -f $_.Exception.Message)
    }
}

Emit 'CivicWorkDesk -- Windows 11 deployment probe (Phase 4, Stage A)'
Emit ''
Emit "collected      : $(Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz')"
Emit "canonical origin: $CanonicalOrigin"
Emit 'read-only      : this probe installs nothing and changes nothing'
Emit ''
Emit 'PRIVACY NOTE: this report contains the machine name, the account name and installed-software'
Emit 'versions. It contains no browser data, no documents and no file contents. Redact the account or'
Emit 'machine name before sharing if you prefer; the technical meaning does not depend on them.'

# ---------------------------------------------------------------- 1. Windows identity
Section '1. Windows identity'
Try-Item 'OS caption' { (Get-CimInstance Win32_OperatingSystem).Caption }
Try-Item 'OS version' { (Get-CimInstance Win32_OperatingSystem).Version }
Try-Item 'build' {
    $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop
    '{0} (UBR {1}) DisplayVersion {2}' -f $cv.CurrentBuild, $cv.UBR, $cv.DisplayVersion
}
Try-Item 'edition' {
    (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop).EditionID
}
Try-Item 'OS architecture' { (Get-CimInstance Win32_OperatingSystem).OSArchitecture }
Try-Item 'process architecture' { $env:PROCESSOR_ARCHITECTURE }
Try-Item 'is 64-bit process' { [Environment]::Is64BitProcess }
Try-Item 'CPU' { (Get-CimInstance Win32_Processor | Select-Object -First 1).Name }
Try-Item 'memory (GB)' {
    [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
}

# ---------------------------------------------------------------- 2. account and elevation
Section '2. Account and elevation'
Try-Item 'user' { "$env:USERDOMAIN\$env:USERNAME" }
Try-Item 'running elevated' {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}
Try-Item 'in local Administrators' {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    ($id.Groups | ForEach-Object { $_.Translate([Security.Principal.NTAccount]).Value }) -contains
        'BUILTIN\Administrators'
}
Emit ''
Emit '  Note: "running elevated = False" is the expected and desired result. The product must install'
Emit '  and run without elevation; a probe run as administrator would measure the wrong machine.'

# ---------------------------------------------------------------- 3. PowerShell
Section '3. PowerShell'
Try-Item 'PSVersion (this host)' { $PSVersionTable.PSVersion.ToString() }
Try-Item 'PSEdition' { $PSVersionTable.PSEdition }
Try-Item 'CLR version' { $PSVersionTable.CLRVersion }
Try-Item 'Windows PowerShell 5.1 present' {
    $p = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (Test-Path -LiteralPath $p) { $p } else { 'no' }
}
Try-Item 'PowerShell 7+ present' {
    $c = Get-Command pwsh.exe -ErrorAction SilentlyContinue
    if ($c) { "$($c.Source)  ($((& $c.Source -NoProfile -Command '$PSVersionTable.PSVersion.ToString()')))" }
    else { 'no' }
}
Try-Item 'ExecutionPolicy (effective)' { Get-ExecutionPolicy }
Try-Item 'ExecutionPolicy (per scope)' {
    (Get-ExecutionPolicy -List | ForEach-Object { "$($_.Scope)=$($_.ExecutionPolicy)" }) -join ' '
}
Try-Item '.NET runtime' { [System.Runtime.InteropServices.RuntimeInformation]::FrameworkDescription }

# ---------------------------------------------------------------- 4. tools we might rely on
Section '4. Tools present'
foreach ($tool in 'curl.exe', 'tar.exe', 'certutil.exe', 'where.exe', 'powershell.exe', 'explorer.exe') {
    Try-Item $tool {
        $c = Get-Command $tool -ErrorAction SilentlyContinue
        if ($c) { $c.Source } else { 'not present' }
    }
}
Try-Item 'Get-FileHash cmdlet' {
    if (Get-Command Get-FileHash -ErrorAction SilentlyContinue) { 'available' } else { 'not available' }
}
Try-Item 'Expand-Archive cmdlet' {
    if (Get-Command Expand-Archive -ErrorAction SilentlyContinue) { 'available' } else { 'not available' }
}

# ---------------------------------------------------------------- 5. writable user locations
Section '5. Writable user locations'
$locations = [ordered]@{
    'LOCALAPPDATA'   = $env:LOCALAPPDATA
    'APPDATA'        = $env:APPDATA
    'USERPROFILE'    = $env:USERPROFILE
    'TEMP'           = $env:TEMP
    'Desktop'        = [Environment]::GetFolderPath('Desktop')
    'Start Menu'     = [Environment]::GetFolderPath('Programs')
    'Downloads'      = (Join-Path $env:USERPROFILE 'Downloads')
}
foreach ($name in $locations.Keys) {
    $path = $locations[$name]
    $verdict = '(unset)'
    if ($path) {
        try {
            $probeFile = Join-Path $path (".civic-probe-{0}.tmp" -f ([guid]::NewGuid().ToString('N')))
            Set-Content -LiteralPath $probeFile -Value 'probe' -ErrorAction Stop
            Remove-Item -LiteralPath $probeFile -Force -ErrorAction SilentlyContinue
            $verdict = "writable   $path"
        } catch {
            $verdict = "NOT writable   $path"
        }
    }
    Item $name $verdict
}
Try-Item 'proposed install root' {
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
        (Join-Path ${env:ProgramFiles(x86)} '360Chrome\Chrome\Application\360chrome.exe'))
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
        $version = try { (Get-Item -LiteralPath $found).VersionInfo.ProductVersion } catch { 'unknown' }
        Item $name "$version   $found"
    } else {
        Item $name 'not found in the usual locations'
    }
}
Try-Item 'default http handler (ProgId)' {
    $key = 'HKCU:\SOFTWARE\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice'
    (Get-ItemProperty -Path $key -ErrorAction Stop).ProgId
}
Try-Item 'default https handler (ProgId)' {
    $key = 'HKCU:\SOFTWARE\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice'
    (Get-ItemProperty -Path $key -ErrorAction Stop).ProgId
}

# ---------------------------------------------------------------- 7. the port
Section "7. Port $CanonicalPort and loopback"
Try-Item "listeners on $CanonicalPort" {
    $c = Get-NetTCPConnection -LocalPort $CanonicalPort -State Listen -ErrorAction SilentlyContinue
    if ($c) {
        ($c | ForEach-Object {
            $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
            "{0} pid {1} ({2})" -f $_.LocalAddress, $_.OwningProcess, $(if ($p) { $p.ProcessName } else { '?' })
        }) -join '; '
    } else { 'none -- port is free' }
}
Try-Item 'excluded port ranges (TCP)' {
    $out = & netsh int ipv4 show excludedportrange protocol=tcp 2>&1 | Out-String
    $hit = $out -split "`r?`n" | Where-Object { $_ -match '^\s*\d+\s+\d+' } | ForEach-Object {
        $n = ($_ -split '\s+') | Where-Object { $_ -ne '' }
        if ([int]$n[0] -le $CanonicalPort -and [int]$n[1] -ge $CanonicalPort) { "$($n[0])-$($n[1]) INCLUDES $CanonicalPort" }
    }
    if ($hit) { ($hit -join '; ') } else { "no excluded range covers $CanonicalPort" }
}

# The decisive test for Candidate B: can an ordinary user bind a raw loopback socket on this port?
Section '8. Candidate B -- raw TcpListener bind (no admin expected)'
$tcpVerdict = 'not attempted'
try {
    $addr = [System.Net.IPAddress]::Parse($CanonicalHost)
    $listener = New-Object System.Net.Sockets.TcpListener($addr, $CanonicalPort)
    $listener.Start()
    $ep = $listener.LocalEndpoint.ToString()
    $listener.Stop()
    $tcpVerdict = "SUCCESS -- bound $ep as an ordinary user, then released it"
} catch {
    $tcpVerdict = "FAILED -- $($_.Exception.Message)"
}
Item 'TcpListener 127.0.0.1:8765' $tcpVerdict
Emit ''
Emit '  This is the load-bearing measurement for a PowerShell socket server. A success here means a'
Emit '  non-admin user-space server is possible on this machine; a failure is a genuine finding and'
Emit '  must not be worked around by asking for administrator rights.'

# The decisive test for Candidate A: http.sys needs a URL ACL for non-admin prefixes.
Section '9. Candidate A -- HttpListener prefix registration (expected to need a URL ACL)'
$httpVerdict = 'not attempted'
try {
    $hl = New-Object System.Net.HttpListener
    $hl.Prefixes.Add("http://$CanonicalHost`:$CanonicalPort/")
    $hl.Start()
    $hl.Stop()
    $hl.Close()
    $httpVerdict = 'SUCCESS -- http.sys accepted the prefix without elevation'
} catch {
    $httpVerdict = "FAILED -- $($_.Exception.Message)"
}
Item 'HttpListener 127.0.0.1:8765' $httpVerdict
Emit ''
Emit '  Both outcomes are real measurements, neither is a probe error. http.sys requires a URL ACL for'
Emit '  wildcard prefixes (+, *, a hostname) but generally permits a literal 127.0.0.1 prefix without'
Emit '  one; it succeeded un-elevated on the development workstation. If it is DENIED here while'
Emit '  section 8 succeeds, that is a finding about this machine and Candidate A is out for it.'
Try-Item 'existing URL ACLs mentioning 8765' {
    $out = & netsh http show urlacl 2>&1 | Out-String
    if ($out -match "8765") { 'an ACL referencing 8765 exists (see netsh http show urlacl)' }
    else { 'none' }
}

# ---------------------------------------------------------------- 10. shortcut feasibility
Section '10. Shortcut and pointer feasibility (no file is created outside TEMP)'
Try-Item 'WScript.Shell available' {
    $null = New-Object -ComObject WScript.Shell
    'yes (Start Menu shortcut creation is possible)'
}
Try-Item 'directory junction without elevation' {
    $base = Join-Path $env:TEMP ("civic-probe-{0}" -f ([guid]::NewGuid().ToString('N')))
    $target = Join-Path $base 'target'
    $link = Join-Path $base 'link'
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    $r = & cmd.exe /c mklink /J "`"$link`"" "`"$target`"" 2>&1 | Out-String
    $ok = Test-Path -LiteralPath $link
    Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue
    if ($ok) { 'yes -- junctions work without elevation' } else { "no -- $($r.Trim())" }
}
Try-Item 'Developer Mode (symlinks w/o admin)' {
    $k = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock'
    $v = (Get-ItemProperty -Path $k -ErrorAction Stop).AllowDevelopmentWithoutDevLicense
    if ($v -eq 1) { 'enabled' } else { 'disabled' }
}

# ---------------------------------------------------------------- done
Section 'END'
Emit ''
Emit 'Nothing was installed, started or left running. Both bind tests released their sockets.'
Emit ''

Set-Content -LiteralPath $report -Value ($script:Lines -join "`r`n") -Encoding UTF8
Write-Host ''
Write-Host "Report written to:"
Write-Host "    $report"
Write-Host ''
Write-Host 'Please return that file. Review it first if you wish -- it contains no browser data and no'
Write-Host 'document contents, only machine and software facts.'
