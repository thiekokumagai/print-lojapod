@echo off
chcp 65001 >nul
echo ==============================================
echo INICIANDO BUILD DA LOJA POD...
echo ==============================================

taskkill /f /im "Loja Pod.exe" 2>nul
taskkill /f /im "print-agent-setup.exe" 2>nul

echo Incrementando a versao no package.json...
call npm version patch --no-git-tag-version

echo Limpando pasta dist anterior...
if exist dist rmdir /s /q dist

echo Executando build do Electron...
call npm run build

echo.
echo ==============================================
echo ATUALIZACAO CONCLUIDA COM SUCESSO!
echo O instalador print-agent-setup.exe foi gerado.
echo Abrindo a pasta dist...
echo ==============================================

explorer "dist"
pause
