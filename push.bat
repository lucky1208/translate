@echo off
title 推送到 GitHub
cd /d "%~dp0"
cls
echo.
echo   ==========================================
echo      推送到 github.com/lucky1208/translate
echo   ==========================================
echo.

where git >nul 2>nul
if errorlevel 1 (
    echo   [X] 没找到 git,先装一个:https://git-scm.com/download/win
    echo.
    pause & exit /b 1
)
if not exist ".git" (
    echo   [X] 当前目录不是 git 仓库。
    echo       请确认解压时保留了隐藏的 .git 文件夹。
    echo.
    pause & exit /b 1
)

echo   仓库已经提交好了,下面只需要推上去。
echo   Token 只在本次推送时使用,推完会从配置里清掉。
echo.
set /p TOKEN=  粘贴你的 GitHub Token 后回车: 
if "%TOKEN%"=="" (
    echo.
    echo   没输入 Token,已取消。
    pause & exit /b 1
)

echo.
echo   正在推送 ...
git remote set-url origin https://%TOKEN%@github.com/lucky1208/translate.git
git push -u origin main
set RC=%errorlevel%
git remote set-url origin https://github.com/lucky1208/translate.git

echo.
if "%RC%"=="0" (
    echo   [OK] 推送成功。
    echo.
    echo   接下来:
    echo     1. 打开 vercel.com 找到这个项目,它会自动开始部署
    echo     2. 部署完打开 https://你的项目.vercel.app
    echo     3. 右上角齿轮填密钥,点"测试连接"
    echo.
    echo   另外:这个 Token 已经在聊天里出现过,建议去
    echo   github.com/settings/tokens 把它删掉重建一个。
) else (
    echo   [X] 推送失败。常见原因:
    echo       - Token 没有 repo 权限
    echo       - 仓库里已有内容且和本地历史不一致,
    echo         那就改用:git push -u origin main --force
)
echo.
pause
