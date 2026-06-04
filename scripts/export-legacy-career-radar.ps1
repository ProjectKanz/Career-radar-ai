param(
  [Parameter(Mandatory = $true)]
  [string]$XlsxPath,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

Add-Type -AssemblyName System.IO.Compression.FileSystem

$targetSheets = @(
  'Profile',
  'Career_Radar',
  'Application_Pack',
  'CV_Edit_Checklist',
  'Daily_Apply_Brief',
  'CV_Evidence_Bank',
  'Job_Search_Raw'
)

function Read-ZipText($zip, [string]$name) {
  $entry = $zip.GetEntry($name)
  if (-not $entry) {
    return $null
  }

  $reader = [System.IO.StreamReader]::new($entry.Open())
  try {
    return $reader.ReadToEnd()
  } finally {
    $reader.Dispose()
  }
}

function Get-ColumnIndex([string]$cellRef) {
  $letters = ($cellRef -replace '[0-9]', '').ToUpperInvariant()
  $index = 0

  foreach ($char in $letters.ToCharArray()) {
    $index = ($index * 26) + ([int][char]$char - [int][char]'A') + 1
  }

  return $index - 1
}

function Get-CellText($cell, $sharedStrings) {
  $type = $cell.GetAttribute('t')
  $valueNode = $cell.SelectSingleNode('./*[local-name()="v"]')

  if ($type -eq 's' -and $valueNode) {
    return [string]$sharedStrings[[int]$valueNode.InnerText]
  }

  if ($type -eq 'inlineStr') {
    $textNode = $cell.SelectSingleNode('.//*[local-name()="t"]')
    if ($textNode) {
      return [string]$textNode.InnerText
    }
  }

  if ($valueNode) {
    return [string]$valueNode.InnerText
  }

  return ''
}

function Read-SheetRows($sheetXml, $sharedStrings) {
  $rows = @()

  foreach ($row in $sheetXml.SelectNodes('//*[local-name()="sheetData"]/*[local-name()="row"]')) {
    $values = @()
    foreach ($cell in $row.SelectNodes('./*[local-name()="c"]')) {
      $cellRef = $cell.GetAttribute('r')
      $index = Get-ColumnIndex $cellRef
      while ($values.Count -le $index) {
        $values += ''
      }
      $values[$index] = (Get-CellText $cell $sharedStrings).Trim()
    }

    if ((($values -join '').Trim()).Length -gt 0) {
      $rows += ,$values
    }
  }

  return $rows
}

$zip = [System.IO.Compression.ZipFile]::OpenRead($XlsxPath)

try {
  [xml]$workbookXml = Read-ZipText $zip 'xl/workbook.xml'
  [xml]$relsXml = Read-ZipText $zip 'xl/_rels/workbook.xml.rels'
  [xml]$sharedXml = Read-ZipText $zip 'xl/sharedStrings.xml'

  $sharedStrings = @()
  foreach ($si in $sharedXml.SelectNodes('//*[local-name()="si"]')) {
    $sharedStrings += $si.InnerText
  }

  $relationshipTargets = @{}
  foreach ($relationship in $relsXml.SelectNodes('//*[local-name()="Relationship"]')) {
    $target = $relationship.Target
    if ($target.StartsWith('/')) {
      $target = $target.TrimStart('/')
    } elseif (-not $target.StartsWith('xl/')) {
      $target = "xl/$target"
    }
    $relationshipTargets[$relationship.Id] = $target
  }

  $sheets = @{}
  $counts = @{}

  foreach ($sheet in $workbookXml.SelectNodes('//*[local-name()="sheet"]')) {
    $sheetName = [string]$sheet.name
    if ($targetSheets -notcontains $sheetName) {
      continue
    }

    $relationshipId = $sheet.GetAttribute('id', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
    $target = $relationshipTargets[$relationshipId]
    [xml]$sheetXml = Read-ZipText $zip $target

    $rows = Read-SheetRows $sheetXml $sharedStrings
    if ($rows.Count -eq 0) {
      $sheets[$sheetName] = @()
      $counts[$sheetName] = 0
      continue
    }

    $headers = $rows[0]
    $objects = @()

    foreach ($row in ($rows | Select-Object -Skip 1)) {
      $object = [ordered]@{}
      $hasValue = $false

      for ($i = 0; $i -lt $headers.Count; $i++) {
        $header = [string]$headers[$i]
        if (-not $header) {
          continue
        }

        $value = ''
        if ($i -lt $row.Count) {
          $value = [string]$row[$i]
        }

        if ($value.Trim()) {
          $hasValue = $true
        }

        $object[$header] = $value
      }

      if ($hasValue) {
        $objects += [pscustomobject]$object
      }
    }

    $sheets[$sheetName] = $objects
    $counts[$sheetName] = $objects.Count
  }

  $payload = [ordered]@{
    exportedAt = (Get-Date).ToUniversalTime().ToString('o')
    sourceFile = $XlsxPath
    counts = $counts
    sheets = $sheets
  }

  $outputDirectory = Split-Path -Parent $OutputPath
  if ($outputDirectory -and -not (Test-Path $outputDirectory)) {
    New-Item -ItemType Directory -Path $outputDirectory | Out-Null
  }

  $payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
  Write-Output "Exported legacy Career Radar data to $OutputPath"
  $counts.GetEnumerator() | Sort-Object Name | ForEach-Object {
    Write-Output "$($_.Name): $($_.Value)"
  }
} finally {
  $zip.Dispose()
}
