const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');

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
      webSecurity: true
    }
  });

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
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
