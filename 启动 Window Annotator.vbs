' 双击启动 Window Annotator(无终端窗口,后台驻留,看托盘红色 ✎ 图标)
Set sh = CreateObject("WScript.Shell")
sh.Run """D:\window-annotator\node_modules\electron\dist\electron.exe"" ""D:\window-annotator""", 0, False
