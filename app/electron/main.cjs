const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let mainWindow;
let pythonProcess = null;

const isDev = !app.isPackaged;

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

function startPythonServer() {
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

    pythonProcess = spawn(pythonPath, ['-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', '8000'], {
      cwd: cwd,
      env: process.env, // Pass env vars
      stdio: 'pipe' // Capture output
    });
  } else {
    // In prod, just run the binary
    log('Spawning production binary...');
    try {
      pythonProcess = spawn(pythonPath, [], {
        env: { ...process.env, PORT: '8000' },
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
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
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
}

app.whenReady().then(() => {
  log('App is ready, starting initialization...');
  // Register IPC handlers once, before creating windows
  ipcMain.handle('dialog:openFile', async (event) => {
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

  startPythonServer();
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
