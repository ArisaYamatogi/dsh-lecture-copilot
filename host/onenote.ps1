# Local OneNote bridge for Lecture Copilot.
#
# Reads one JSON request on stdin and writes one JSON reply on stdout, so the
# Host never has to quote a payload into a command line and the note text can be
# arbitrary. OneNote is driven through its COM automation interface, which is the
# only local, credential-free way to write into a desktop notebook.
#
#   {"op":"list"}
#     -> {"ok":true,"notebooks":[{"id","name","sections":[{"id","name","pages":[{"id","name"}]}]}]}
#   {"op":"create","sectionId":…,"title":…,"body":…}
#     -> {"ok":true,"pageId":…,"pageName":…,"url":…}
#   {"op":"update","pageId":…,"title":…,"body":…}
#     -> {"ok":true,"pageId":…,"pageName":…,"url":…}
#
# `body` is the OneNote XML for the page body (one:Outline), produced by the Host.

$ErrorActionPreference = 'Stop'
# Both directions carry UTF-8. Windows PowerShell otherwise decodes stdin with
# the system ANSI code page, which turns every Chinese character in the note into
# mojibake and then hands OneNote XML it rejects with 0x80042000.
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding

function Reply($payload) {
  $json = $payload | ConvertTo-Json -Depth 12 -Compress
  [Console]::Out.Write($json)
  exit 0
}

function Fail($message) {
  [Console]::Out.Write((@{ ok = $false; error = $message } | ConvertTo-Json -Compress))
  exit 0
}

# OneNote's XML schema version used when writing: 2 = xs2013.
$XS = 2
# GetHierarchy's second argument is the *hierarchy scope*, not the schema.
# 4 = hsPages, the only scope that includes pages; 1/2 return notebooks only.
$HS_PAGES = 4

try {
  $raw = [Console]::In.ReadToEnd()
  $request = $raw | ConvertFrom-Json
} catch {
  Fail "bad request: $($_.Exception.Message)"
}

try {
  $one = New-Object -ComObject OneNote.Application
} catch {
  Fail "OneNote is not available on this machine: $($_.Exception.Message)"
}

function GetNotebooks {
  $xml = ''
  $one.GetHierarchy('', $HS_PAGES, [ref]$xml)
  $tree = [xml]$xml
  $out = @()
  foreach ($nb in @($tree.Notebooks.Notebook)) {
    # @() everywhere: PowerShell collapses a one-element node list to a scalar,
    # which silently turns a single-section notebook into no sections at all.
    $sections = @()
    foreach ($sec in @($nb.Section)) {
      $pages = @()
      foreach ($pg in @($sec.Page)) {
        $pages += @{ id = $pg.ID; name = $pg.name }
      }
      $sections += @{ id = $sec.ID; name = $sec.name; pages = $pages }
    }
    $out += @{ id = $nb.ID; name = $nb.name; sections = $sections }
  }
  return $out
}

# OneNote's short id for a page, used to build the desktop deep link.
function GetPageUrl($pageId) {
  try {
    $url = ''
    $one.GetHyperlinkToObject($pageId, '', [ref]$url)
    return $url
  } catch {
    return ''
  }
}

function BuildPageXml($title, $pageId, $bodyXml) {
  $ns = 'http://schemas.microsoft.com/office/onenote/2013/onenote'
  $titleCdata = '<![CDATA[' + $title.Replace(']]>', ']]]]><![CDATA[>') + ']]>'
  $idAttr = if ($pageId) { " ID=`"$pageId`"" } else { '' }
  return @"
<?xml version="1.0"?>
<one:Page xmlns:one="$ns"$idAttr>
  <one:Title><one:OE><one:T>$titleCdata</one:T></one:OE></one:Title>
  $bodyXml
</one:Page>
"@
}

# Read one page exactly as OneNote has it, so an append cannot lose anything.
function GetPageXml($pageId) {
  $content = ''
  $one.GetPageContent($pageId, [ref]$content, $XS)
  return $content
}

function GetPageName($pageId) {
  try { return ([xml](GetPageXml $pageId)).Page.name } catch { return '' }
}

# A page title reads better as real content than as metadata alone, so the
# append also writes a timestamped heading into the body.
function BuildStampOutline($title) {
  $ns = 'http://schemas.microsoft.com/office/onenote/2013/onenote'
  $cdata = '<![CDATA[' + $title.Replace(']]>', ']]]]><![CDATA[>') + ']]>'
  return "<one:Outline><one:OEChildren><one:OE><one:T>$cdata</one:T></one:OE></one:OEChildren></one:Outline>"
}

switch ($request.op) {
  'list' {
    Reply @{ ok = $true; notebooks = (GetNotebooks) }
  }

  'create' {
    if (-not $request.sectionId) { Fail 'sectionId is required' }
    $pageId = ''
    $one.CreateNewPage($request.sectionId, [ref]$pageId, 0)
    # Send the real page element with its ID: a bare outline leaves the new page
    # titled 无标题页, and OneNote accepts the full form for an existing page.
    $xml = BuildPageXml $request.title $pageId $request.body
    # Positional arguments only. OneNote's type library is not registered on a
    # typical install, so PowerShell cannot resolve parameter names: a named
    # hashtable arrives as one positional value and OneNote rejects it with the
    # opaque HRESULT 0x80042000.
    $one.UpdatePageContent($xml, $XS)
    $name = GetPageName $pageId
    if (-not $name -or $name -eq '无标题页') {
      # Some builds ignore the Title element on a fresh page; retitle in a second
      # pass so a created page never keeps OneNote's placeholder name.
      try {
        $retitle = BuildPageXml $request.title $pageId $request.body
        $one.UpdatePageContent($retitle, $XS)
        $name = GetPageName $pageId
      } catch { }
    }
    Reply @{ ok = $true; pageId = $pageId; pageName = $name; url = (GetPageUrl $pageId) }
  }

  'append' {
    if (-not $request.pageId) { Fail 'pageId is required' }
    # Read first, then write the page back with one more outline. OneNote keeps
    # every element the page already had, so this only ever adds content.
    $current = GetPageXml $request.pageId
    if (-not $current -or $current.IndexOf('</one:Page>') -lt 0) { Fail 'the target page could not be read, so nothing was written' }
    $addition = (BuildStampOutline $request.stamp) + $request.body
    $merged = $current.Replace('</one:Page>', $addition + '</one:Page>')
    $one.UpdatePageContent($merged, $XS)
    Reply @{
      ok       = $true
      pageId   = $request.pageId
      pageName = (GetPageName $request.pageId)
      url      = (GetPageUrl $request.pageId)
      mode     = 'append'
    }
  }

  'read' {
    if (-not $request.pageId) { Fail 'pageId is required' }
    $content = GetPageXml $request.pageId
    # Return the plain text of every text element, so a caller can measure a page
    # without parsing OneNote's XML itself.
    $texts = @()
    try {
      $doc = [xml]$content
      foreach ($oe in @($doc.Page.Outline.OEChildren.OE)) {
        foreach ($t in @($oe.T)) { $texts += [string]$t.'#cdata-section' }
      }
    } catch {
      Fail "could not parse the page: $($_.Exception.Message)"
    }
    Reply @{
      ok       = $true
      pageId   = $request.pageId
      pageName = ([xml]$content).Page.name
      text     = ($texts -join "`n")
      elements = $texts.Count
    }
  }

  default {
    Fail "unknown op: $($request.op)"
  }
}
