const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('node:path');
const { autoUpdater } = require('electron-updater');

let mainWindow = null;
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = false;

autoUpdater.on('update-downloaded', () => {
  mainWindow?.webContents.send('vyra:desktop-update-ready');
});
autoUpdater.on('error', error => {
  console.error('VYRA update check failed:', error?.message || error);
  mainWindow?.webContents.send('vyra:desktop-update-error', String(error?.message || error));
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
