; Additions to the MFP installer (Tauri NSIS, bundle.windows.nsis.installerHooks).
;
; Language: the installer asks for it first (English / Russian) and then speaks it. The choice is
; written to lang.txt next to the program ("ru" or "en"); the app picks it up at startup as the
; interface language (apps/editor/src/i18n/index.ts, installerLang). An update (/UPDATE) leaves the
; file alone: the language is changed in the app (Settings → “Язык / Language”) or by reinstalling.

!macro NSIS_HOOK_POSTINSTALL
  ${If} $UpdateMode <> 1
    FileOpen $0 "$INSTDIR\lang.txt" w
    ${If} $LANGUAGE == 1049
      FileWrite $0 "ru"
    ${Else}
      FileWrite $0 "en"
    ${EndIf}
    FileClose $0
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    Delete "$INSTDIR\lang.txt"
  ${EndIf}
!macroend
