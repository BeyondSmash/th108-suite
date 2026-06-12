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
while ($true) {
  Start-Sleep -Milliseconds 1000
  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ($mgrType)
  if (-not $mgr) { continue }
  $s = $mgr.GetCurrentSession()
  if (-not $s) { continue }
  $info = Await ($s.TryGetMediaPropertiesAsync()) ($propType)
  if (-not $info) { continue }
  if (-not $info.Title) { continue }
  $play = $s.GetPlaybackInfo().PlaybackStatus
  $status = if ("$play" -eq 'Playing') { 'playing' } else { 'paused' }
  $key = $info.Title + '|' + $info.Artist + '|' + $status
  if ($key -eq $last) { continue }
  $last = $key
  $thumb = ''
  if ($info.Thumbnail -and $rasType) {
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
  $obj = @{ title = "$($info.Title)"; artist = "$($info.Artist)"; status = $status; thumb = $thumb }
  Write-Output (ConvertTo-Json $obj -Compress)
}
