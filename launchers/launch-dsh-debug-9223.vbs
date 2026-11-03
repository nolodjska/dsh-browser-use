' Restart DeepSeek Harness with a DevTools endpoint on a free port.
' Fallback for when 9222 is still held by a dying instance: TCP accepts the
' connection but never answers, so the endpoint looks alive and is not.
Option Explicit
Dim sh, exe, port, cmd, i
Set sh = CreateObject("WScript.Shell")

exe = "D:\deepseek\dsh_windows\file\DeepSeek Harness.exe"
port = 9223

sh.Run "taskkill /F /IM ""DeepSeek Harness.exe""", 0, True

For i = 1 To 15
  If sh.Run("cmd /c tasklist /FI ""IMAGENAME eq DeepSeek Harness.exe"" | find /I ""DeepSeek Harness.exe""", 0, True) <> 0 Then Exit For
  WScript.Sleep 1000
Next

' Give the kernel a moment to release the old listening socket.
WScript.Sleep 2000

cmd = """" & exe & """ --remote-debugging-port=" & port
sh.Run cmd, 1, False
