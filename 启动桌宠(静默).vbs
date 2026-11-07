' 启动桌宠（静默版）—— 双击或开机自启都不会闪黑框
'
' 原理：WScript 用 Run(..., 0, False) 以隐藏窗口方式跑 cmd，
' cmd 再去跑启动脚本；整个过程不创建可见窗口。
Option Explicit

Dim fso, shell, root, cmdPath
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
cmdPath = root & "\启动桌宠.cmd"

If Not fso.FileExists(cmdPath) Then
  MsgBox "找不到 启动桌宠.cmd：" & cmdPath, 16, "大肥鱼桌宠"
  WScript.Quit 1
End If

' 0 = 隐藏窗口，False = 不等它结束
shell.Run "cmd /c """"" & cmdPath & """""", 0, False
