# dsh-serial-console bridge.
#
# Owns one System.IO.Ports.SerialPort in a dedicated Windows PowerShell process
# and speaks a line protocol with the DSH host over stdin/stdout.
#
# Every byte written to stdout is ASCII. Payloads (received serial bytes, JSON
# documents, error messages) are base64 encoded so the transport never depends
# on console code pages.
#
# stdin commands
#   PING  <id>
#   PORTS <id>
#   OPEN  <id> <b64 json config>
#   CLOSE <id>
#   WRITE <id> <b64 bytes>
#   RESET <id>
#   EXIT
#
# stdout lines
#   READY
#   PONG   <id>
#   PORTS  <id> <b64 json array>
#   OPENED <id> <b64 json config>
#   CLOSED <id>
#   WRITTEN <id>
#   RESET  <id>
#   DATA   <b64 bytes>
#   NOTE   <b64 utf8 message>
#   ERR    <id|-> <b64 utf8 message>

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try { [Console]::OutputEncoding = [System.Text.Encoding]::ASCII } catch { }

$stdout = [Console]::OpenStandardOutput()
$stdin = [Console]::OpenStandardInput()

$script:Port = $null

function Send-Line([string]$text) {
  $bytes = [System.Text.Encoding]::ASCII.GetBytes($text + "`n")
  try {
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
  } catch {
    exit 1
  }
}

function Send-Plain([string]$kind, [string]$text) {
  $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($text))
  Send-Line ($kind + ' ' + $b64)
}

function Send-Code([string]$kind, [string]$id, [string]$text) {
  $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($text))
  Send-Line ($kind + ' ' + $id + ' ' + $b64)
}

function Send-Json([string]$kind, [string]$id, $value) {
  $json = ConvertTo-Json -InputObject $value -Compress -Depth 5
  if ($null -eq $json -or $json -eq '') { $json = 'null' }
  $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
  Send-Line ($kind + ' ' + $id + ' ' + $b64)
}

function Close-Port {
  if ($null -ne $script:Port) {
    try { if ($script:Port.IsOpen) { $script:Port.Close() } } catch { }
    try { $script:Port.Dispose() } catch { }
    $script:Port = $null
  }
}

function Get-PortNames {
  $items = @{}
  try {
    foreach ($name in [System.IO.Ports.SerialPort]::GetPortNames()) {
      $items[$name] = @{ port = $name; label = ''; detail = '' }
    }
  } catch { }

  try {
    $props = Get-ItemProperty -Path 'HKLM:\HARDWARE\DEVICEMAP\SERIALCOMM' -ErrorAction Stop
    foreach ($p in $props.PSObject.Properties) {
      if ($p.Name -like 'PS*') { continue }
      $com = [string]$p.Value
      if ($com -match '^COM\d+$' -and -not $items.ContainsKey($com)) {
        $items[$com] = @{ port = $com; label = ''; detail = '' }
      }
    }
  } catch { }

  return $items
}

function Get-PortLabels {
  $age = [double]::MaxValue
  if ($null -ne $script:PortLabelCacheAt) {
    $age = ((Get-Date) - $script:PortLabelCacheAt).TotalSeconds
  }
  if ($null -ne $script:PortLabelCache -and $age -lt 30) { return $script:PortLabelCache }

  $map = @{}
  try {
    $devices = @(Get-CimInstance -ClassName Win32_PnPEntity -ErrorAction Stop |
      Where-Object { $_.Name -match '\(COM\d+\)' })
    foreach ($device in $devices) {
      $match = [regex]::Match([string]$device.Name, '\((COM\d+)\)')
      if (-not $match.Success) { continue }
      $friendly = ([string]$device.Name) -replace '\s*\(COM\d+\)\s*$', ''
      $map[$match.Groups[1].Value] = @{ label = $friendly; detail = [string]$device.PNPDeviceID }
    }
  } catch { }

  $script:PortLabelCache = $map
  $script:PortLabelCacheAt = Get-Date
  return $map
}

function Get-PortList([bool]$enrich) {
  $items = Get-PortNames
  if ($enrich) {
    $labels = Get-PortLabels
    foreach ($com in @($items.Keys)) {
      if ($labels.ContainsKey($com)) {
        $items[$com].label = $labels[$com].label
        $items[$com].detail = $labels[$com].detail
      }
    }
  }

  $list = @()
  $keys = $items.Keys | Sort-Object { $n = [int]($_ -replace '\D', ''); if ($n -gt 0) { $n } else { 9999 } }
  foreach ($key in $keys) { $list += , $items[$key] }
  return , $list
}

