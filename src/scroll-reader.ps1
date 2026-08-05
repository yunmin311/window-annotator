# Resident scroll reader (MULTI-REGION): feeds the foreground window's scrollable regions to the main
# process. Each region = one UIA ScrollPattern element (the page, a sidebar, a pane...). The main
# process picks, per annotation, which region it sits on and follows THAT region's scroll.
# Output line:  S <hwnd>|<x>,<y>,<w>,<h>,<vpct>,<vvs>|<x>,<y>,<w>,<h>,<vpct>,<vvs>   or   NA <hwnd>
#   x,y,w,h = region rect in PHYSICAL pixels; vpct = VerticalScrollPercent; vvs = VerticalViewSize.
# Finding regions is slow, so we cache the region ELEMENTS and only re-enumerate on a foreground change
# or a periodic self-heal tick; each 45ms frame just re-reads the cached elements' scroll+rect (cheap).
# NOTE: ASCII-only on purpose. PS5.1 reads .ps1 as ANSI; non-ASCII comments get mangled and the whole
#       script fails to parse (silent dead reader). Keep it ASCII.
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
$els    = @()
$ticks  = 0
$REFIND = 90   # re-enumerate regions ~every 4s. FindAll over a big tree (browsers) is expensive, so keep
               # it infrequent; foreground changes still re-enumerate immediately. Self-heals new panes / SPA nav.

# Find the scrollable regions worth tracking: has ScrollPattern, big enough (drop tiny inline noise),
# and on-screen relative to the window. Returns the UIA elements (re-read each frame). Slow -> cached.
function Find-Regions($root) {
  if ($root -eq $null) { return @() }
  $wr = $null
  try { $wr = $root.Current.BoundingRectangle } catch {}
  $all = $root.FindAll($treeSub, $cond)
  $res = @()
  foreach ($e in $all) {
    $rb = $null
    try { $rb = $e.Current.BoundingRectangle } catch { continue }
    if ($rb -eq $null -or $rb.IsEmpty) { continue }
    if ($rb.Width -lt 60 -or $rb.Height -lt 60) { continue }              # drop slivers / 2-3px noise
    if (($rb.Width * $rb.Height) -lt 10000) { continue }
    if ($wr -ne $null -and -not $wr.IsEmpty) {                            # drop off-screen (center outside window)
      $cx = $rb.X + $rb.Width / 2; $cy = $rb.Y + $rb.Height / 2
      if ($cx -lt $wr.X -or $cx -gt ($wr.X + $wr.Width) -or $cy -lt $wr.Y -or $cy -gt ($wr.Y + $wr.Height)) { continue }
    }
    $res += $e
  }
  return $res
}

while ($true) {
  try {
    $h  = [Fg]::GetForegroundWindow()
    $hl = [int64]$h
    $ticks++

    if (($h -ne $lastH) -or (($ticks % $REFIND) -eq 0)) {
      $lastH = $h
      $els = Find-Regions ($ae::FromHandle($h))
    }

    $parts = @()
    $bad = $false
    foreach ($e in $els) {
      try {
        $sp  = $e.GetCurrentPattern($scrollPat).Current
        $vvs = $sp.VerticalViewSize
        if ($vvs -ge 99.5) { continue }                                  # not actually scrolling right now
        $rb = $e.Current.BoundingRectangle
        if ($rb.IsEmpty) { $bad = $true; continue }
        $parts += ("{0:0},{1:0},{2:0},{3:0},{4:0.###},{5:0.###}" -f $rb.X, $rb.Y, $rb.Width, $rb.Height, $sp.VerticalScrollPercent, $vvs)
      } catch { $bad = $true }
    }
    if ($bad) { $lastH = [IntPtr]::Zero }                                # something detached: re-enumerate next tick

    if ($parts.Count -gt 0) { $out.WriteLine("S $hl|" + ($parts -join "|")) }
    else { $out.WriteLine("NA $hl") }
    $out.Flush()
  } catch {
    $lastH = [IntPtr]::Zero
    $els = @()
    try { $out.WriteLine("NA 0"); $out.Flush() } catch {}
  }
  Start-Sleep -Milliseconds 45
}
