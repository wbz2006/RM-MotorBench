const path = require('node:path');
// Keep extracted build tools on the workspace volume (also works with redirected AppData).
process.env.ELECTRON_BUILDER_CACHE ??= path.join(__dirname, 'dist', '.builder-cache');

module.exports = {
  appId: 'cn.motorbench.host',
  productName: 'MotorBench',
  directories: { output: 'dist' },
  electronDist: 'node_modules/electron/dist',
  files: [
    'desktop.cjs', 'server.js', 'protocol.js',
    'index.html', 'style.css', 'ui.js', 'chart.js', 'fishbone.js',
    'setpoint.js', 'calculator.js', 'calculator-ui.js',
    'README.md', 'package.json',
  ],
  // N-API prebuilds ship with serialport; do not rebuild against Electron headers.
  npmRebuild: false,
  asar: true,
  asarUnpack: ['node_modules/@serialport/bindings-cpp/**'],
  win: {
    target: [{ target: 'portable', arch: ['x64'] }],
    artifactName: 'MotorBench-${version}-Windows-x64.exe',
    icon: 'assets/icon.ico',
    // Edit PE resources so the portable executable and taskbar use the app icon.
    signAndEditExecutable: true,
    // Preserve the existing unsigned release behavior while editing resources.
    signExecutable: false,
  },
};
