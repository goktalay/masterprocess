#requires -Version 7
<#
  mp-agent oturum sınaması.
  Yardımcıyı sunucu kipinde başlatır, stdin'e gerçek komut dizisi yazar ve her yanıtı
  docs/agent-protocol.md sözleşmesine göre doğrular. Her ham yanıtın ilk 600 karakteri günlüğe yazılır.
  Çıkış kodu: 0 = hepsi geçti, 1 = en az bir doğrulama başarısız.
#>
param(
    [string]$Agent = 'agent-out\mp-agent.exe'
)

$ErrorActionPreference = 'Stop'
$script:Fails = [System.Collections.Generic.List[string]]::new()
$script:Warns = [System.Collections.Generic.List[string]]::new()
$script:Skipped = [System.Collections.Generic.List[string]]::new()
$script:NextId = 1
$script:StepName = 'init'
$script:Responses = 0
$utf8 = [System.Text.UTF8Encoding]::new($false)

function Fail([string]$m) { $script:Fails.Add("[$script:StepName] $m"); Write-Host "FAIL [$script:StepName] $m" }
function Warn([string]$m) { $script:Warns.Add("[$script:StepName] $m"); Write-Host "WARN [$script:StepName] $m" }
function Assert($cond, [string]$m) { if (-not $cond) { Fail $m } }
function Short([string]$s, [int]$n = 600) { if ($s.Length -le $n) { return $s } return $s.Substring(0, $n) + " ...(+$($s.Length - $n) chars)" }
function ToJson($v) { return (ConvertTo-Json -InputObject $v -Compress -Depth 8) }

function Step([string]$name, [scriptblock]$body) {
    $script:StepName = $name
    Write-Host ''
    Write-Host "=== $name ==="
    try { & $body }
    catch { Fail ("exception: " + $_.Exception.Message + " (line " + $_.InvocationInfo.ScriptLineNumber + ")") }
}

# Bir satır yazar, bir satır yanıt okur. Yanıt tek satır olmalıdır.
function Send-Line([string]$line, [string]$label, [switch]$Quiet, [int]$TimeoutMs = 60000) {
    $bytes = $utf8.GetBytes($line + "`n")
    $script:AgentIn.Write($bytes, 0, $bytes.Length)
    $script:AgentIn.Flush()
    $task = $script:AgentOut.ReadLineAsync()
    if (-not $task.Wait($TimeoutMs)) { throw "timeout ($TimeoutMs ms) waiting for the response to: $label" }
    $raw = $task.Result
    if ($null -eq $raw) { throw "agent closed stdout while waiting for: $label" }
    $script:Responses++
    if (-not $Quiet) {
        Write-Host (">>> " + (Short $line 300))
        Write-Host ("<<< [$label] " + (Short $raw))
    }
    return $raw
}

function Parse([string]$raw, [string]$label) {
    try { return ($raw | ConvertFrom-Json -Depth 32) }
    catch { throw "response to '$label' is not valid JSON: $($_.Exception.Message)" }
}

# body: "id" dışındaki alanlar (süslü parantezsiz), ör. '"cmd":"detail","pid":12'
function Call([string]$body, [string]$label, [switch]$Quiet) {
    $id = $script:NextId++
    $line = '{"id":' + $id + ',' + $body + '}'
    $raw = Send-Line $line $label -Quiet:$Quiet
    $o = Parse $raw $label
    if ($o.id -ne $id) { Fail "id mismatch for '$label': sent $id, got $($o.id)" }
    if ($o.ok -isnot [bool]) { Fail "'ok' is not a boolean in the response to '$label'" }
    if ($o.ok -eq $false -and ([string]::IsNullOrEmpty($o.err) -or [string]::IsNullOrEmpty($o.msg))) { Fail "error response without err/msg for '$label'" }
    return $o
}

function OsPriority([int]$id) {
    $map = @{ Idle = 'idle'; BelowNormal = 'below'; Normal = 'normal'; AboveNormal = 'above'; High = 'high'; RealTime = 'realtime' }
    $p = Get-Process -Id $id
    $p.Refresh()
    return $map[[string]$p.PriorityClass]
}

function ExpectOk($o, [string]$label) {
    if (-not $o.ok) { Fail "${label}: expected ok, got err=$($o.err) msg=$($o.msg)"; return $false }
    return $true
}
function ExpectErr($o, [string]$code, [string]$label) {
    if ($o.ok) { Fail "${label}: expected error '$code', got ok" }
    elseif ($o.err -ne $code) { Fail "${label}: expected error '$code', got '$($o.err)' ($($o.msg))" }
}

