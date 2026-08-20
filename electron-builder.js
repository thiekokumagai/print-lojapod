module.exports = {
  appId: 'com.vapeshop.printagent',
  productName: 'Loja Pod',
  artifactName: 'print-agent-setup.exe',
  files: [
    '**/*',
    '.env',
    'icon.png'
  ],
  win: {
    target: 'nsis',
    icon: 'icon.ico',
    requestedExecutionLevel: 'asInvoker'
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    allowToChangeInstallationDirectory: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Loja Pod',
    installerIcon: 'icon.ico',
    uninstallerIcon: 'icon.ico'
  }
};
