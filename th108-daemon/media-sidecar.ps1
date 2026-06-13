# media-sidecar.ps1 - prints {"title","artist","status","thumb"} JSON lines whenever the
# Windows media session changes (any player: Spotify, browsers, VLC...). Spawned and killed by
# the daemon (nowplaying.js). Polls ~1/s; only CHANGES are printed (thumb = base64 jpeg/png).
# Pure ASCII (PS 5.1 reads UTF-8-without-BOM as ANSI; mojibake breaks parsing).
#
# WinRT awaits MUST go through AsTask (the raw IAsyncOperation projects as a bare __ComObject
# with no Status/GetResults). And WinRT INTERFACE types do not resolve as PS type literals -
# load them via [Type]::GetType('...ContentType=WindowsRuntime') instead (the literal failing
# silently inside the thumbnail try/catch cost us the album art, 2026-06-12).
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8   # non-ASCII titles/artists survive the pipe (was ANSI -> '????')
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
# the WinRT stream comes back as a bare __ComObject; PS's binder can't pass it to AsStream, but
# a REFLECTION Invoke marshals it fine (same trick AsTask relies on) - this is the album-art key
$asStream = ([System.IO.WindowsRuntimeStreamExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsStream' -and $_.GetParameters().Count -eq 1 })[0]
function Await($op, $resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
  $task.Wait(2500) | Out-Null
  return $task.Result
}
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
$mgrType  = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$propType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
$rasType  = [System.Type]::GetType('Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType=WindowsRuntime')

$last = ''
$lastThumbKey = ''
$lastEmit = (Get-Date).AddSeconds(-10)
while ($true) {
  Start-Sleep -Milliseconds 1000
  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ($mgrType)
  if (-not $mgr) { continue }
  # Pick the BEST session, not just the current one: prefer a Spotify session (the default
  # whitelist) over a browser tab, and a playing one over paused. This way Spotify keeps showing
  # even while X/Twitter is the foreground media session (which the daemon would block anyway).
  $s = $null; $status = ''
  try {
    $sessions = $mgr.GetSessions()
    $bestScore = -1
    foreach ($sess in $sessions) {
      try {
        $st = if ("$($sess.GetPlaybackInfo().PlaybackStatus)" -eq 'Playing') { 'playing' } else { 'paused' }
        $src = "$($sess.SourceAppUserModelId)"
        $score = 0
        if ($src -match 'spotify') { $score += 2 }
        if ($st -eq 'playing') { $score += 1 }
        if ($score -gt $bestScore) { $bestScore = $score; $s = $sess; $status = $st }
      } catch { }
    }
  } catch { }
  if (-not $s) { $s = $mgr.GetCurrentSession(); if ($s) { $status = if ("$($s.GetPlaybackInfo().PlaybackStatus)" -eq 'Playing') { 'playing' } else { 'paused' } } }
  if (-not $s) { continue }
  $info = Await ($s.TryGetMediaPropertiesAsync()) ($propType)
  if (-not $info) { continue }
  if (-not $info.Title) { continue }
  # the source app id (AUMID) - Spotify.exe / SpotifyAB.SpotifyMusic..., browsers report Chrome /
  # MSEdge / Brave etc. The daemon whitelists by this so X/Twitter video can't drive the LCD.
  $source = ''
  try { $source = "$($s.SourceAppUserModelId)" } catch { $source = '' }
  # timeline (for the keyboard progress-bar): position + total duration, in ms
  $posMs = 0; $durMs = 0
  try { $tl = $s.GetTimelineProperties(); $posMs = [int]$tl.Position.TotalMilliseconds; $durMs = [int]$tl.EndTime.TotalMilliseconds } catch { }
  # emit on any change, AND every ~2s while playing so the progress bar keeps advancing
  $key = $source + '|' + $info.Title + '|' + $info.Artist + '|' + $status
  $thumbKey = $info.Title + '|' + $info.Artist
  $changed = ($key -ne $last)
  $tick = ($status -eq 'playing' -and ((Get-Date) - $lastEmit).TotalMilliseconds -ge 2000)
  if (-not $changed -and -not $tick) { continue }
  $last = $key; $lastEmit = Get-Date
  # fetch the album-art thumbnail ONLY when the track changed (it's ~150KB; not on every 2s tick)
  $thumb = ''
  if ($thumbKey -ne $lastThumbKey -and $info.Thumbnail -and $rasType) {
    $lastThumbKey = $thumbKey
    try {
      $stream = Await ($info.Thumbnail.OpenReadAsync()) ($rasType)
      if ($stream) {
        $net = $asStream.Invoke($null, @($stream))
        $ms = New-Object System.IO.MemoryStream
        $net.CopyTo($ms)
        $bytes = $ms.ToArray()
        if ($bytes.Length -gt 0 -and $bytes.Length -lt 2000000) { $thumb = [Convert]::ToBase64String($bytes) }
        $ms.Dispose(); $net.Dispose()
      }
    } catch { $thumb = '' }
  }
  $obj = @{ title = "$($info.Title)"; artist = "$($info.Artist)"; status = $status; thumb = $thumb; source = $source; posMs = $posMs; durMs = $durMs }
  Write-Output (ConvertTo-Json $obj -Compress)
}