function Handle-Command([string]$line) {
  $parts = $line.Split(' ', 3)
  $verb = $parts[0]

  switch ($verb) {
    'PING' {
      if ($parts.Length -ge 2) { Send-Line ('PONG ' + $parts[1]) }
    }

    'PORTS' {
      if ($parts.Length -ge 2) {
        $reqId = $parts[1]
        Send-Json 'PORTS' $reqId (Get-PortList $false)
        Send-Json 'PORTS' $reqId (Get-PortList $true)
      }
    }

    'OPEN' {
      if ($parts.Length -lt 3) { Send-Code 'ERR' '-' 'OPEN needs an id and a payload'; return }
      $id = $parts[1]
      $config = $null
      try {
        $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[2]))
        $config = $json | ConvertFrom-Json
      } catch {
        Send-Code 'ERR' $id ('unreadable open request: ' + $_.Exception.Message)
        return
      }

      Close-Port
      try {
        $port = New-Object System.IO.Ports.SerialPort
        $port.PortName = [string]$config.port
        $port.BaudRate = [int]$config.baudRate
        $port.Parity = [System.IO.Ports.Parity]([string]$config.parity)
        $port.DataBits = [int]$config.dataBits
        $port.StopBits = [System.IO.Ports.StopBits]([string]$config.stopBits)
        $port.Handshake = [System.IO.Ports.Handshake]::None
        $port.ReadBufferSize = 65536
        $port.WriteTimeout = 2000
        $port.ReadTimeout = 500
        $port.WriteBufferSize = 16384
        $port.DtrEnable = [bool]$config.dtrEnable
        $port.RtsEnable = [bool]$config.rtsEnable
        $port.Open()
        try { $port.DiscardInBuffer() } catch { }
        try { $port.DiscardOutBuffer() } catch { }
        $script:Port = $port
        Send-Json 'OPENED' $id $config
      } catch {
        $message = $_.Exception.Message
        Close-Port
        Send-Code 'ERR' $id $message
      }
    }

    'CLOSE' {
      Close-Port
      if ($parts.Length -ge 2) { Send-Line ('CLOSED ' + $parts[1]) }
    }

    'WRITE' {
      if ($parts.Length -lt 3) { Send-Code 'ERR' '-' 'write needs an id and a payload'; return }
      $id = $parts[1]
      if ($null -eq $script:Port -or -not $script:Port.IsOpen) {
        Send-Code 'ERR' $id 'port is not open'
        return
      }
      try {
        $bytes = [Convert]::FromBase64String($parts[2])
        $script:Port.Write($bytes, 0, $bytes.Length)
        Send-Line ('WRITTEN ' + $id)
      } catch {
        Send-Code 'ERR' $id ('write failed: ' + $_.Exception.Message)
      }
    }

    'RESET' {
      if ($null -eq $script:Port -or -not $script:Port.IsOpen) {
        Send-Code 'ERR' $parts[1] 'port is not open'
        return
      }
      try {
        $script:Port.DtrEnable = $false
        $script:Port.RtsEnable = $true
        Start-Sleep -Milliseconds 120
        $script:Port.RtsEnable = $false
        Start-Sleep -Milliseconds 60
        Send-Line ('RESET ' + $parts[1])
      } catch {
        Send-Code 'ERR' $parts[1] ('reset failed: ' + $_.Exception.Message)
      }
    }

    'EXIT' {
      Close-Port
      exit 0
    }

    default {
      Send-Code 'ERR' '-' ('unknown command: ' + $verb)
    }
  }
}

Send-Line 'READY'

$inBuf = New-Object byte[] 16384
$serBuf = New-Object byte[] 8192
$acc = New-Object System.Text.StringBuilder
$pending = $stdin.ReadAsync($inBuf, 0, $inBuf.Length)

while ($true) {
  if ($null -ne $script:Port -and $script:Port.IsOpen) {
    for ($round = 0; $round -lt 8; $round++) {
      try {
        $available = $script:Port.BytesToRead
        if ($available -le 0) { break }
        $want = [Math]::Min($available, $serBuf.Length)
        $got = $script:Port.Read($serBuf, 0, $want)
        if ($got -le 0) { break }
        Send-Line ('DATA ' + [Convert]::ToBase64String($serBuf, 0, $got))
      } catch {
        $message = $_.Exception.Message
        Close-Port
        Send-Plain 'NOTE' ('port closed: ' + $message)
        Send-Line 'CLOSED -'
        break
      }
    }
  }

  if ($pending.IsCompleted) {
    $read = 0
    try { $read = $pending.GetAwaiter().GetResult() } catch { break }
    if ($read -le 0) { break }

    [void]$acc.Append([System.Text.Encoding]::ASCII.GetString($inBuf, 0, $read))
    while ($true) {
      $buffer = $acc.ToString()
      $index = $buffer.IndexOf("`n")
      if ($index -lt 0) { break }
      $line = $buffer.Substring(0, $index).Trim()
      [void]$acc.Remove(0, $index + 1)
      if ($line.Length -gt 0) { Handle-Command $line }
    }
    $pending = $stdin.ReadAsync($inBuf, 0, $inBuf.Length)
  }

  Start-Sleep -Milliseconds 4
}

Close-Port
