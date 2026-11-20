module.exports = {
  appId: 'com.vapeshop.printagent',
  productName: 'Podi Pedir',
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
    shortcutName: 'Podi Pedir',
    installerIcon: 'icon.ico',
    uninstallerIcon: 'icon.ico'
  }
};
