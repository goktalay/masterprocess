#requires -Version 7
<#
  mp-agent ağ sınaması.
  Yardımcıyı sunucu kipinde başlatır, yakalamayı açar, BU betiğin sürecini izlemeye alır; sonra betik kendi
  ağ trafiğini üretir (şifresiz HTTP, geri döngü TCP/UDP, DNS) ve yardımcının bu trafiği doğru süreçle,
  doğru yönde ve bayt bayt aynı içerikle verdiğini doğrular. Trafiği yardımcı değil betik üretir.
  Çıkış kodu: 0 = hepsi geçti, 1 = en az bir doğrulama başarısız.
#>
param(
    [string]$Agent = 'agent-out\mp-agent.exe',
    [string]$Label = 'default',
    [switch]$NoExternal,
    # Windows Güvenlik Duvarı açıkken ve yardımcıya gelen izin kuralı yokken dışarıdan GELEN paketler ham sokete
    # ulaşmaz. Bu anahtarla dış gelen veriye ilişkin doğrulamalar hata yerine uyarı sayılır.
    [switch]$InboundOptional
)

$ErrorActionPreference = 'Stop'
$script:Fails = [System.Collections.Generic.List[string]]::new()
$script:Warns = [System.Collections.Generic.List[string]]::new()
$script:NextId = 1
$script:StepName = 'init'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$latin1 = [System.Text.Encoding]::Latin1

function Fail([string]$m) { $script:Fails.Add("[$script:StepName] $m"); Write-Host "FAIL [$script:StepName] $m" }
function Warn([string]$m) { $script:Warns.Add("[$script:StepName] $m"); Write-Host "WARN [$script:StepName] $m" }
function Assert($cond, [string]$m) { if (-not $cond) { Fail $m } }
function Short([string]$s, [int]$n = 700) { if ($s.Length -le $n) { return $s } return $s.Substring(0, $n) + " ...(+$($s.Length - $n) chars)" }

function Step([string]$name, [scriptblock]$body) {
    $script:StepName = $name
    Write-Host ''
    Write-Host "=== $name ==="
    try { & $body }
    catch { Fail ("exception: " + $_.Exception.Message + " (line " + $_.InvocationInfo.ScriptLineNumber + ")") }
}

function Call([string]$body, [string]$label, [switch]$Quiet) {
    $id = $script:NextId++
    $line = '{"id":' + $id + ',' + $body + '}'
    $bytes = $utf8.GetBytes($line + "`n")
    $script:AgentIn.Write($bytes, 0, $bytes.Length)
    $script:AgentIn.Flush()
    $task = $script:AgentOut.ReadLineAsync()
    if (-not $task.Wait(60000)) { throw "timeout waiting for the response to: $label" }
    $raw = $task.Result
    if ($null -eq $raw) { throw "agent closed stdout while waiting for: $label" }
    if (-not $Quiet) { Write-Host (">>> " + $line); Write-Host ("<<< [$label] " + (Short $raw)) }
    $o = $raw | ConvertFrom-Json -Depth 32
    if ($o.id -ne $id) { Fail "id mismatch for '$label'" }
    return $o
}

function Pattern([int]$n, [int]$seed) {
    $b = [byte[]]::new($n)
    for ($i = 0; $i -lt $n; $i++) { $b[$i] = [byte](($i * 31 + $seed + ($i -shr 8) * 7) -band 0xFF) }
    return , $b
}
function SameBytes([byte[]]$a, [byte[]]$b) {
    if ($null -eq $a -or $null -eq $b -or $a.Length -ne $b.Length) { return $false }
    return [System.Linq.Enumerable]::SequenceEqual($a, $b)
}

