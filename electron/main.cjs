const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('node:path');
const { autoUpdater } = require('electron-updater');

let mainWindow = null;
let downloadedUpdateVersion = null;
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = false;

function sendUpdateStatus(status, extra = {}) {
  mainWindow?.webContents.send('vyra:desktop-update-status', { status, ...extra });
}

autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
autoUpdater.on('update-available', info => sendUpdateStatus('available', {
  version: info.version,
  message: `VYRA v${info.version} was found. Downloading automatically…`
}));
autoUpdater.on('update-not-available', info => sendUpdateStatus('latest', {
  version: info.version,
  message: `VYRA v${info.version} is already installed.`
}));
autoUpdater.on('download-progress', progress => sendUpdateStatus('downloading', {
  percent: Math.round(progress.percent)
}));
autoUpdater.on('update-downloaded', info => {
  downloadedUpdateVersion = info.version;
  sendUpdateStatus('ready', { version: info.version });
  mainWindow?.webContents.send('vyra:desktop-update-ready');
});
autoUpdater.on('error', error => {
  const message = String(error?.message || error);
  console.error('VYRA update check failed:', message);
  sendUpdateStatus('error', { message });
  mainWindow?.webContents.send('vyra:desktop-update-error', message);
});

ipcMain.on('vyra:check-for-updates', async () => {
  if (!app.isPackaged || process.platform !== 'win32') {
    sendUpdateStatus('error', { message: 'The Windows updater is available in the installed VYRA desktop app only.' });
    return;
  }
  if (downloadedUpdateVersion) {
    sendUpdateStatus('ready', { version: downloadedUpdateVersion });
    return;
  }
  try {
    await autoUpdater.checkForUpdates();
    if (downloadedUpdateVersion) sendUpdateStatus('ready', { version: downloadedUpdateVersion });
  } catch (error) {
    const message = String(error?.message || error);
    sendUpdateStatus('error', { message });
  }
});
ipcMain.on('vyra:install-update', () => {
  if (app.isPackaged && process.platform === 'win32') autoUpdater.quitAndInstall(false, true);
});

app.setAppUserModelId('com.vyra.social');

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 360,
    minHeight: 620,
    backgroundColor: '#0B1020',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  mainWindow = win;
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url).catch(() => undefined);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const dev = !app.isPackaged && url.startsWith('http://localhost:5173');
    const packaged = app.isPackaged && url.startsWith('file://');
    if (!dev && !packaged) event.preventDefault();
  });

  if (app.isPackaged) win.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
  else win.loadURL('http://localhost:5173');
}

app.whenReady().then(() => {
  createWindow();
  if (app.isPackaged && process.platform === 'win32') {
    setTimeout(() => autoUpdater.checkForUpdates().catch(error => {
      console.error('VYRA update check failed:', error?.message || error);
    }), 10000);
    setInterval(() => autoUpdater.checkForUpdates().catch(error => {
      console.error('VYRA update check failed:', error?.message || error);
    }), 4 * 60 * 60 * 1000);
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
