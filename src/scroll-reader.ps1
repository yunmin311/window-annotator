# Resident scroll reader: continuously feeds the foreground window's REAL vertical scroll to the main process.
# Spawned by main.js (via scroll-uia.js) when "follow page scroll" is on. windowsHide = silent.
# NOTE: ASCII-only on purpose. PowerShell 5.1 reads .ps1 as ANSI; non-ASCII comments get mangled into
#       broken quotes/braces and the whole script fails to parse (silent dead reader). Keep it ASCII.
# Output line:  S <hwnd> <percent> <viewsize> <viewportPx>   or   NA <hwnd>
#   percent    = VerticalScrollPercent (0..100 how far scrolled; -1 = not scrollable now)
#   viewsize   = VerticalViewSize (percent of content currently visible)
#   viewportPx = physical pixel height of the scrollable element (to infer total content height)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System; using System.Runtime.InteropServices;
public class Fg { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }
"@

$ae        = [System.Windows.Automation.AutomationElement]
$scrollPat = [System.Windows.Automation.ScrollPattern]::Pattern
$availProp = [System.Windows.Automation.AutomationElement]::IsScrollPatternAvailableProperty
$cond      = New-Object System.Windows.Automation.PropertyCondition($availProp, $true)
$treeSub   = [System.Windows.Automation.TreeScope]::Subtree
$out       = [Console]::Out

$lastH  = [IntPtr]::Zero
$el     = $null
$ticks  = 0
# Re-locate the scroll element about every REFIND ticks (~1.8s) even when the foreground window
# has not changed. This self-heals after in-page navigation (single-page web apps keep the same
# window handle), late-loading content, or an element that detached. Between re-finds the cached
# 45ms read still dominates, so CPU stays low. A non-scrollable window pays only one FindAll / 1.8s.
$REFIND = 40

# Locate the element to track for a given root window. A window can expose several scrollable
# elements (tiny popups, sidebars, the main content). Pick the LARGEST one that is actually
# scrolling now (VerticalViewSize < 99 => content taller than viewport); if none is scrolling yet,
# fall back to the largest scrollable overall. This reliably lands on the main content pane.
function Find-ScrollEl($root) {
  if ($root -eq $null) { return $null }
  if ([bool]$root.GetCurrentPropertyValue($availProp)) { return $root }
  $all = $root.FindAll($treeSub, $cond)
  $best = $null; $bestArea = -1        # largest among truly-scrolling (viewsize < 99)
  $any  = $null; $anyArea  = -1        # largest scrollable overall (fallback)
  foreach ($e in $all) {
    $rb = $null
    try { $rb = $e.Current.BoundingRectangle } catch { continue }
    if ($rb -eq $null -or $rb.IsEmpty) { continue }
    $area = $rb.Width * $rb.Height
    if ($area -gt $anyArea) { $anyArea = $area; $any = $e }
    $vs = 100.0
    try { $vs = $e.GetCurrentPattern($scrollPat).Current.VerticalViewSize } catch {}
    if ($vs -lt 99 -and $area -gt $bestArea) { $bestArea = $area; $best = $e }
  }
  if ($best -ne $null) { return $best }
  return $any
}

while ($true) {
  try {
    $h  = [Fg]::GetForegroundWindow()
    $hl = [int64]$h
    $ticks++

    # Re-find on a foreground change (immediately) or on the periodic self-heal tick. We deliberately
    # do NOT re-find just because $el is null, so a genuinely non-scrollable window (Notepad, a dialog)
    # does not run FindAll every 45ms.
    if (($h -ne $lastH) -or (($ticks % $REFIND) -eq 0)) {
      $lastH = $h
      $el = Find-ScrollEl ($ae::FromHandle($h))
    }

    if ($el -ne $null) {
      $c = $el.GetCurrentPattern($scrollPat).Current
      $h_px = 0.0
      $bad  = $false
      # if the cached element detached (rect empty / throws), drop it so the next self-heal re-finds
      try { $r = $el.Current.BoundingRectangle; if ($r.IsEmpty) { $bad = $true } else { $h_px = $r.Height } } catch { $bad = $true }
      if ($bad) {
        $el = $null
        $out.WriteLine("NA $hl")
      } else {
        $out.WriteLine(("S {0} {1:0.###} {2:0.###} {3:0.#}" -f $hl, $c.VerticalScrollPercent, $c.VerticalViewSize, $h_px))
      }
    } else {
      $out.WriteLine("NA $hl")
    }
    $out.Flush()
  } catch {
    # cached element went stale (page reflow / navigation): drop it, re-find next tick
    $lastH = [IntPtr]::Zero
    $el = $null
    try { $out.WriteLine("NA 0"); $out.Flush() } catch {}
  }
  Start-Sleep -Milliseconds 45
}
