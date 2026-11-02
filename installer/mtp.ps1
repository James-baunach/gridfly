<#
  GridFly mission installer for DJI Fly controllers connected over USB (MTP).

  DJI Fly keeps waypoint missions at
    <device>\<storage>\Android\data\dji.go.v5\files\waypoint\<UUID>\<UUID>.kmz
  MTP devices are not drive letters, so this goes through the Windows Shell (Shell.Application).

  Actions (all print one line of JSON):
    list                                         -> [{device, storage, missions:[{id, kmzName, modified, size}]}]
    fetch   -Device -Storage -Mission -Dest      -> copies the mission's KMZ into folder Dest
    install -Device -Storage -Mission -Source -Dest
            moves the existing KMZ into Dest (backup), then copies Source (named <Mission>.kmz) in its place
    create  -Device -Storage -Template -Mission -Source        (EXPERIMENTAL)
            makes folder waypoint\<Mission> and copies Source (named <Mission>.kmz) into it
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('list', 'fetch', 'install', 'create')][string]$Action,
  [string]$Device,
  [string]$Storage,
  [string]$Mission,
  [string]$Template,
  [string]$Source,
  [string]$Dest
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$WaypointPath = @('Android', 'data', 'dji.go.v5', 'files', 'waypoint')
$Silent = 4 + 16 + 1024   # no progress UI, yes to all, no error UI

function Out-Json($obj) {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $obj -Depth 6 -Compress))
}

function Get-Child($folderItem, [string]$name) {
  if (-not $folderItem -or -not $folderItem.IsFolder) { return $null }
  # Names may be shown without extensions when Explorer hides known file types.
  $stem = [IO.Path]::GetFileNameWithoutExtension($name)
  foreach ($i in $folderItem.GetFolder.Items()) {
    if ($i.Name -ieq $name) { return $i }
  }
  foreach ($i in $folderItem.GetFolder.Items()) {
    if (-not $i.IsFolder -and $i.Name -ieq $stem) { return $i }
  }
  return $null
}

function Resolve-Segments($item, [string[]]$segments) {
  $cur = $item
  foreach ($s in $segments) {
    $cur = Get-Child $cur $s
    if (-not $cur) { return $null }
  }
  return $cur
}

function Get-WaypointRoots {
  $shell = New-Object -ComObject Shell.Application
  foreach ($dev in $shell.Namespace(17).Items()) {          # 17 = This PC
    if (-not $dev.IsFolder) { continue }
    if ($dev.Path -match '^[A-Za-z]:\\?$') { continue }        # skip ordinary drives
    foreach ($st in $dev.GetFolder.Items()) {
      if (-not $st.IsFolder) { continue }
      $wp = Resolve-Segments $st $WaypointPath
      if ($wp) { [pscustomobject]@{ Device = $dev.Name; Storage = $st.Name; Item = $wp } }
    }
  }
}

function Find-Kmz($missionItem) {
  $id = $missionItem.Name
  $k = Get-Child $missionItem "$id.kmz"
  if ($k) { return $k }
  foreach ($i in $missionItem.GetFolder.Items()) {
    if (-not $i.IsFolder -and $i.Name -like '*.kmz') { return $i }
  }
  return $null
}

function Get-Root {
  $root = Get-WaypointRoots | Where-Object { $_.Device -eq $Device -and $_.Storage -eq $Storage } | Select-Object -First 1
  if (-not $root) { throw "Controller '$Device' ($Storage) not found. Is it still connected?" }
  return $root
}

function Get-MissionItem {
  $root = Get-Root
  $m = Get-Child $root.Item $Mission
  if (-not $m -or -not $m.IsFolder) { throw "Mission $Mission not found on the controller." }
  return $m
}

function Wait-For([scriptblock]$cond, [int]$seconds) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $seconds) {
    if (& $cond) { return $true }
    Start-Sleep -Milliseconds 300
  }
  return $false
}

