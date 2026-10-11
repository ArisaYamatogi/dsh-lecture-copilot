#!/usr/bin/env pwsh
# End-to-end exercise of the live Lecture Copilot host endpoints:
# start a session, upload one real speech WAV, read back the transcript and
# translation, then discard the session.
param(
  [string]$Raw = "C:\Users\21888\AppData\Local\Temp\lecture-e2e\lecture.wav",
  [string]$Base = "http://127.0.0.1:19387/lecture-copilot",
  [int]$SampleRate = 16000,
  [switch]$Keep
)

$ErrorActionPreference = "Stop"

function Invoke-Json {
  param([string]$Path, [string]$Method = "GET", $Body)
  $uri = "$Base$Path"
  if ($null -eq $Body) {
    return Invoke-RestMethod -Uri $uri -Method $Method -TimeoutSec 120
  }
  return Invoke-RestMethod -Uri $uri -Method $Method -Body $Body -ContentType "application/json" -TimeoutSec 120
}

Write-Host "`n== health ==" -ForegroundColor Cyan
$health = Invoke-Json "/health"
Write-Host ("  plugin={0}  language={1}" -f $health.plugin, $health.language)
Write-Host ("  recognizer={0} ({1})  phase={2}" -f $health.recognizer.selected, $health.recognizer.language, $health.recognizer.state.phase)
Write-Host ("  model={0}/{1}" -f $health.model.provider, $health.model.model)
Write-Host ("  services: llm={0} tools={1} webServer={2} speechToText={3}" -f `
  $health.services.llm, $health.services.tools, $health.services.webServer, $health.services.speechToText)

# The synthesizer writes raw PCM16 with a zeroed 44-byte placeholder; wrap it.
# Slicing a PowerShell byte array re-types it as Object[], so rebuild it.
$all = [System.IO.File]::ReadAllBytes($Raw)
$offset = if ($all.Length -gt 44 -and $all[0] -eq 0 -and $all[8] -eq 0) { 44 } else { 0 }
$dataLength = $all.Length - $offset
$pcm = New-Object byte[] $dataLength
[Array]::Copy($all, $offset, $pcm, 0, $dataLength)
$wav = New-Object byte[] (44 + $dataLength)
[Text.Encoding]::ASCII.GetBytes("RIFF").CopyTo($wav, 0)
[BitConverter]::GetBytes([int]($wav.Length - 8)).CopyTo($wav, 4)
[Text.Encoding]::ASCII.GetBytes("WAVE").CopyTo($wav, 8)
[Text.Encoding]::ASCII.GetBytes("fmt ").CopyTo($wav, 12)
[BitConverter]::GetBytes([int]16).CopyTo($wav, 16)
[BitConverter]::GetBytes([int16]1).CopyTo($wav, 20)
[BitConverter]::GetBytes([int16]1).CopyTo($wav, 22)
[BitConverter]::GetBytes([int]$SampleRate).CopyTo($wav, 24)
[BitConverter]::GetBytes([int]($SampleRate * 2)).CopyTo($wav, 28)
[BitConverter]::GetBytes([int16]2).CopyTo($wav, 32)
[BitConverter]::GetBytes([int16]16).CopyTo($wav, 34)
[Text.Encoding]::ASCII.GetBytes("data").CopyTo($wav, 36)
[BitConverter]::GetBytes([int]$pcm.Length).CopyTo($wav, 40)
[Array]::Copy($pcm, 0, $wav, 44, $pcm.Length)
$seconds = [Math]::Round($pcm.Length / 2 / $SampleRate, 1)
Write-Host ("`n== audio ==  {0} bytes PCM16, {1}s @ {2} Hz" -f $pcm.Length, $seconds, $SampleRate) -ForegroundColor Cyan

Write-Host "`n== start ==" -ForegroundColor Cyan
$started = Invoke-Json "/start" "POST" "{}"
Write-Host ("  ok={0}  startedAt={1}" -f $started.ok, $started.startedAt)

Write-Host "`n== upload + transcribe ==" -ForegroundColor Cyan
$sw = [Diagnostics.Stopwatch]::StartNew()
$reply = Invoke-WebRequest -Uri "$Base/audio" -Method POST -Body $wav -ContentType "application/octet-stream" -TimeoutSec 300 -UseBasicParsing
$sw.Stop()
$accepted = $reply.Content | ConvertFrom-Json
Write-Host ("  HTTP {0} in {1:N1}s  accepted={2}  reason={3}" -f $reply.StatusCode, $sw.Elapsed.TotalSeconds, $accepted.accepted, $accepted.reason)
if ($accepted.accepted) {
  Write-Host "`n  --- English transcript as recognised ---" -ForegroundColor Yellow
  Write-Host ("  {0}" -f $accepted.text)
} else {
  Write-Host "  (chunk was dropped; nothing to translate)" -ForegroundColor Yellow
}

# Translation runs in a serialized queue after acceptance.
$state = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 1500
  $state = Invoke-Json "/state"
  if ($state.state.pending -eq 0 -and $state.state.translated -ge $state.state.total) { break }
}
Write-Host ("`n== state ==  total={0} translated={1} pending={2}" -f $state.state.total, $state.state.translated, $state.state.pending) -ForegroundColor Cyan
foreach ($segment in $state.state.segments) {
  Write-Host ("`n  [segment {0} @ {1}] state={2}" -f $segment.id, $segment.at, $segment.state)
  Write-Host ("  EN: {0}" -f $segment.text)
  if ($segment.translation) { Write-Host ("  ZH: {0}" -f $segment.translation) -ForegroundColor Green }
  if ($segment.error) { Write-Host ("  ERR: {0}" -f $segment.error) -ForegroundColor Red }
}

if (-not $Keep) {
  Write-Host "`n== clear ==" -ForegroundColor Cyan
  $cleared = Invoke-Json "/clear" "POST" "{}"
  Write-Host ("  ok={0}" -f $cleared.ok)
} else {
  Write-Host "`n(--Keep: session left in place for a review run)" -ForegroundColor DarkGray
}