# Halkadaki tüm parçaları okur; akış + yön başına yükü birleştirir.
function Read-Stream {
    $streams = @{}
    $meta = @{}
    $since = 0
    $chunks = 0
    $gaps = 0
    for ($round = 0; $round -lt 200; $round++) {
        $r = Call ('"cmd":"netstream","since":{0},"max":1048576' -f $since) 'netstream' -Quiet
        if (-not $r.ok) { Fail "netstream: $($r.err) $($r.msg)"; break }
        $now = if ($null -ne $r.data.now) { [long]$r.data.now } else { 0 }
        if ($now -le 0) { Fail 'netstream: missing "now"' }
        foreach ($c in @($r.data.chunks)) {
            $chunks++
            if ($now -gt 0 -and [long]$c.t -gt $now) { Fail "chunk time $($c.t) is after now $now" }
            if ($c.pid -ne $PID) { Fail "chunk of pid $($c.pid) while watching $PID" }
            if (($c.f -band 8) -ne 0) { $gaps++ }
            $k = "$($c.flow)|$($c.dir)"
            if (-not $streams.ContainsKey($k)) {
                $streams[$k] = [System.IO.MemoryStream]::new()
                $meta[$k] = $c
            }
            if ($c.b64) { $bytes = [Convert]::FromBase64String($c.b64); $streams[$k].Write($bytes, 0, $bytes.Length) }
        }
        $since = $r.data.next
        if (-not $r.data.more) { break }
    }
    $out = @()
    foreach ($k in $streams.Keys) {
        $m = $meta[$k]
        $out += [pscustomobject]@{ Flow = $m.flow; Dir = $m.dir; Proto = $m.proto; V = $m.v; Local = $m.local; LPort = $m.lport; Remote = $m.remote; RPort = $m.rport; Bytes = $streams[$k].ToArray() }
    }
    Write-Host ("stream: chunks=$chunks gaps=$gaps streams=" + $out.Count)
    foreach ($s in ($out | Sort-Object Flow, Dir)) {
        $head = $latin1.GetString($s.Bytes, 0, [Math]::Min(48, $s.Bytes.Length)) -replace '[^\x20-\x7e]', '.'
        Write-Host ("  flow=$($s.Flow) $($s.Dir) $($s.Proto)$($s.V) $($s.Local):$($s.LPort) <-> $($s.Remote):$($s.RPort) bytes=$($s.Bytes.Length) head=`"$head`"")
    }
    return , $out
}

# Geri döngüde bir TCP alışverişi: istemci $up gönderir, sunucu $down ile yanıtlar. -Close ile iki uç hemen kapatılır.
function Invoke-LoopTcp($listener, [System.Net.IPAddress]$addr, [byte[]]$up, [byte[]]$down, [switch]$Close) {
    $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    $client = [System.Net.Sockets.TcpClient]::new($addr.AddressFamily)
    $client.Connect($addr, $port)
    $server = $listener.AcceptTcpClient()
    $cport = ([System.Net.IPEndPoint]$client.Client.LocalEndPoint).Port
    $cs = $client.GetStream(); $ss = $server.GetStream()
    $cs.Write($up, 0, $up.Length); $cs.Flush()
    $got = [byte[]]::new($up.Length); $n = 0
    while ($n -lt $got.Length) { $k = $ss.Read($got, $n, $got.Length - $n); if ($k -le 0) { break }; $n += $k }
    $wt = $ss.WriteAsync($down, 0, $down.Length)
    $cs.ReadTimeout = 10000
    $got2 = [byte[]]::new($down.Length); $n = 0
    while ($n -lt $got2.Length) { $k = $cs.Read($got2, $n, $got2.Length - $n); if ($k -le 0) { break }; $n += $k }
    $okW = $wt.Wait(10000)
    $ok = $okW -and (SameBytes $got $up) -and (SameBytes $got2 $down)
    if ($Close) { $client.Dispose(); $server.Dispose(); $client = $null; $server = $null }
    return @{ Ok = $ok; Port = $port; CPort = $cport; Up = $up; Down = $down; Client = $client; Server = $server }
}

function Find-Stream($streams, [string]$dir, [string]$proto, [int]$lport, [int]$rport) {
    return @($streams | Where-Object { $_.Dir -eq $dir -and $_.Proto -eq $proto -and ($lport -eq 0 -or $_.LPort -eq $lport) -and ($rport -eq 0 -or $_.RPort -eq $rport) })
}

# ---------------------------------------------------------------- hazırlık
$agentPath = (Resolve-Path -LiteralPath $Agent).Path
Write-Host "agent: $agentPath  label: $Label  pid(test): $PID"
Write-Host ("env: MP_NET_RCVALL=" + $env:MP_NET_RCVALL + " MP_NET_LOOPBACK=" + $env:MP_NET_LOOPBACK)
try { Write-Host ((netsh advfirewall show allprofiles state | Out-String).Trim()) } catch { }
try { Get-NetIPAddress | Where-Object { $_.AddressState -eq 'Preferred' } | ForEach-Object { Write-Host ("ip: " + $_.IPAddress + " if=" + $_.InterfaceIndex + " " + $_.InterfaceAlias) } } catch { }

$psi = [System.Diagnostics.ProcessStartInfo]::new($agentPath)
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.StandardOutputEncoding = $utf8
$psi.StandardInputEncoding = $utf8
$agentProc = [System.Diagnostics.Process]::Start($psi)
$script:AgentIn = $agentProc.StandardInput.BaseStream
$script:AgentOut = $agentProc.StandardOutput
$script:Capture = $false
$script:Ext = @{}
$script:Lo = @{}
$script:Lo6 = @{}
$script:Short = @()
$script:LL = @{}

try {
    Step 'hello' {
        $r = Call '"cmd":"hello"' 'hello'
        Assert ($r.ok -and $r.data.net -eq $true) 'hello.net'
        Write-Host ("EXTRACT elevated=" + $r.data.elevated + " os=" + $r.data.os)
    }

    Step 'netcap on' {
        $r = Call '"cmd":"netcap","on":true' 'netcap on'
        Assert $r.ok 'netcap on'
        $script:Capture = [bool]$r.data.capture
        Assert $script:Capture ("capture is off: reason=" + $r.data.reason + " error=" + $r.data.error)
        foreach ($i in @($r.data.ifaces)) { Write-Host ("  socket v$($i.v) $($i.addr) mode=$($i.mode) name=`"$($i.name)`" loopback=$($i.loopback)") }
        foreach ($e in @($r.data.errors)) { Write-Host ("  error: $e") }
        $w = Call ('"cmd":"netwatch","pid":{0},"reset":true' -f $PID) 'netwatch'
        Assert ($w.ok -and @($w.data.watch).Count -eq 1 -and $w.data.watch[0] -eq $PID) 'netwatch'
        [void](Call '"cmd":"snapshot"' 'snapshot #0' -Quiet)
    }
    if (-not $script:Capture) { throw 'capture could not be started' }

    # ------------------------------------------------------------ geri döngü TCP
    Step 'loopback tcp' {
        $up = Pattern 3000 11
        $down = Pattern 70000 97
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
        $listener.Start()
        $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
        $client = [System.Net.Sockets.TcpClient]::new()
        $client.Connect([System.Net.IPAddress]::Loopback, $port)
        $server = $listener.AcceptTcpClient()
        $cport = ([System.Net.IPEndPoint]$client.Client.LocalEndPoint).Port
        $cs = $client.GetStream(); $ss = $server.GetStream()
        $cs.Write($up, 0, $up.Length); $cs.Flush()
        $got = [byte[]]::new($up.Length); $n = 0
        while ($n -lt $got.Length) { $k = $ss.Read($got, $n, $got.Length - $n); if ($k -le 0) { break }; $n += $k }
        $wt = $ss.WriteAsync($down, 0, $down.Length)
        $cs.ReadTimeout = 10000
        $got2 = [byte[]]::new($down.Length); $n = 0
        while ($n -lt $got2.Length) { $k = $cs.Read($got2, $n, $got2.Length - $n); if ($k -le 0) { break }; $n += $k }
        Assert ($wt.Wait(10000)) 'server write did not complete'
        Assert (SameBytes $got $up) 'server did not receive the upload'
        Assert (SameBytes $got2 $down) 'client did not receive the download'
        $script:Lo = @{ Port = $port; CPort = $cport; Up = $up; Down = $down; Client = $client; Server = $server; Listener = $listener }
        Write-Host "loopback: server 127.0.0.1:$port client port $cport up=$($up.Length) down=$($down.Length)"
    }

    # ------------------------------------------------------------ kısa ömürlü bağlantılar
    # Bağlan, gönder, al, hemen kapat: süreç eşlemesi bağlantı kapanmadan yapılamazsa veri kaybolur.
    Step 'loopback short' {
        $listener = $script:Lo.Listener
        if (-not $listener) { throw 'no listener' }
        $list = @()
        for ($i = 0; $i -lt 6; $i++) {
            $x = Invoke-LoopTcp $listener ([System.Net.IPAddress]::Loopback) (Pattern (200 + $i) (20 + $i)) (Pattern (5000 + $i * 20000) (40 + $i)) -Close
            Assert $x.Ok "short connection $i payload mismatch"
            $list += $x
            if ($i -ge 3) { Start-Sleep -Milliseconds 40 }
        }
        $script:Short = $list
        Write-Host ("short: " + (($list | ForEach-Object { "$($_.CPort)" }) -join ','))
    }

    # ------------------------------------------------------------ geri döngü TCP (IPv6)
    Step 'loopback tcp6' {
        if (-not [System.Net.Sockets.Socket]::OSSupportsIPv6) { Warn 'IPv6 is not available'; return }
        $l6 = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::IPv6Loopback, 0)
        $l6.Start()
        $x = Invoke-LoopTcp $l6 ([System.Net.IPAddress]::IPv6Loopback) (Pattern 2500 71) (Pattern 40000 133)
        Assert $x.Ok 'ipv6 loopback payload mismatch'
        $x.Listener = $l6
        $script:Lo6 = $x
        Write-Host "loopback6: server [::1]:$($x.Port) client port $($x.CPort)"
    }

    # ------------------------------------------------------------ IPv6 bağlantı-yerel (bilgi amaçlı)
    # Runner'da yönlendirilebilir IPv6 adresi yoktur; ham IPv6 soketinin başlık biçimi ve giden paketleri görüp
    # görmediği bağlantı-yerel adres üzerinden ölçülür.
    Step 'ipv6 link-local' {
        if (-not [System.Net.Sockets.Socket]::OSSupportsIPv6) { return }
        $cands = @()
        foreach ($ni in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
            if ($ni.OperationalStatus -ne 'Up' -or $ni.NetworkInterfaceType -eq 'Loopback') { continue }
            $ipp = $ni.GetIPProperties()
            foreach ($ua in $ipp.UnicastAddresses) {
                if ($ua.Address.IsIPv6LinkLocal) { $cands += [pscustomobject]@{ Addr = $ua.Address; Gw = $ipp.GatewayAddresses.Count; Name = $ni.Name } }
            }
        }
        $pick = @($cands | Sort-Object -Property Gw -Descending | Select-Object -First 1)
        if ($pick.Count -eq 0) { Warn 'no IPv6 link-local address'; return }
        $addr = $pick[0].Addr
        Write-Host "link-local: $addr on $($pick[0].Name)"
        $u = [System.Net.Sockets.UdpClient]::new([System.Net.IPEndPoint]::new($addr, 0))
        $msg = Pattern 700 91
        $dst = [System.Net.IPAddress]::Parse("ff02::1%$($addr.ScopeId)")
        [void]$u.Send($msg, $msg.Length, [System.Net.IPEndPoint]::new($dst, 40999))
        $script:LL = @{ Udp = $u; UdpPort = ([System.Net.IPEndPoint]$u.Client.LocalEndPoint).Port; Msg = $msg }
        $l = [System.Net.Sockets.TcpListener]::new($addr, 0)
        $l.Start()
        $script:LL.Listener = $l
        $x = Invoke-LoopTcp $l $addr (Pattern 1500 17) (Pattern 9000 29)
        $script:LL.Tcp = $x
        Write-Host "link-local tcp ok=$($x.Ok) server port $($x.Port) client port $($x.CPort)"
    }

    # ------------------------------------------------------------ geri döngü UDP
    Step 'loopback udp' {
        $a = [System.Net.Sockets.UdpClient]::new([System.Net.IPEndPoint]::new([System.Net.IPAddress]::Loopback, 0))
        $b = [System.Net.Sockets.UdpClient]::new([System.Net.IPEndPoint]::new([System.Net.IPAddress]::Loopback, 0))
        $pa = ([System.Net.IPEndPoint]$a.Client.LocalEndPoint).Port
        $pb = ([System.Net.IPEndPoint]$b.Client.LocalEndPoint).Port
        $msg = Pattern 900 53
        [void]$a.Send($msg, $msg.Length, [System.Net.IPEndPoint]::new([System.Net.IPAddress]::Loopback, $pb))
        $b.Client.ReceiveTimeout = 3000
        $ep = [System.Net.IPEndPoint]::new([System.Net.IPAddress]::Any, 0)
        $rx = $b.Receive([ref]$ep)
        Assert (SameBytes $rx $msg) 'udp datagram mismatch'
        $script:Lo.UdpA = $pa; $script:Lo.UdpB = $pb; $script:Lo.UdpMsg = $msg; $script:Lo.UdpSockets = @($a, $b)
        Write-Host "loopback udp: $pa -> $pb len=$($msg.Length)"
    }

    # ------------------------------------------------------------ dış ağ
    if (-not $NoExternal) {
        Step 'external http' {
            $hc = [System.Net.Http.HttpClient]::new()
            $hc.Timeout = [TimeSpan]::FromSeconds(20)
            try {
                $text = $hc.GetStringAsync('http://www.msftconnecttest.com/connecttest.txt').GetAwaiter().GetResult()
                Write-Host ("GET connecttest.txt -> `"$text`"")
                $script:Ext.Text = $text
            } catch { Warn ("GET failed: " + $_.Exception.Message) }
            try {
                $json = '{"probe":"master-process","values":[1,2,3],"nested":{"ok":true,"text":"merhaba"}}'
                $content = [System.Net.Http.StringContent]::new($json, $utf8, 'application/json')
                $resp = $hc.PostAsync('http://www.msftconnecttest.com/connecttest.txt', $content).GetAwaiter().GetResult()
                Write-Host ("POST json -> " + [int]$resp.StatusCode)
                $script:Ext.Json = $json
            } catch { Warn ("POST failed: " + $_.Exception.Message) }
            try {
                [void](Call '"cmd":"snapshot"' 'snapshot before download' -Quiet)
                $sw = [Diagnostics.Stopwatch]::StartNew()
                $cab = $hc.GetByteArrayAsync('http://ctldl.windowsupdate.com/msdownload/update/v3/static/trustedr/en/authrootstl.cab').GetAwaiter().GetResult()
                Write-Host ("GET authrootstl.cab -> $($cab.Length) bytes in $($sw.ElapsedMilliseconds) ms")
                $script:Ext.Cab = $cab
                Start-Sleep -Milliseconds 300
                $s = Call '"cmd":"snapshot"' 'snapshot after download' -Quiet
                $cols = @($s.data.cols)
                $iPid = $cols.IndexOf('pid'); $iRx = $cols.IndexOf('netRx'); $iTx = $cols.IndexOf('netTx')
                $row = $null
                foreach ($p in $s.data.procs) { if ($p[$iPid] -eq $PID) { $row = $p; break } }
                if ($null -eq $row) { throw 'this process is not in the snapshot' }
                Write-Host ("snapshot: sys.netRx=$($s.data.sys.netRx) sys.netTx=$($s.data.sys.netTx) netCap=$($s.data.sys.netCap) self.netRx=$($row[$iRx]) self.netTx=$($row[$iTx])")
                Assert ($s.data.sys.netCap -eq $true) 'sys.netCap'
                Assert ($s.data.sys.netRx -gt 0) 'sys.netRx is zero after a download'
                if ($row[$iRx] -le 0) { if ($InboundOptional) { Warn 'netRx of this process is zero after a download' } else { Fail 'netRx of this process is zero after a download' } }
                Assert ($row[$iTx] -gt 0) 'netTx of this process is zero after a download'
            } catch { Warn ("download failed: " + $_.Exception.Message) }
            $hc.Dispose()
        }

        Step 'external dns' {
            $ms = [System.IO.MemoryStream]::new()
            foreach ($part in @([byte[]](0x4d, 0x50, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00), [byte[]](, 9), $latin1.GetBytes('microsoft'), [byte[]](, 3), $latin1.GetBytes('com'), [byte[]](0, 0, 1, 0, 1))) { $ms.Write($part, 0, $part.Length) }
            [byte[]]$q = $ms.ToArray()
            $srv = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { $_.ServerAddresses } | Where-Object { $_ })[0]
            if (-not $srv) { $srv = '8.8.8.8' }
            $u = [System.Net.Sockets.UdpClient]::new()
            try {
                $u.Client.ReceiveTimeout = 4000
                $u.Connect($srv, 53)
                [void]$u.Send($q, $q.Length)
                $ep = [System.Net.IPEndPoint]::new([System.Net.IPAddress]::Any, 0)
                $ans = $u.Receive([ref]$ep)
                $script:Ext.DnsQ = $q; $script:Ext.DnsA = $ans; $script:Ext.DnsPort = ([System.Net.IPEndPoint]$u.Client.LocalEndPoint).Port
                Write-Host ("dns: server=$srv query=$($q.Length) answer=$($ans.Length) local port=$($script:Ext.DnsPort)")
            } catch { Warn ("dns query failed: " + $_.Exception.Message) }
            finally { $u.Dispose() }
        }
    }

    Start-Sleep -Milliseconds 700

    # ------------------------------------------------------------ doğrulama
    Step 'conns' {
        $r = Call ('"cmd":"netconns","pid":{0}' -f $PID) 'netconns' -Quiet
        Assert $r.ok 'netconns'
        foreach ($c in @($r.data.conns)) { Write-Host ("  conn $($c.proto)$($c.v) $($c.local):$($c.lport) -> $($c.remote):$($c.rport) $($c.state) rx=$($c.rx) tx=$($c.tx) flow=$($c.flow)") }
        if ($script:Lo.Port) {
            $cl = @($r.data.conns | Where-Object { $_.proto -eq 'tcp' -and $_.lport -eq $script:Lo.CPort -and $_.rport -eq $script:Lo.Port })
            $sv = @($r.data.conns | Where-Object { $_.proto -eq 'tcp' -and $_.lport -eq $script:Lo.Port -and $_.rport -eq $script:Lo.CPort })
            $ls = @($r.data.conns | Where-Object { $_.proto -eq 'tcp' -and $_.lport -eq $script:Lo.Port -and $_.state -eq 'listen' })
            Assert ($cl.Count -eq 1) "client row count = $($cl.Count)"
            Assert ($sv.Count -eq 1) "server row count = $($sv.Count)"
            Assert ($ls.Count -eq 1) "listener row count = $($ls.Count)"
            if ($cl.Count -eq 1) { Write-Host ("EXTRACT lo client rx=$($cl[0].rx) tx=$($cl[0].tx) (payload down=$($script:Lo.Down.Length) up=$($script:Lo.Up.Length))") }
            if ($sv.Count -eq 1) { Write-Host ("EXTRACT lo server rx=$($sv[0].rx) tx=$($sv[0].tx)") }
        }
        if ($script:Lo6.Port) {
            $c6 = @($r.data.conns | Where-Object { $_.proto -eq 'tcp' -and $_.v -eq 6 -and $_.lport -eq $script:Lo6.CPort -and $_.rport -eq $script:Lo6.Port })
            Assert ($c6.Count -eq 1) "ipv6 client row count = $($c6.Count)"
            if ($c6.Count -eq 1) {
                Write-Host ("EXTRACT lo6 client rx=$($c6[0].rx) tx=$($c6[0].tx) flow=$($c6[0].flow) (payload down=$($script:Lo6.Down.Length) up=$($script:Lo6.Up.Length))")
                if ($c6[0].rx -lt $script:Lo6.Down.Length -or $c6[0].tx -lt $script:Lo6.Up.Length) { Warn 'ipv6 loopback counters are below the payload' }
            }
        }
        if ($script:Ext.Cab) {
            $h = @($r.data.conns | Where-Object { $_.proto -eq 'tcp' -and $_.rport -eq 80 })
            $rx = ($h | Measure-Object -Property rx -Sum).Sum
            $tx = ($h | Measure-Object -Property tx -Sum).Sum
            Write-Host ("EXTRACT http rows=$($h.Count) rx=$rx tx=$tx (cab=$($script:Ext.Cab.Length))")
            Assert ($h.Count -ge 1) 'no port 80 connection is listed for this process'
            if ($rx -lt $script:Ext.Cab.Length) { if ($InboundOptional) { Warn "port 80 rx $rx is below the downloaded size" } else { Fail "port 80 rx $rx is below the downloaded size" } }
            Assert ($tx -gt 0) 'port 80 tx is zero'
        }
    }

    Step 'stream' {
        $streams = Read-Stream
        $res = [ordered]@{}
        if ($script:Lo.Port) {
            $cOut = @(Find-Stream $streams 'out' 'tcp' $script:Lo.CPort $script:Lo.Port)
            $cIn = @(Find-Stream $streams 'in' 'tcp' $script:Lo.CPort $script:Lo.Port)
            $sIn = @(Find-Stream $streams 'in' 'tcp' $script:Lo.Port $script:Lo.CPort)
            $sOut = @(Find-Stream $streams 'out' 'tcp' $script:Lo.Port $script:Lo.CPort)
            $res.lo_client_out = ($cOut.Count -eq 1 -and (SameBytes $cOut[0].Bytes $script:Lo.Up))
            $res.lo_client_in = ($cIn.Count -eq 1 -and (SameBytes $cIn[0].Bytes $script:Lo.Down))
            $res.lo_server_in = ($sIn.Count -eq 1 -and (SameBytes $sIn[0].Bytes $script:Lo.Up))
            $res.lo_server_out = ($sOut.Count -eq 1 -and (SameBytes $sOut[0].Bytes $script:Lo.Down))
        }
        if ($script:Short.Count -gt 0) {
            $good = 0
            foreach ($x in $script:Short) {
                $o = @(Find-Stream $streams 'out' 'tcp' $x.CPort $x.Port)
                $i = @(Find-Stream $streams 'in' 'tcp' $x.CPort $x.Port)
                $so = @(Find-Stream $streams 'out' 'tcp' $x.Port $x.CPort)
                $si = @(Find-Stream $streams 'in' 'tcp' $x.Port $x.CPort)
                $ok = ($o.Count -eq 1 -and (SameBytes $o[0].Bytes $x.Up)) -and ($i.Count -eq 1 -and (SameBytes $i[0].Bytes $x.Down)) -and ($so.Count -eq 1 -and (SameBytes $so[0].Bytes $x.Down)) -and ($si.Count -eq 1 -and (SameBytes $si[0].Bytes $x.Up))
                if ($ok) { $good++ } else { Write-Host ("short miss: cport=$($x.CPort) out=$($o.Count)/$(if ($o.Count) { $o[0].Bytes.Length }) in=$($i.Count)/$(if ($i.Count) { $i[0].Bytes.Length }) srvOut=$($so.Count)/$(if ($so.Count) { $so[0].Bytes.Length }) srvIn=$($si.Count)/$(if ($si.Count) { $si[0].Bytes.Length }) want up=$($x.Up.Length) down=$($x.Down.Length)") }
            }
            Write-Host ("EXTRACT short ok=$good of $($script:Short.Count)")
            $res.lo_short = ($good -eq $script:Short.Count)
        }
        if ($script:Lo6.Port) {
            $cOut = @(Find-Stream $streams 'out' 'tcp' $script:Lo6.CPort $script:Lo6.Port)
            $cIn = @(Find-Stream $streams 'in' 'tcp' $script:Lo6.CPort $script:Lo6.Port)
            $sIn = @(Find-Stream $streams 'in' 'tcp' $script:Lo6.Port $script:Lo6.CPort)
            $sOut = @(Find-Stream $streams 'out' 'tcp' $script:Lo6.Port $script:Lo6.CPort)
            $res.lo6_client_out = ($cOut.Count -eq 1 -and $cOut[0].V -eq 6 -and (SameBytes $cOut[0].Bytes $script:Lo6.Up))
            $res.lo6_client_in = ($cIn.Count -eq 1 -and (SameBytes $cIn[0].Bytes $script:Lo6.Down))
            $res.lo6_server_in = ($sIn.Count -eq 1 -and (SameBytes $sIn[0].Bytes $script:Lo6.Up))
            $res.lo6_server_out = ($sOut.Count -eq 1 -and (SameBytes $sOut[0].Bytes $script:Lo6.Down))
        }
        if ($script:LL.Msg) {
            $uo = @(Find-Stream $streams 'out' 'udp' $script:LL.UdpPort 40999)
            $res.ll6_udp_out = ($uo.Count -eq 1 -and (SameBytes $uo[0].Bytes $script:LL.Msg))
            if ($script:LL.Tcp) {
                $x = $script:LL.Tcp
                $res.ll6_tcp_out = (@(Find-Stream $streams 'out' 'tcp' $x.CPort $x.Port | Where-Object { SameBytes $_.Bytes $x.Up }).Count -eq 1)
                $res.ll6_tcp_in = (@(Find-Stream $streams 'in' 'tcp' $x.CPort $x.Port | Where-Object { SameBytes $_.Bytes $x.Down }).Count -eq 1)
            }
        }
        if ($script:Lo.UdpMsg) {
            $uo = @(Find-Stream $streams 'out' 'udp' $script:Lo.UdpA $script:Lo.UdpB)
            $ui = @(Find-Stream $streams 'in' 'udp' $script:Lo.UdpB $script:Lo.UdpA)
            $res.lo_udp_out = ($uo.Count -eq 1 -and (SameBytes $uo[0].Bytes $script:Lo.UdpMsg))
            $res.lo_udp_in = ($ui.Count -eq 1 -and (SameBytes $ui[0].Bytes $script:Lo.UdpMsg))
        }
        if (-not $NoExternal) {
            $outText = ($streams | Where-Object { $_.Dir -eq 'out' -and $_.Proto -eq 'tcp' -and $_.RPort -eq 80 } | ForEach-Object { $latin1.GetString($_.Bytes) }) -join "`n"
            $inAll = @($streams | Where-Object { $_.Dir -eq 'in' -and $_.Proto -eq 'tcp' -and $_.RPort -eq 80 })
            $inText = ($inAll | ForEach-Object { $latin1.GetString($_.Bytes) }) -join "`n"
            if ($script:Ext.Text) {
                $res.ext_http_out = $outText.Contains('GET /connecttest.txt HTTP/1.1')
                $res.ext_http_in = ($inText.Contains('HTTP/1.1 200') -and $inText.Contains($script:Ext.Text))
            }
            if ($script:Ext.Json) { $res.ext_post_out = ($outText.Contains('POST /connecttest.txt') -and $outText.Contains($script:Ext.Json)) }
            if ($script:Ext.Cab) {
                $cabText = $latin1.GetString($script:Ext.Cab)
                $inBytes = ($inAll | ForEach-Object { $_.Bytes.Length } | Measure-Object -Sum).Sum
                if ($inText.Contains($cabText)) { $res.ext_download_in = $true }
                elseif ($inText -match '(?i)transfer-encoding:\s*chunked' -and $inBytes -ge $script:Ext.Cab.Length) { $res.ext_download_in = $true; Warn "download arrived chunked; compared by size only ($inBytes bytes)" }
                else { $res.ext_download_in = $false; Write-Host "download: captured in=$inBytes expected>=$($script:Ext.Cab.Length)" }
            }
            if ($script:Ext.DnsQ) {
                $dq = @(Find-Stream $streams 'out' 'udp' $script:Ext.DnsPort 53)
                $da = @(Find-Stream $streams 'in' 'udp' $script:Ext.DnsPort 53)
                $res.ext_dns_out = ($dq.Count -eq 1 -and (SameBytes $dq[0].Bytes $script:Ext.DnsQ))
                $res.ext_dns_in = ($da.Count -eq 1 -and (SameBytes $da[0].Bytes $script:Ext.DnsA))
            }
        }
        $line = ($res.GetEnumerator() | ForEach-Object { "$($_.Key)=$(if ($_.Value) { 'ok' } else { 'MISS' })" }) -join ' '
        Write-Host "RESULT [$Label] $line"
        foreach ($e in $res.GetEnumerator()) {
            if ($e.Value) { continue }
            if ($e.Key -like 'll6_*' -or $e.Key -like 'lo6_*') { Warn "$($e.Key) not captured (IPv6 probe, informational)" }
            elseif ($InboundOptional -and $e.Key -like 'ext_*_in') { Warn "$($e.Key) not captured (inbound is optional in this run)" }
            else { Fail "$($e.Key) not captured" }
        }
    }

    Step 'netcap status' {
        $r = Call '"cmd":"netcap"' 'netcap'
        foreach ($i in @($r.data.ifaces)) { Write-Host ("  socket v$($i.v) $($i.addr) mode=$($i.mode) packets=$($i.packets) head=$($i.head)") }
        $w = Call '"cmd":"netwatch","pid":0' 'netwatch off'
        Assert (@($w.data.watch).Count -eq 0) 'watch not cleared'
        $s = Call '"cmd":"netstream"' 'netstream after clear' -Quiet
        Assert (@($s.data.chunks).Count -eq 0) 'ring not cleared'
        $o = Call '"cmd":"netcap","on":false' 'netcap off'
        Assert ($o.ok -and $o.data.capture -eq $false) 'netcap off'
    }
}
finally {
    foreach ($x in @($script:Lo.Client, $script:Lo.Server, $script:Lo6.Client, $script:Lo6.Server, $script:LL.Udp)) { if ($x) { try { $x.Dispose() } catch { } } }
    if ($script:LL.Tcp) { foreach ($x in @($script:LL.Tcp.Client, $script:LL.Tcp.Server)) { if ($x) { try { $x.Dispose() } catch { } } } }
    foreach ($x in @($script:Lo.Listener, $script:Lo6.Listener, $script:LL.Listener)) { if ($x) { try { $x.Stop() } catch { } } }
    foreach ($x in @($script:Lo.UdpSockets)) { if ($x) { try { $x.Dispose() } catch { } } }
    try { $script:AgentIn.Close() } catch { }
    if (-not $agentProc.WaitForExit(5000)) { try { $agentProc.Kill() } catch { } }
}

Write-Host ''
Write-Host "SUMMARY [$Label] fails=$($script:Fails.Count) warns=$($script:Warns.Count)"
foreach ($f in $script:Fails) { Write-Host "  FAIL $f" }
foreach ($w in $script:Warns) { Write-Host "  WARN $w" }
if ($script:Fails.Count -gt 0) { exit 1 }
exit 0
