REM WARNING: this opens an UNAUTHENTICATED DevTools port on 127.0.0.1.
REM Anything running as your user can drive the app while it is up - use it only
on a machine you control, and use the ordinary launcher when you are done.
' Restart DeepSeek Harness with its Chromium DevTools endpoint enabled.
' Windowless launcher: no console flashes. Double-click the matching .lnk.
Option Explicit
Dim sh, exe, port, cmd, i
Set sh = CreateObject("WScript.Shell")

exe = "D:\deepseek\dsh_windows\file\DeepSeek Harness.exe"
port = 9222

' 1. Stop any running instance (single-instance lock would swallow the flags otherwise).
sh.Run "taskkill /F /IM ""DeepSeek Harness.exe""", 0, True

' 2. Wait until the process image is really gone (max ~15s).
For i = 1 To 15
  If sh.Run("cmd /c tasklist /FI ""IMAGENAME eq DeepSeek Harness.exe"" | find /I ""DeepSeek Harness.exe""", 0, True) <> 0 Then Exit For
  WScript.Sleep 1000
Next

' 3. Start it with the DevTools endpoint.
cmd = """" & exe & """ --remote-debugging-port=" & port
sh.Run cmd, 1, False