# ---------------------------------------------------------------- hazırlık
$agentPath = (Resolve-Path -LiteralPath $Agent).Path
$tmpRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$tmpDir = Join-Path $tmpRoot ('mpagent-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmpDir | Out-Null
Write-Host "agent: $agentPath"
Write-Host "temp:  $tmpDir"
Write-Host ("os:    " + [Environment]::OSVersion.VersionString + "  session=" + [Diagnostics.Process]::GetCurrentProcess().SessionId + "  interactive=" + [Environment]::UserInteractive)

$psi = [System.Diagnostics.ProcessStartInfo]::new($agentPath)
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $false
$psi.StandardOutputEncoding = $utf8
$psi.StandardInputEncoding = $utf8
$agentProc = [System.Diagnostics.Process]::Start($psi)
$script:AgentIn = $agentProc.StandardInput.BaseStream
$script:AgentOut = $agentProc.StandardOutput
$script:Target = $null     # @{ Pid; Name; Window }
$script:Holder = $null
$script:Hwnd = $null
$script:ModBase = $null

try {
    # ------------------------------------------------------------ hello
    Step 'hello' {
        $r = Call '"cmd":"hello"' 'hello'
        if (ExpectOk $r 'hello') {
            $d = $r.data
            Assert ($d.protocol -eq 1) "protocol = $($d.protocol)"
            Assert ($d.agent -is [string] -and $d.agent.Length -gt 0) 'agent version missing'
            Assert ($d.pid -eq $agentProc.Id) "pid $($d.pid) != started process $($agentProc.Id)"
            Assert ($d.arch -eq 'x64') "arch = $($d.arch)"
            Assert ($d.cpuCount -ge 1) 'cpuCount'
            Assert ($d.pageSize -ge 4096) 'pageSize'
            Assert ($d.totalPhys -gt 0) 'totalPhys'
            Assert ($d.elevated -is [bool] -and $d.debugPrivilege -is [bool] -and $d.gpuCounters -is [bool]) 'boolean fields'
            Assert ($d.os -match '^\d+\.\d+\.\d+$') "os = $($d.os)"
            Assert ($null -ne $d.PSObject.Properties['gpus']) 'gpus missing'
            $script:GpuCounters = [bool]$d.gpuCounters
            Write-Host ("EXTRACT hello gpus=" + @($d.gpus).Count + " gpuCounters=" + $d.gpuCounters + " elevated=" + $d.elevated + " debugPrivilege=" + $d.debugPrivilege)
        }
    }

    # ------------------------------------------------------------ hedef süreç
    Step 'target' {
        foreach ($name in @('notepad.exe', 'mspaint.exe', 'charmap.exe')) {
            $p = $null
            try { $p = Start-Process -FilePath $name -PassThru }
            catch { Warn "cannot start ${name}: $($_.Exception.Message)"; continue }
            $base = [IO.Path]::GetFileNameWithoutExtension($name)
            $deadline = (Get-Date).AddSeconds(20)
            $found = $null
            while ((Get-Date) -lt $deadline -and $null -eq $found) {
                Start-Sleep -Milliseconds 500
                $cands = @($p.Id)
                if ($p.HasExited) { $cands = @(Get-Process -Name $base -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) }
                foreach ($c in $cands) {
                    $d = Call ('"cmd":"detail","pid":{0}' -f $c) "detail(wait window $name)" -Quiet
                    if (-not $d.ok) { continue }
                    foreach ($w in @($d.data.windows)) {
                        if ($w.visible -and -not $w.minimized -and $w.rect[2] -gt 0 -and $w.rect[3] -gt 0) { $found = @{ Pid = [int]$c; Name = $name; Window = $true }; break }
                    }
                    if ($found) { break }
                }
            }
            if ($found) {
                $found.Direct = ($found.Pid -eq $p.Id)
                if ($script:Target) { try { Stop-Process -Id $script:Target.Pid -Force } catch { } }
                $script:Target = $found
                break
            }
            Warn "$name did not show a top-level window within 20 s"
            if ($null -eq $script:Target -and -not $p.HasExited) { $script:Target = @{ Pid = $p.Id; Name = $name; Window = $false; Direct = $true } }
            elseif (-not $p.HasExited) { try { Stop-Process -Id $p.Id -Force } catch { } }
        }
        if ($null -eq $script:Target) { throw 'no target process could be started' }
        if (-not $script:Target.Window) { Warn 'no target window: window/capture checks will be skipped'; $script:Skipped.Add('detail.windows'); $script:Skipped.Add('capture') }
        Write-Host ("target: " + $script:Target.Name + " pid=" + $script:Target.Pid + " window=" + $script:Target.Window)

        # tanıtıcı sınaması için: bir dosyayı okuma erişimiyle açık tutan çocuk süreç
        $script:HeldFile = Join-Path $tmpDir ('held-' + [guid]::NewGuid().ToString('N') + '.bin')
        [IO.File]::WriteAllBytes($script:HeldFile, [byte[]](1..200))
        $ready = Join-Path $tmpDir 'holder.ready'
        $cmd = "`$f=[IO.File]::Open('$($script:HeldFile)','Open','Read','ReadWrite'); [IO.File]::WriteAllText('$ready','ok'); Start-Sleep -Seconds 600"
        $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))
        $script:Holder = Start-Process -FilePath 'pwsh' -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $enc) -PassThru -WindowStyle Hidden
        $deadline = (Get-Date).AddSeconds(30)
        while (-not (Test-Path -LiteralPath $ready) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
        Assert (Test-Path -LiteralPath $ready) 'holder process did not open the file in time'
        Write-Host ("holder: pid=" + $script:Holder.Id + " file=" + $script:HeldFile)
    }
    $tpid = if ($script:Target) { $script:Target.Pid } else { 0 }

    # ------------------------------------------------------------ snapshot x2
    Step 'snapshot' {
        $expectCols = @('pid', 'ppid', 'name', 'cpu', 'ws', 'priv', 'ioRead', 'ioWrite', 'gpu', 'gpuDed', 'gpuShr', 'threads', 'handles', 'start', 'session')
        $r1 = Call '"cmd":"snapshot"' 'snapshot #1'
        [void](ExpectOk $r1 'snapshot #1')
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $x = 0.0
        while ($sw.ElapsedMilliseconds -lt 400) { for ($i = 1; $i -lt 2000; $i++) { $x += [Math]::Sqrt($i) } }
        Start-Sleep -Milliseconds 800
        $r2 = Call '"cmd":"snapshot"' 'snapshot #2'
        if (ExpectOk $r2 'snapshot #2') {
            $d = $r2.data
            Assert ((@($d.cols) -join ',') -ceq ($expectCols -join ',')) ("cols = " + (@($d.cols) -join ','))
            Assert ([Math]::Abs([long]$d.t - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) -lt 10000) 't is not epoch ms'
            foreach ($k in 'cpu', 'memTotal', 'memAvail', 'commitTotal', 'commitLimit', 'ioRead', 'ioWrite', 'gpu', 'gpuDedicated', 'gpuShared') {
                Assert ($null -ne $d.sys.PSObject.Properties[$k]) "sys.$k missing"
            }
            Assert ($d.sys.memTotal -gt 0 -and $d.sys.memAvail -gt 0 -and $d.sys.commitLimit -gt 0) 'sys memory values'
            $rows = @($d.procs)
            $pids = [System.Collections.Generic.HashSet[long]]::new()
            $anyCpu = $false; $maxCpu = 0.0; $badLen = 0; $agentRow = $null; $targetRow = $null; $selfRow = $null
            foreach ($row in $rows) {
                if (@($row).Count -ne 15) { $badLen++; continue }
                [void]$pids.Add([long]$row[0])
                if ($row[3] -gt 0) { $anyCpu = $true }
                if ($row[3] -gt $maxCpu) { $maxCpu = [double]$row[3] }
                if ($row[0] -eq $agentProc.Id) { $agentRow = $row }
                if ($row[0] -eq $tpid) { $targetRow = $row }
                if ($row[0] -eq $PID) { $selfRow = $row }
            }
            Assert ($badLen -eq 0) "$badLen rows do not have 15 columns"
            Assert ($rows.Count -gt 10) "only $($rows.Count) processes"
            Assert ($pids.Count -eq $rows.Count) 'duplicate pids'
            Assert (-not $pids.Contains(0)) 'pid 0 is listed'
            Assert ($null -ne $agentRow) 'agent pid is not listed'
            Assert ($null -ne $selfRow) 'test script pid is not listed'
            Assert ($null -ne $targetRow) 'target pid is not listed'
            Assert ($pids.Contains(4)) 'System (pid 4) is not listed'
            Assert ($anyCpu -or $d.sys.cpu -gt 0) 'no cpu > 0 in the second snapshot'
            Assert ($maxCpu -le 100 -and $d.sys.cpu -le 100) 'cpu above 100'
            if ($agentRow) { Assert ($agentRow[2] -eq 'mp-agent.exe') "agent row name = $($agentRow[2])"; Assert ($agentRow[1] -eq $PID) "agent ppid $($agentRow[1]) != script pid $PID" }
            if ($selfRow) { Assert ($selfRow[3] -gt 0) 'script burned cpu but its rate is 0'; Assert ($selfRow[4] -gt 1MB -and $selfRow[11] -gt 1 -and $selfRow[12] -gt 10) 'script row ws/threads/handles look wrong' }
            if ($targetRow) { Assert ($targetRow[2] -eq $script:Target.Name) "target row name = $($targetRow[2])" }
            Write-Host ("EXTRACT snapshot procs=" + $rows.Count + " anyCpu=" + $anyCpu + " maxCpu=" + $maxCpu + " sys=" + (ToJson $d.sys))
            Write-Host ("EXTRACT snapshot row0 " + (ToJson $rows[0]))
            Write-Host ("EXTRACT snapshot row1 " + (ToJson $rows[1]))
            Write-Host ("EXTRACT snapshot agent " + (ToJson $agentRow))
            Write-Host ("EXTRACT snapshot script " + (ToJson $selfRow))
            Write-Host ("EXTRACT snapshot target " + (ToJson $targetRow))
        }
    }

    # ------------------------------------------------------------ detail
    Step 'detail' {
        $r = Call ('"cmd":"detail","pid":{0}' -f $tpid) 'detail'
        if (ExpectOk $r 'detail') {
            $d = $r.data
            Assert ($d.pid -eq $tpid) 'pid'
            Assert ($d.name -eq $script:Target.Name) "name = $($d.name)"
            Assert ($d.path -is [string] -and $d.path.Length -gt 3 -and $d.path -match '^[A-Za-z]:\\') "path = $($d.path)"
            Assert ($d.cmdline -is [string] -and $d.cmdline.Length -gt 0) 'cmdline empty'
            Assert ($d.user -is [string] -and $d.user.Length -gt 0) 'user empty'
            Assert ($d.arch -eq 'x64') "arch = $($d.arch)"
            # CI koşucusu işleri BelowNormal ile başlatır ve çocuk süreçler bunu miras alır: beklenen değer işletim sisteminden okunur
            $osPrio = OsPriority $tpid
            Assert ($d.priority -eq $osPrio) "priority = $($d.priority), OS reports $osPrio"
            Assert ($d.suspended -eq $false) 'suspended should be false'
            if ($script:Target.Direct) { Assert ($d.ppid -eq $PID) "ppid $($d.ppid) != script pid $PID" }
            Assert ($d.start -gt 1500000000000) 'start'
            Assert (@($d.threads).Count -gt 0) 'threads empty'
            foreach ($k in 'handles', 'gdi', 'user', 'pageFaults', 'peakWs', 'ws', 'priv', 'virt', 'ioReadOps', 'ioWriteOps', 'ioOtherOps', 'ioReadBytes', 'ioWriteBytes', 'ioOtherBytes', 'kernelMs', 'userMs') {
                Assert ($null -ne $d.counters.PSObject.Properties[$k]) "counters.$k missing"
            }
            Assert ($d.counters.ws -gt 0 -and $d.counters.handles -gt 0) 'counters ws/handles'
            Assert ($null -ne $d.file -and $d.file.size -gt 0) 'file info missing'
            if ($script:Target.Window) {
                $wins = @($d.windows)
                Assert ($wins.Count -gt 0) 'windows empty'
                Assert ($d.counters.user -gt 0) 'USER object count is 0 for a process with a window'
                foreach ($w in $wins) {
                    if ($null -eq $script:Hwnd -and $w.visible -and -not $w.minimized -and $w.rect[2] -gt 0 -and $w.title.Length -gt 0) { $script:Hwnd = $w.hwnd; $script:WinRect = $w.rect }
                }
                Assert ($null -ne $script:Hwnd) 'no visible titled window'
                Assert ($script:Hwnd -cmatch '^[0-9a-f]+$') "hwnd format: $($script:Hwnd)"
            }
            Write-Host ("EXTRACT detail windows=" + (ToJson @($d.windows)) + " file=" + (ToJson $d.file) + " threads=" + @($d.threads).Count + " thread0=" + (ToJson @($d.threads)[0]))
        }
    }

    # ------------------------------------------------------------ modules
    Step 'modules' {
        $r = Call ('"cmd":"modules","pid":{0}' -f $tpid) 'modules'
        if (ExpectOk $r 'modules') {
            $m = @($r.data.modules)
            Assert ($m.Count -gt 0) 'no modules'
            if ($m.Count -gt 0) {
                $script:ModBase = $m[0].base
                Assert ($script:ModBase -cmatch '^[0-9a-f]+$') "base format: $($script:ModBase)"
                Assert ($m[0].size -gt 0) 'module size'
                Assert ($m[0].path -like "*$($script:Target.Name)") "first module path = $($m[0].path)"
                $ntdll = @($m | Where-Object { $_.path -like '*\ntdll.dll' })
                Assert ($ntdll.Count -gt 0) 'ntdll.dll is not in the module list'
            }
            Write-Host ("EXTRACT modules count=" + $m.Count)
        }
    }

    # ------------------------------------------------------------ memmap
    Step 'memmap' {
        $r = Call ('"cmd":"memmap","pid":{0}' -f $tpid) 'memmap'
        if (ExpectOk $r 'memmap') {
            $d = $r.data
            Assert ((@($d.cols) -join ',') -ceq 'base,size,state,protect,type,wsPages,name') ("cols = " + (@($d.cols) -join ','))
            Assert ($d.pageSize -ge 4096) 'pageSize'
            $regs = @($d.regions)
            $named = 0; $wsRegions = 0; $bad = 0; $exeNamed = $false
            foreach ($g in $regs) {
                if (@($g).Count -ne 7) { $bad++; continue }
                if ($g[4] -eq 3 -and $g[6].Length -gt 0) { $named++; if ($g[6] -like "*$($script:Target.Name)") { $exeNamed = $true } }
                if ($g[5] -gt 0) { $wsRegions++ }
            }
            Assert ($bad -eq 0) "$bad region rows do not have 7 columns"
            Assert ($regs.Count -gt 10) "only $($regs.Count) regions"
            Assert ($d.totals.commit -gt 0) 'totals.commit'
            Assert ($d.totals.ws -gt 0) 'totals.ws'
            Assert ($named -gt 0) 'no image region has a name'
            Assert ($exeNamed) 'the target exe image region is not named with its path'
            Assert ($wsRegions -gt 0) 'no region has working-set pages'
            Write-Host ("EXTRACT memmap regions=" + $regs.Count + " namedImage=" + $named + " wsRegions=" + $wsRegions + " min=" + $d.min + " max=" + $d.max + " truncated=" + $d.truncated)
            Write-Host ("EXTRACT memmap first3 " + (ToJson @($regs[0], $regs[1], $regs[2])))
            $img = @($regs | Where-Object { $_[4] -eq 3 -and $_[6].Length -gt 0 } | Select-Object -First 2)
            Write-Host ("EXTRACT memmap image " + (ToJson $img))
            Write-Host ("EXTRACT memmap totals " + (ToJson $d.totals))
        }
    }

    # ------------------------------------------------------------ readmem
    Step 'readmem' {
        if (-not $script:ModBase) { throw 'no module base (modules failed)' }
        $r = Call ('"cmd":"readmem","pid":{0},"addr":"{1}","len":2' -f $tpid, $script:ModBase) 'readmem'
        if (ExpectOk $r 'readmem') {
            Assert ($r.data.len -eq 2) "len = $($r.data.len)"
            Assert ($r.data.addr -eq $script:ModBase) 'addr echo'
            $b = [Convert]::FromBase64String($r.data.b64)
            Assert ($b.Length -eq 2 -and $b[0] -eq 0x4D -and $b[1] -eq 0x5A) "bytes are not 'MZ' (b64=$($r.data.b64))"
        }
    }

    # ------------------------------------------------------------ handles
    Step 'handles' {
        $r = Call ('"cmd":"handles","pid":{0}' -f $tpid) 'handles(target)'
        if (ExpectOk $r 'handles(target)') {
            $names = @($r.data.counts.PSObject.Properties | ForEach-Object { $_.Name })
            Assert ($names.Count -gt 0) 'counts empty'
            Assert ($names -contains 'File') 'counts has no File entry'
            Assert (($names -contains 'Event') -or ($names -contains 'Key') -or ($names -contains 'Thread')) 'counts has no well-known type names'
            Write-Host ("EXTRACT handles(target) counts=" + (ToJson $r.data.counts) + " files=" + @($r.data.files).Count + " truncated=" + $r.data.truncated)
        }
        $h = Call ('"cmd":"handles","pid":{0}' -f $script:Holder.Id) 'handles(holder)'
        if (ExpectOk $h 'handles(holder)') {
            $leaf = [IO.Path]::GetFileName($script:HeldFile)
            $hit = $null
            foreach ($f in @($h.data.files)) { if ($f.path -like "*\$leaf") { $hit = $f } }
            Assert ($null -ne $hit) "the file held open by the child process is not in files ($leaf)"
            if ($hit) {
                Assert ($hit.kind -eq 'file') "kind = $($hit.kind)"
                Assert ($hit.size -eq 200) "size = $($hit.size)"
                Assert ($hit.h -cmatch '^[0-9a-f]+$') "h format: $($hit.h)"
                Assert ($hit.path -ieq $script:HeldFile) "path '$($hit.path)' != '$($script:HeldFile)'"
                Write-Host ("EXTRACT handles(holder) hit " + (ToJson $hit))
            }
            $dirs = @(@($h.data.files) | Where-Object { $_.kind -eq 'dir' })
            Assert ($dirs.Count -gt 0) "no directory handle is reported as kind 'dir' (the current directory is always open)"
            foreach ($f in @($h.data.files)) {
                $isDir = Test-Path -LiteralPath $f.path -PathType Container
                if ($f.kind -eq 'dir') { Assert ($isDir) "'$($f.path)' is reported as dir but is not a directory"; Assert ($f.size -eq 0) "dir size = $($f.size)" }
                elseif ($isDir) { Fail "'$($f.path)' is a directory but is reported as file" }
            }
            Write-Host ("EXTRACT handles(holder) dirs=" + (ToJson @($dirs | Select-Object -First 2)))
            Write-Host ("EXTRACT handles(holder) counts=" + (ToJson $h.data.counts) + " files=" + @($h.data.files).Count + " first3=" + (ToJson @(@($h.data.files) | Select-Object -First 3)))
        }
    }

    # ------------------------------------------------------------ filemap / readfile
    Step 'filemap' {
        $script:BigFile = Join-Path $tmpDir 'extent-test.bin'
        $script:BigBuf = [byte[]]::new(5MB)
        [Random]::new(42).NextBytes($script:BigBuf)
        for ($i = 0; $i -lt 4096; $i++) { $script:BigBuf[$i] = [byte]($i % 251) }
        $fs = [IO.FileStream]::new($script:BigFile, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $fs.Write($script:BigBuf, 0, $script:BigBuf.Length); $fs.Flush($true) } finally { $fs.Dispose() }
        $r = Call ('"cmd":"filemap","path":{0}' -f (ToJson $script:BigFile)) 'filemap'
        if (ExpectOk $r 'filemap') {
            $d = $r.data
            $ext = @($d.extents)
            Assert ($d.clusterSize -gt 0) 'clusterSize'
            Assert ($d.totalClusters -gt 0 -and $d.freeClusters -ge 0) 'totalClusters/freeClusters'
            Assert ($d.size -eq 5MB) "size = $($d.size)"
            Assert ($ext.Count -gt 0) 'extents empty'
            Assert ($d.resident -eq $false) 'resident should be false'
            Assert ($d.fragments -ge 1 -and $d.fragments -le [Math]::Max(1, $ext.Count)) "fragments = $($d.fragments)"
            Assert ($d.volume -is [string] -and $d.volume.EndsWith('\')) "volume = $($d.volume)"
            $clusters = 0
            foreach ($e in $ext) { $clusters += [long]$e[1]; if ($e[0] -lt 0 -or $e[1] -le 0) { Fail "bad extent $(ToJson $e)" } }
            if ($d.clusterSize -gt 0) { Assert ($clusters * $d.clusterSize -ge 5MB -and $clusters * $d.clusterSize -lt 5MB + 64 * $d.clusterSize) "extent clusters ($clusters) do not match the file size" }
            Write-Host ("EXTRACT filemap extents=" + $ext.Count + " clusters=" + $clusters + " fragments=" + $d.fragments)
        }
    }

    Step 'readfile' {
        $r = Call ('"cmd":"readfile","path":{0},"offset":1000,"len":256' -f (ToJson $script:BigFile)) 'readfile'
        if (ExpectOk $r 'readfile') {
            Assert ($r.data.offset -eq 1000 -and $r.data.len -eq 256) "offset/len = $($r.data.offset)/$($r.data.len)"
            Assert ($r.data.size -eq 5MB) "size = $($r.data.size)"
            Assert ($r.data.b64 -ceq [Convert]::ToBase64String($script:BigBuf, 1000, 256)) 'content mismatch'
        }
        $t = Call ('"cmd":"readfile","path":{0},"offset":{1},"len":4096' -f (ToJson $script:BigFile), (5MB - 100)) 'readfile(tail)'
        if (ExpectOk $t 'readfile(tail)') {
            Assert ($t.data.len -eq 100) "tail len = $($t.data.len)"
            Assert ($t.data.b64 -ceq [Convert]::ToBase64String($script:BigBuf, 5MB - 100, 100)) 'tail content mismatch'
        }
    }

    # ------------------------------------------------------------ capture
    Step 'capture' {
        if (-not $script:Hwnd) { Warn 'capture skipped: no target window'; if (-not $script:Skipped.Contains('capture')) { $script:Skipped.Add('capture') }; return }
        foreach ($variant in @('', ',"maxW":200')) {
            $label = if ($variant) { 'capture(maxW=200)' } else { 'capture' }
            $r = Call ('"cmd":"capture","hwnd":"{0}"{1}' -f $script:Hwnd, $variant) $label
            if (-not (ExpectOk $r $label)) { continue }
            $d = $r.data
            Assert ($d.hwnd -eq $script:Hwnd) 'hwnd echo'
            Assert ($d.format -eq 'bgra') "format = $($d.format)"
            Assert ($d.minimized -eq $false) 'minimized'
            Assert ($d.srcW -gt 0 -and $d.srcH -gt 0) "srcW/srcH = $($d.srcW)x$($d.srcH)"
            Assert ($d.w -gt 0 -and $d.h -gt 0) "w/h = $($d.w)x$($d.h)"
            Assert ($d.srcW -eq $script:WinRect[2] -and $d.srcH -eq $script:WinRect[3]) "src size $($d.srcW)x$($d.srcH) != window rect $($script:WinRect[2])x$($script:WinRect[3])"
            if ($variant) { Assert ($d.w -le 200) "w = $($d.w) with maxW 200"; if ($d.srcW -gt 200) { Assert ($d.w -eq 200 -and [Math]::Abs($d.h - $d.srcH * 200.0 / $d.srcW) -le 1) "scaled size $($d.w)x$($d.h)" } }
            else { Assert ($d.w -eq $d.srcW -and $d.h -eq $d.srcH) 'unscaled size differs from the source size' }
            $rawBytes = [long]$d.w * $d.h * 4
            $expectLen = 4 * [long][Math]::Ceiling($rawBytes / 3.0)
            Assert ($d.b64.Length -eq $expectLen) "b64 length $($d.b64.Length) != $expectLen (for $rawBytes bytes)"
            $px = [Convert]::FromBase64String($d.b64)
            Assert ($px.Length -eq $rawBytes) "decoded $($px.Length) bytes, expected $rawBytes"
            # örneklemeyle içerik özeti (bilgi amaçlı): alfa ve renk çeşitliliği
            $colors = [System.Collections.Generic.HashSet[int]]::new(); $alphaBad = 0; $n = 0
            for ($i = 0; $i + 3 -lt $px.Length; $i += 4 * 211) { $n++; [void]$colors.Add(($px[$i] -shl 16) -bor ($px[$i + 1] -shl 8) -bor $px[$i + 2]); if ($px[$i + 3] -ne 255) { $alphaBad++ } }
            Assert ($alphaBad -eq 0) "$alphaBad sampled pixels have alpha != 255"
            if ($colors.Count -le 1) { Warn "${label}: the image is a single colour (window content was not rendered)" }
            Write-Host ("EXTRACT $label title=" + (ToJson $d.title) + " src=" + $d.srcW + "x" + $d.srcH + " out=" + $d.w + "x" + $d.h + " b64len=" + $d.b64.Length + " sampled=" + $n + " distinctColours=" + $colors.Count)
        }
    }

    # ------------------------------------------------------------ gpudetail
    Step 'gpudetail' {
        $r = Call ('"cmd":"gpudetail","pid":{0}' -f $tpid) 'gpudetail'
        if ($r.ok) {
            Assert ($null -ne $r.data.PSObject.Properties['engines'] -and $null -ne $r.data.PSObject.Properties['mem']) 'engines/mem missing'
            Assert ($script:GpuCounters) 'gpudetail answered ok although hello.gpuCounters is false'
            Write-Host ("EXTRACT gpudetail ok engines=" + @($r.data.engines).Count + " mem=" + @($r.data.mem).Count)
        }
        else {
            ExpectErr $r 'unsupported' 'gpudetail'
            Assert (-not $script:GpuCounters) 'gpudetail is unsupported although hello.gpuCounters is true'
            Write-Host 'EXTRACT gpudetail unsupported (no GPU counters on this machine)'
        }
    }

    # ------------------------------------------------------------ priority
    Step 'priority' {
        Write-Host ("initial priority (OS): " + (OsPriority $tpid))
        foreach ($v in @('high', 'below', 'normal')) {
            $r = Call ('"cmd":"priority","pid":{0},"value":"{1}"' -f $tpid, $v) "priority($v)"
            if (ExpectOk $r "priority($v)") { Assert ($r.data.done -eq $true) 'done' }
            $d = Call ('"cmd":"detail","pid":{0}' -f $tpid) "detail(after $v)" -Quiet
            Assert ($d.ok -and $d.data.priority -eq $v) "detail.priority after '$v' = $($d.data.priority)"
            Assert ((OsPriority $tpid) -eq $v) "OS reports $(OsPriority $tpid) after '$v'"
            Write-Host "EXTRACT priority set=$v detail=$($d.data.priority) os=$(OsPriority $tpid)"
        }
        ExpectErr (Call ('"cmd":"priority","pid":{0},"value":"realtime"' -f $tpid) 'priority(realtime)') 'bad_request' 'priority(realtime)'
        ExpectErr (Call ('"cmd":"priority","pid":{0},"value":"turbo"' -f $tpid) 'priority(unknown value)') 'bad_request' 'priority(unknown value)'
    }

    # ------------------------------------------------------------ suspend / resume
    Step 'suspend' {
        $r = Call ('"cmd":"suspend","pid":{0}' -f $tpid) 'suspend'
        if (ExpectOk $r 'suspend') { Assert ($r.data.done -eq $true) 'done' }
        $susp = $false; $tries = 0
        while (-not $susp -and $tries -lt 15) {
            $tries++
            $d = Call ('"cmd":"detail","pid":{0}' -f $tpid) 'detail(suspended?)' -Quiet:($tries -gt 1)
            if ($d.ok -and $d.data.suspended -eq $true) { $susp = $true } else { Start-Sleep -Milliseconds 200 }
        }
        Assert ($susp) 'detail.suspended is not true after suspend'
        Write-Host "EXTRACT suspend suspended=$susp after $tries detail call(s)"
        $r = Call ('"cmd":"resume","pid":{0}' -f $tpid) 'resume'
        if (ExpectOk $r 'resume') { Assert ($r.data.done -eq $true) 'done' }
        $resumed = $false; $tries = 0
        while (-not $resumed -and $tries -lt 15) {
            $tries++
            $d = Call ('"cmd":"detail","pid":{0}' -f $tpid) 'detail(resumed?)' -Quiet:($tries -gt 1)
            if ($d.ok -and $d.data.suspended -eq $false) { $resumed = $true } else { Start-Sleep -Milliseconds 200 }
        }
        Assert ($resumed) 'detail.suspended is still true after resume'
    }

    # ------------------------------------------------------------ hata yolları
    Step 'errors' {
        ExpectErr (Call '"cmd":"frobnicate"' 'unknown command') 'bad_request' 'unknown command'
        ExpectErr (Call '"cmd":"detail","pid":4294967280' 'detail(missing pid)') 'gone' 'detail(missing pid)'
        ExpectErr (Call '"cmd":"modules","pid":4294967280' 'modules(missing pid)') 'gone' 'modules(missing pid)'
        ExpectErr (Call '"cmd":"kill","pid":4294967280' 'kill(missing pid)') 'gone' 'kill(missing pid)'
        ExpectErr (Call '"cmd":"kill","pid":4' 'kill(pid 4)') 'bad_request' 'kill(pid 4)'
        ExpectErr (Call '"cmd":"kill","pid":0' 'kill(pid 0)') 'bad_request' 'kill(pid 0)'
        ExpectErr (Call ('"cmd":"kill","pid":{0}' -f $agentProc.Id) 'kill(agent itself)') 'bad_request' 'kill(agent itself)'
        ExpectErr (Call ('"cmd":"suspend","pid":{0}' -f $agentProc.Id) 'suspend(agent itself)') 'bad_request' 'suspend(agent itself)'
        ExpectErr (Call '"cmd":"detail"' 'detail(no pid)') 'bad_request' 'detail(no pid)'
        ExpectErr (Call '"cmd":"capture","hwnd":"7ffffff0"' 'capture(bad hwnd)') 'gone' 'capture(bad hwnd)'
        ExpectErr (Call ('"cmd":"readmem","pid":{0},"addr":"10","len":99999' -f $tpid) 'readmem(len too large)') 'bad_request' 'readmem(len too large)'

        $raw = Send-Line '{"id": 77, "cmd": "hello"' 'broken JSON'
        $o = Parse $raw 'broken JSON'
        Assert ($o.id -eq 0) "broken JSON: id = $($o.id), expected 0"
        ExpectErr $o 'bad_request' 'broken JSON'
        $raw = Send-Line 'this is not json' 'not JSON at all'
        $o = Parse $raw 'not JSON at all'
        Assert ($o.id -eq 0) "not JSON: id = $($o.id), expected 0"
        ExpectErr $o 'bad_request' 'not JSON at all'

        # yardımcı hata yanıtlarından sonra da çalışmayı sürdürmeli; Türkçe/Unicode yol gidiş-dönüşü
        $uni = Join-Path $tmpDir 'çğış-ünïcode ✓.txt'
        [IO.File]::WriteAllText($uni, 'merhaba', $utf8)
        $r = Call ('"cmd":"readfile","path":{0},"offset":0,"len":64' -f (ToJson $uni)) 'readfile(unicode path)'
        if (ExpectOk $r 'readfile(unicode path)') { Assert ($r.data.b64 -ceq [Convert]::ToBase64String($utf8.GetBytes('merhaba'))) 'unicode path content mismatch' }
    }

    # ------------------------------------------------------------ kill
    Step 'kill' {
        $r = Call ('"cmd":"kill","pid":{0}' -f $tpid) 'kill'
        if (ExpectOk $r 'kill') { Assert ($r.data.done -eq $true) 'done' }
        $d = Call ('"cmd":"detail","pid":{0}' -f $tpid) 'detail(after kill)'
        ExpectErr $d 'gone' 'detail(after kill)'
        $s = Call '"cmd":"snapshot"' 'snapshot(after kill)' -Quiet
        if (ExpectOk $s 'snapshot(after kill)') {
            $still = $false
            foreach ($row in @($s.data.procs)) { if ($row[0] -eq $tpid) { $still = $true } }
            Assert (-not $still) 'killed process is still listed in snapshot'
        }
        Assert ($null -eq (Get-Process -Id $tpid -ErrorAction SilentlyContinue)) 'the OS still reports the killed process'
    }

    # ------------------------------------------------------------ kapanış
    Step 'shutdown' {
        $agentProc.StandardInput.Close()
        if (-not $agentProc.WaitForExit(5000)) { Fail 'agent did not exit within 5 s after stdin was closed' }
        else { Assert ($agentProc.ExitCode -eq 0) "agent exit code = $($agentProc.ExitCode)" }
    }
}
finally {
    foreach ($p in @($agentProc, $script:Holder)) { if ($p -and -not $p.HasExited) { try { $p.Kill() } catch { } } }
    if ($script:Target) { try { Stop-Process -Id $script:Target.Pid -Force -ErrorAction SilentlyContinue } catch { } }
    Start-Sleep -Milliseconds 300
    try { Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}

Write-Host ''
Write-Host '=== summary ==='
Write-Host "responses read: $script:Responses"
Write-Host ("skipped: " + $(if ($script:Skipped.Count) { $script:Skipped -join ', ' } else { 'none' }))
foreach ($w in $script:Warns) { Write-Host "WARN $w" }
foreach ($f in $script:Fails) { Write-Host "FAIL $f" }
if ($script:Fails.Count -gt 0) { Write-Host "SESSION TEST FAILED ($($script:Fails.Count))"; exit 1 }
Write-Host 'SESSION TEST OK'
exit 0
