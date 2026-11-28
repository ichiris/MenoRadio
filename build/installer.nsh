!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!ifndef BUILD_UNINSTALLER
  Var DesktopShortcutDialog
  Var DesktopShortcutCheckbox
  Var CreateDesktopShortcutState
!endif

!macro customInit
  !ifndef BUILD_UNINSTALLER
    StrCpy $CreateDesktopShortcutState ${BST_CHECKED}
  !endif
!macroend

!macro customPageAfterChangeDir
  !ifndef BUILD_UNINSTALLER
    Page custom DesktopShortcutPageCreate DesktopShortcutPageLeave

    Function DesktopShortcutPageCreate
      ${If} $LANGUAGE == 2052
        StrCpy $0 "附加选项"
        StrCpy $1 "创建桌面快捷方式"
      ${ElseIf} $LANGUAGE == 1028
        StrCpy $0 "附加選項"
        StrCpy $1 "建立桌面捷徑"
      ${ElseIf} $LANGUAGE == 1041
        StrCpy $0 "追加オプション"
        StrCpy $1 "デスクトップにショートカットを作成"
      ${Else}
        StrCpy $0 "Additional Options"
        StrCpy $1 "Create desktop shortcut"
      ${EndIf}

      !insertmacro MUI_HEADER_TEXT "$0" ""

      nsDialogs::Create 1018
      Pop $DesktopShortcutDialog
      ${If} $DesktopShortcutDialog == error
        Abort
      ${EndIf}

      ${NSD_CreateCheckbox} 0 12u 100% 12u "$1"
      Pop $DesktopShortcutCheckbox

      ${If} $CreateDesktopShortcutState == ${BST_CHECKED}
        ${NSD_Check} $DesktopShortcutCheckbox
      ${Else}
        ${NSD_Uncheck} $DesktopShortcutCheckbox
      ${EndIf}

      nsDialogs::Show
    FunctionEnd

    Function DesktopShortcutPageLeave
      ${NSD_GetState} $DesktopShortcutCheckbox $CreateDesktopShortcutState
    FunctionEnd
  !endif
!macroend

!macro customInstall
  !ifndef BUILD_UNINSTALLER
    ${If} $CreateDesktopShortcutState == ${BST_CHECKED}
      CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"
      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
    ${EndIf}
  !endif
!macroend

!macro customUnInstall
  WinShell::UninstShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk"
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
!macroend
