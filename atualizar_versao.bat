@echo off
echo ==============================================
echo 🚀 INICIANDO BUILD DA LOJA POD...
echo ==============================================

taskkill /f /im "Loja Pod.exe" 2>nul
taskkill /f /im "print-agent-setup.exe" 2>nul

call npm run build

echo.
echo ==============================================
echo ✅ ATUALIZACAO CONCLUIDA COM SUCESSO!
echo O instalador print-agent-setup.exe foi gerado.
echo Abrindo a pasta dist para voce copiar para o Google Drive...
echo ==============================================

explorer "dist"
pause
