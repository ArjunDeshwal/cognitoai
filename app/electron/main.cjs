const { app, BrowserWindow, ipcMain, dialog, session, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

let mainWindow;
let pythonProcess = null;
let backendConfig = null;

const isDev = !app.isPackaged;
const productionRendererRoot = pathToFileURL(path.join(__dirname, '../dist') + path.sep).href;

// === DEBUG LOGGING FOR PACKAGED BUILDS ===
const logFile = isDev ? null : path.join(app.getPath('userData'), 'cognito-debug.log');

function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  console.log(message);
  if (logFile) {
    fs.appendFileSync(logFile, logMessage);
  }
}

// Clear log on startup
if (logFile) {
  try {
    fs.writeFileSync(logFile, `=== Cognito Debug Log ===\nStarted: ${new Date().toISOString()}\nisDev: ${isDev}\nplatform: ${process.platform}\n\n`);
  } catch (e) {
    // Ignore if we can't write
  }
}

function getPythonPath() {
  if (isDev) {
    // Point to the venv python executable
    // Windows uses Scripts/python.exe, Unix uses bin/python
    if (process.platform === 'win32') {
      return path.join(__dirname, '../../venv/Scripts/python.exe');
    } else {
      return path.join(__dirname, '../../venv/bin/python');
    }
  } else {
    // In production, it's a bundled executable in the resources folder
    const binaryName = process.platform === 'win32' ? 'api.exe' : 'api';
    return path.join(process.resourcesPath, 'api', binaryName);
  }
}

function getScriptPath() {
  if (isDev) {
    return path.join(__dirname, '../../backend/server.py');
  }
  return null; // Not needed for bundled exe
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function isTrustedRenderer(event) {
  const senderUrl = event.senderFrame?.url || '';
  if (isDev) {
    return senderUrl.startsWith('http://localhost:5173/');
  }
  return senderUrl.startsWith(productionRendererRoot);
}

function startPythonServer(port, token) {
  const pythonPath = getPythonPath();
  const scriptPath = getScriptPath();

  log('Starting Python Server...');
  log('Python Path: ' + pythonPath);
  log('Python exists: ' + fs.existsSync(pythonPath));
  log('resourcesPath: ' + (process.resourcesPath || 'N/A'));

  if (isDev) {
    // In dev, run: python3 -m uvicorn server:app --host 127.0.0.1 --port 8000
    // We need to set the cwd to backend so imports work
    const cwd = path.join(__dirname, '../../backend');
    log('CWD: ' + cwd);

    pythonProcess = spawn(pythonPath, ['-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: cwd,
      env: {
        ...process.env,
        COGNITO_API_TOKEN: token,
        COGNITO_ALLOWED_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173,null'
      },
      stdio: 'pipe' // Capture output
    });
  } else {
    // In prod, just run the binary
    log('Spawning production binary...');
    try {
      pythonProcess = spawn(pythonPath, [], {
        env: {
          ...process.env,
          PORT: String(port),
          COGNITO_API_TOKEN: token,
          COGNITO_ALLOWED_ORIGINS: 'null'
        },
        stdio: 'pipe'
      });
      log('Spawn successful, PID: ' + pythonProcess.pid);
    } catch (e) {
      log('ERROR spawning Python: ' + e.message);
      return;
    }
  }

  pythonProcess.stdout.on('data', (data) => {
    log('[Python]: ' + data);
  });

  pythonProcess.stderr.on('data', (data) => {
    log('[Python ERROR]: ' + data);
  });

  pythonProcess.on('error', (err) => {
    log('Python process error: ' + err.message);
  });

  pythonProcess.on('close', (code) => {
    log('Python process exited with code ' + code);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#0a0d14',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs')
    },
    titleBarStyle: 'hiddenInset', // Mac style
  });

  if (isDev) {
    log('Loading dev URL: http://localhost:5173');
    mainWindow.loadURL('http://localhost:5173');
    // mainWindow.webContents.openDevTools();
  } else {
    const htmlPath = path.join(__dirname, '../dist/index.html');
    log('Loading production HTML: ' + htmlPath);
    log('HTML exists: ' + fs.existsSync(htmlPath));
    mainWindow.loadFile(htmlPath);
  }

  // Log any load errors
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    log('Page failed to load: ' + errorCode + ' - ' + errorDescription);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    log('Page finished loading successfully');
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowedUrl = isDev ? 'http://localhost:5173/' : productionRendererRoot;
    if (!url.startsWith(allowedUrl)) {
      event.preventDefault();
      if (url.startsWith('https://')) {
        void shell.openExternal(url);
      }
    }
  });
}

app.whenReady().then(async () => {
  log('App is ready, starting initialization...');
  const port = await findAvailablePort();
  const token = crypto.randomBytes(32).toString('base64url');
  backendConfig = { baseUrl: `http://127.0.0.1:${port}`, token };

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  // Register IPC handlers once, before creating windows
  ipcMain.handle('dialog:openFile', async (event) => {
    if (!isTrustedRenderer(event)) {
      throw new Error('Untrusted IPC sender');
    }
    const window = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      filters: [{ name: 'Models', extensions: ['gguf', 'bin'] }]
    });
    if (canceled) {
      return null;
    } else {
      return filePaths[0];
    }
  });

  ipcMain.handle('backend:getConfig', async (event) => {
    if (!isTrustedRenderer(event)) {
      throw new Error('Untrusted IPC sender');
    }
    return backendConfig;
  });

  startPythonServer(port, token);
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (pythonProcess) {
    pythonProcess.kill();
  }
});
