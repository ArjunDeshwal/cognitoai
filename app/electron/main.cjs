const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let mainWindow;
let pythonProcess = null;

const isDev = !app.isPackaged;

function getPythonPath() {
  if (isDev) {
    // Point to the venv python executable
    return path.join(__dirname, '../../venv/bin/python');
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

  console.log('Starting Python Server...');
  console.log('Python Path:', pythonPath);

  if (isDev) {
    // In dev, run: python3 -m uvicorn server:app --host 127.0.0.1 --port 8000
    // We need to set the cwd to backend so imports work
    const cwd = path.join(__dirname, '../../backend');
    console.log('CWD:', cwd);

    pythonProcess = spawn(pythonPath, ['-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', '8000'], {
      cwd: cwd,
      env: process.env, // Pass env vars
      stdio: 'pipe' // Capture output
    });
  } else {
    // In prod, just run the binary
    pythonProcess = spawn(pythonPath, [], {
      env: { ...process.env, PORT: '8000' },
      stdio: 'pipe'
    });
  }

  pythonProcess.stdout.on('data', (data) => {
    console.log(`[Python]: ${data}`);
  });

  pythonProcess.stderr.on('data', (data) => {
    console.error(`[Python API]: ${data}`);
  });

  pythonProcess.on('close', (code) => {
    console.log(`Python process exited with code ${code}`);
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
    mainWindow.loadURL('http://localhost:5173');
    // mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(() => {
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
