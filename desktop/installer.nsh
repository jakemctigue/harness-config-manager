; Extra steps for the Windows installer (electron-builder includes this file).
;
; Adds Harness Config Manager to the "Open with" list for .mcpb and .dxt bundles WITHOUT making it
; the default app. The app's "Open in Claude Desktop" button hands a bundle to whatever app Windows
; opens .mcpb files with, so taking over the default would send that button back to this app.

!define SKM_PROGID "HarnessConfigManager.Bundle"

!macro customInstall
  WriteRegStr SHCTX "Software\Classes\${SKM_PROGID}" "" "MCP bundle"
  WriteRegStr SHCTX "Software\Classes\${SKM_PROGID}\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr SHCTX "Software\Classes\${SKM_PROGID}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr SHCTX "Software\Classes\.mcpb\OpenWithProgids" "${SKM_PROGID}" ""
  WriteRegStr SHCTX "Software\Classes\.dxt\OpenWithProgids" "${SKM_PROGID}" ""
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegValue SHCTX "Software\Classes\.mcpb\OpenWithProgids" "${SKM_PROGID}"
  DeleteRegValue SHCTX "Software\Classes\.dxt\OpenWithProgids" "${SKM_PROGID}"
  DeleteRegKey SHCTX "Software\Classes\${SKM_PROGID}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
