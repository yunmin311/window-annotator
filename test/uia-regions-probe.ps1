param([long]$Hwnd = 0, [int]$Delay = 0)
# Diagnostic for multi-region follow: enumerate EVERY scrollable region of a window and print each
# one's rect + vertical/horizontal scroll. Usage:
#   -Delay 5   : count down 5s (switch to the app/pane you want to test), then read the FOREGROUND window.
#   -Hwnd <h>  : read a specific window by handle (note: background Chromium windows expose an empty tree).
#   (neither)  : read the current foreground window immediately.
# ASCII-only on purpose (PS5.1 reads .ps1 as ANSI; non-ASCII comments break parsing).
if ($Delay -gt 0) {
  for ($s = $Delay; $s -gt 0; $s--) { Write-Host ("Switch to the window/pane you want to test... {0}" -f $s); Start-Sleep -Seconds 1 }
}
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

if ($Hwnd -ne 0) { $h = [IntPtr]$Hwnd } else { $h = [Fg]::GetForegroundWindow() }
$root = $ae::FromHandle($h)
if ($root -eq $null) { Write-Output "NOROOT"; exit }
$rn = ""
try { $rn = $root.Current.Name } catch {}
Write-Output ("WIN hwnd={0} root='{1}'" -f ([int64]$h), $rn)

$all = $root.FindAll($treeSub, $cond)
Write-Output ("FOUND {0}" -f $all.Count)
$i = 0
foreach ($e in $all) {
  $rb = $null
  try { $rb = $e.Current.BoundingRectangle } catch {}
  if ($rb -eq $null -or $rb.IsEmpty) { continue }
  $sp = $null
  try { $sp = $e.GetCurrentPattern($scrollPat).Current } catch {}
  if ($sp -eq $null) { continue }
  $ct = ""
  try { $ct = $e.Current.ControlType.ProgrammaticName } catch {}
  Write-Output ("REGION {0} x={1:0} y={2:0} w={3:0} h={4:0} vpct={5:0.#} vvs={6:0.#} hpct={7:0.#} hvs={8:0.#} type={9}" -f `
    $i, $rb.X, $rb.Y, $rb.Width, $rb.Height, $sp.VerticalScrollPercent, $sp.VerticalViewSize, `
    $sp.HorizontalScrollPercent, $sp.HorizontalViewSize, $ct)
  $i++
}
Write-Output "DONE"
