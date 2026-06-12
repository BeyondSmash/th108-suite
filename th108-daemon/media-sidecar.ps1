# media-sidecar.ps1 - prints {"title","artist","status","thumb"} JSON lines whenever the
# Windows media session changes (any player: Spotify, browsers, VLC...). Spawned and killed by
# the daemon (nowplaying.js). Polls ~1/s; only CHANGES are printed (thumb = base64 jpeg/png).
# This file must stay pure ASCII (PS 5.1 reads UTF-8-without-BOM as ANSI; smart-quote mojibake
# from fancy characters breaks parsing - learned the hard way 2026-06-11).
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
  $task.Wait(2000) | Out-Null
  return $task.Result
}
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null

$last = ''
while ($true) {
  Start-Sleep -Milliseconds 1000
  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  if (-not $mgr) { continue }
  $s = $mgr.GetCurrentSession()
  if (-not $s) { continue }
  $info = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  if (-not $info) { continue }
  if (-not $info.Title) { continue }
  $play = $s.GetPlaybackInfo().PlaybackStatus
  $status = if ("$play" -eq 'Playing') { 'playing' } else { 'paused' }
  $key = $info.Title + '|' + $info.Artist + '|' + $status
  if ($key -eq $last) { continue }
  $last = $key
  $thumb = ''
  if ($info.Thumbnail) {
    try {
      $stream = Await ($info.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
      if ($stream) {
        $size = [int]$stream.Size
        if ($size -gt 0 -and $size -lt 2000000) {
          $reader = [Windows.Storage.Streams.DataReader]::new($stream.GetInputStreamAt(0))
          $loadOp = $reader.LoadAsync($size)
          $task = $asTaskGeneric.MakeGenericMethod([uint32]).Invoke($null, @($loadOp)); $task.Wait(2000) | Out-Null
          $bytes = New-Object byte[] $size
          $reader.ReadBytes($bytes)
          $thumb = [Convert]::ToBase64String($bytes)
        }
      }
    } catch { $thumb = '' }
  }
  $obj = @{ title = "$($info.Title)"; artist = "$($info.Artist)"; status = $status; thumb = $thumb }
  Write-Output (ConvertTo-Json $obj -Compress)
}
