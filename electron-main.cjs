const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// Determine database path relative to executable when packaged, or relative to project root in dev mode
const isPackaged = app.isPackaged;
const baseDir = isPackaged ? path.dirname(process.execPath) : app.getAppPath();
const dataDir = path.join(baseDir, 'data');
const imagesDir = path.join(dataDir, 'images');
const dbFilePath = path.join(dataDir, 'db.json');

// Ensure directories exist
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

// Read or initialize JSON database
function readDB() {
  if (!fs.existsSync(dbFilePath)) {
    const initial = {
      templates: [],
      backs: [],
      deckNames: {
        mazo1: 'Mazo Principal'
      },
      boardState: null
    };
    fs.writeFileSync(dbFilePath, JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }
  try {
    const data = fs.readFileSync(dbFilePath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading JSON db:', err);
    return { templates: [], backs: [], deckNames: { mazo1: 'Mazo Principal' }, boardState: null };
  }
}

function writeDB(data) {
  fs.writeFileSync(dbFilePath, JSON.stringify(data, null, 2), 'utf8');
}

// Register custom protocol for serving local media files
protocol.registerSchemesAsPrivileged([
  { scheme: 'card-media', privileges: { bypassCSP: true, stream: true, supportFetchAPI: true } }
]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Aeterna Duellum - Simulador de Cartas',
    icon: path.join(__dirname, 'dist', 'favicon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Load build output index.html
  const indexPath = path.join(__dirname, 'dist', 'index.html');
  if (fs.existsSync(indexPath)) {
    win.loadFile(indexPath);
  } else {
    // Fallback to Vite dev server if dist is not compiled yet
    win.loadURL('http://localhost:5173');
  }

  // Remove native menu bar
  win.setMenuBarVisibility(false);
}

app.whenReady().then(() => {
  // Handle custom protocol 'card-media://'
  protocol.handle('card-media', (request) => {
    try {
      const parsed = new URL(request.url);
      const filePath = path.join(
        dataDir,
        decodeURIComponent(parsed.host || ''),
        decodeURIComponent(parsed.pathname)
      );
      return net.fetch(pathToFileURL(filePath).toString());
    } catch (err) {
      console.error('Protocol error:', err);
      return new Response('File not found', { status: 404 });
    }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC Database Handlers
ipcMain.handle('load-database', () => {
  return readDB();
});

ipcMain.handle('save-deck-names', (event, deckNames) => {
  const db = readDB();
  db.deckNames = deckNames;
  writeDB(db);
  return true;
});

ipcMain.handle('save-card-template', (event, template, imageBuffer) => {
  const db = readDB();
  const filename = `${template.id}.png`;
  const filePath = path.join(imagesDir, filename);

  // Write image buffer to disk if provided
  if (imageBuffer) {
    fs.writeFileSync(filePath, Buffer.from(imageBuffer));
  }

  // Update or insert template metadata
  const index = db.templates.findIndex((t) => t.id === template.id);
  const updatedTemplate = {
    ...template,
    imageUrl: `card-media://images/${filename}`
  };

  if (index !== -1) {
    db.templates[index] = {
      ...db.templates[index],
      ...updatedTemplate
    };
  } else {
    db.templates.push(updatedTemplate);
  }

  writeDB(db);
  return db.templates[index] || updatedTemplate;
});

ipcMain.handle('delete-card-template', (event, id) => {
  const db = readDB();
  const filename = `${id}.png`;
  const filePath = path.join(imagesDir, filename);

  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      console.error('Error deleting image file:', err);
    }
  }

  db.templates = db.templates.filter((t) => t.id !== id);
  writeDB(db);
  return true;
});

ipcMain.handle('save-card-back', (event, id, imageBuffer) => {
  const db = readDB();
  const filename = `${id}.png`;
  const filePath = path.join(imagesDir, filename);

  // Write image buffer to disk if provided
  if (imageBuffer) {
    fs.writeFileSync(filePath, Buffer.from(imageBuffer));
  }

  const index = db.backs.findIndex((b) => b.id === id);
  const backEntry = {
    id,
    imageUrl: `card-media://images/${filename}`
  };

  if (index !== -1) {
    db.backs[index] = {
      ...db.backs[index],
      ...backEntry
    };
  } else {
    db.backs.push(backEntry);
  }

  writeDB(db);
  return db.backs[index] || backEntry;
});

ipcMain.handle('delete-card-back', (event, id) => {
  const db = readDB();
  const filename = `${id}.png`;
  const filePath = path.join(imagesDir, filename);

  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      console.error('Error deleting back image file:', err);
    }
  }

  db.backs = db.backs.filter((b) => b.id !== id);
  writeDB(db);
  return true;
});

ipcMain.handle('save-board-state', (event, cards, counters, nextZIndex) => {
  const db = readDB();
  db.boardState = { cards, counters, nextZIndex };
  writeDB(db);
  return true;
});
