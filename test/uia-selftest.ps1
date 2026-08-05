# Self-test: can UIA read REAL scroll from someone else's window? Fully automatic (no human scrolling).
# Steps: open a very tall page (default browser) -> find scrollable element -> read at top
#        -> scroll to 50% via UIA -> read again -> infer total content height.
# Expect: a scrollable element is found; percent goes ~0 -> ~50; viewsize is small (long page).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@

$html = "<!doctype html><html><body style='margin:0;font:20px sans-serif'>" +
        "<div style='position:fixed;top:0;left:0;background:yellow'>TOP</div>" +
        "<div style='height:8000px;background:linear-gradient(#eef,#334)'></div>" +
        "<div style='background:orange'>BOTTOM</div></body></html>"
$tmp = Join-Path $env:TEMP 'uia-tall.html'
Set-Content -LiteralPath $tmp -Value $html -Encoding UTF8
Write-Host "opening $tmp in default browser..."
Start-Process $tmp
Start-Sleep -Seconds 6   # let browser start + build accessibility tree (Chrome builds it lazily on UIA request)

$ae        = [System.Windows.Automation.AutomationElement]
$scrollPat = [System.Windows.Automation.ScrollPattern]::Pattern
$availProp = [System.Windows.Automation.AutomationElement]::IsScrollPatternAvailableProperty
$cond      = New-Object System.Windows.Automation.PropertyCondition($availProp, $true)
$NoScroll  = [System.Windows.Automation.ScrollPattern]::NoScroll

$h  = [Fg]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 256
[Fg]::GetWindowText($h, $sb, 256) | Out-Null
Write-Host ("foreground: hwnd={0} title='{1}'" -f $h, $sb.ToString())

$root = $ae::FromHandle([IntPtr]$h)
$el = $null
if ($root -ne $null) {
  if ([bool]$root.GetCurrentPropertyValue($availProp)) { $el = $root; Write-Host "root itself is scrollable" }
  else {
    for ($try = 0; $try -lt 5 -and $el -eq $null; $try++) {
      $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $cond)
      if ($el -eq $null) { Start-Sleep -Milliseconds 700 }
    }
    Write-Host ("found scrollable element in subtree = {0}" -f ($el -ne $null))
  }
}
if ($el -eq $null) { Write-Host "RESULT: UIA found NO scrollable element in this window -- this path does not work here"; exit 0 }

$c = $el.GetCurrentPattern($scrollPat).Current
$r = $el.Current.BoundingRectangle
Write-Host ("scroll element name='{0}'" -f $el.Current.Name)
Write-Host ("AT TOP : percent={0:0.###}  viewsize={1:0.###}  boundH={2:0.#}px" -f $c.VerticalScrollPercent, $c.VerticalViewSize, $r.Height)

try {
  $el.GetCurrentPattern($scrollPat).SetScrollPercent($NoScroll, 50)
  Write-Host "SetScrollPercent(,50) call ok"
} catch { Write-Host ("SetScrollPercent failed: {0}" -f $_.Exception.Message) }
Start-Sleep -Milliseconds 900

$c2 = $el.GetCurrentPattern($scrollPat).Current
Write-Host ("AT 50% : percent={0:0.###}  viewsize={1:0.###}" -f $c2.VerticalScrollPercent, $c2.VerticalViewSize)

if ($c2.VerticalViewSize -gt 0.001) {
  $contentPx = $r.Height / ($c2.VerticalViewSize / 100)
  $scrollablePx = $contentPx - $r.Height
  $offsetAt50 = ($c2.VerticalScrollPercent / 100) * $scrollablePx
  Write-Host ("INFER: content height ~= {0:0}px  scrollable ~= {1:0}px  offset@50 ~= {2:0}px" -f $contentPx, $scrollablePx, $offsetAt50)
  Write-Host "(page is 8000px tall; viewport ~ few hundred to ~1000px; inferred content height should be in that ballpark if read correctly)"
}
Write-Host "DONE"