function Copy-ToLocal($item, [string]$folder) {
  $shell = New-Object -ComObject Shell.Application
  $before = @(Get-ChildItem -LiteralPath $folder -Filter *.kmz -File).Count
  $shell.Namespace($folder).CopyHere($item, $Silent)
  $ok = Wait-For { $f = Get-ChildItem -LiteralPath $folder -Filter *.kmz -File | Select-Object -First 1; $f -and $f.Length -gt 0 -and @(Get-ChildItem -LiteralPath $folder -Filter *.kmz -File).Count -gt $before } 60
  if (-not $ok) { throw 'Timed out copying the mission from the controller.' }
  Start-Sleep -Milliseconds 500
  return (Get-ChildItem -LiteralPath $folder -Filter *.kmz -File | Select-Object -First 1).FullName
}

try {
  switch ($Action) {
    'list' {
      $out = @()
      foreach ($r in Get-WaypointRoots) {
        $missions = @()
        foreach ($m in $r.Item.GetFolder.Items()) {
          if (-not $m.IsFolder -or $m.Name -notmatch '^[0-9A-Fa-f]{8}-[0-9A-Fa-f-]{27}$') { continue }
          $k = Find-Kmz $m
          if (-not $k) { continue }
          $modified = $null
          try { $modified = ([datetime]$k.ModifyDate).ToString('o') } catch { }
          $kn = [string]$k.Name
          if ($kn -notlike '*.kmz') { $kn += '.kmz' }
          $missions += [pscustomobject]@{ id = $m.Name; kmzName = $kn; modified = $modified; size = $k.Size }
        }
        $out += [pscustomobject]@{ device = $r.Device; storage = $r.Storage; missions = $missions }
      }
      Out-Json @($out)
    }

    'fetch' {
      $k = Find-Kmz (Get-MissionItem)
      if (-not $k) { throw 'The mission folder has no KMZ file.' }
      Out-Json @{ path = (Copy-ToLocal $k $Dest) }
    }

    'install' {
      if (-not (Test-Path -LiteralPath $Source)) { throw "Source file not found: $Source" }
      $m = Get-MissionItem
      $expected = (Get-Item -LiteralPath $Source).Length
      $warning = $null
      $backup = $null

      $existing = Find-Kmz $m
      if ($existing) {
        # Keep a copy on the PC, then move the original off the device so the new file
        # does not trigger a "replace file?" prompt.
        $backup = Copy-ToLocal $existing $Dest
        $shell = New-Object -ComObject Shell.Application
        $trash = Join-Path $Dest 'moved'
        New-Item -ItemType Directory -Force -Path $trash | Out-Null
        $shell.Namespace($trash).MoveHere($existing, $Silent)
        $gone = Wait-For { -not (Find-Kmz (Get-MissionItem)) } 30
        if (-not $gone) { $warning = 'Windows may ask to replace the existing file; choose Replace.' }
      }

      $m = Get-MissionItem
      $m.GetFolder.CopyHere($Source, $Silent)
      $ok = Wait-For { $k = Find-Kmz (Get-MissionItem); $k -and [int64]$k.Size -eq $expected } 120
      if (-not $ok) { throw 'Timed out waiting for the copy to the controller to finish. Check the file manually.' }
      Out-Json @{ ok = $true; backup = $backup; warning = $warning }
    }

    'create' {
      if (-not (Test-Path -LiteralPath $Source)) { throw "Source file not found: $Source" }
      if ((Get-Item -LiteralPath $Source).Name -ine "$Mission.kmz") { throw "Source must be named $Mission.kmz" }
      $expected = (Get-Item -LiteralPath $Source).Length
      $root = Get-Root
      if (-not (Get-Child $root.Item $Template)) { throw "Template mission $Template not found on the controller." }
      if (Get-Child $root.Item $Mission) { throw "Mission $Mission already exists." }
      $root.Item.GetFolder.NewFolder($Mission)
      $made = Wait-For { $m = Get-Child (Get-Root).Item $Mission; $m -and $m.IsFolder } 15
      if (-not $made) { throw 'The controller did not create the mission folder (MTP may not allow new folders).' }
      (Get-MissionItem).GetFolder.CopyHere($Source, $Silent)
      $ok = Wait-For { $k = Find-Kmz (Get-MissionItem); $k -and [int64]$k.Size -eq $expected } 120
      if (-not $ok) { throw 'Timed out waiting for the copy to the controller to finish. Check the file manually.' }
      Out-Json @{ ok = $true; id = $Mission }
    }
  }
  exit 0
}
catch {
  Out-Json @{ error = $_.Exception.Message }
  exit 1
}
