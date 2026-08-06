' Launch Window Annotator (no console window; runs in background; look for the red pen tray icon).
' Uses the script's own folder, so there is no hardcoded drive/path -- works wherever the project lives.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
q = Chr(34)
sh.CurrentDirectory = dir
sh.Run q & dir & "\node_modules\electron\dist\electron.exe" & q & " " & q & dir & q, 0, False
