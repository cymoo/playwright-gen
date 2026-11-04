// Small real Electron app: renderer IPC invokes both native dialog APIs.
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { readFileSync } = require('node:fs');
const originalAsync = dialog.showOpenDialog;
const originalSync = dialog.showOpenDialogSync;
let window;
ipcMain.handle('open-file', async (_event, sync) => {
  const options = { properties: ['openFile'] };
  const paths = sync ? dialog.showOpenDialogSync(window, options)
    : (await dialog.showOpenDialog(window, options)).filePaths;
  return paths?.length ? readFileSync(paths[0], 'utf8') : 'canceled';
});
ipcMain.handle('dialogs-restored', () => dialog.showOpenDialog === originalAsync && dialog.showOpenDialogSync === originalSync);
app.whenReady().then(async () => {
  window = new BrowserWindow({ webPreferences: { nodeIntegration: true, contextIsolation: false } });
  await window.loadURL('data:text/html,' + encodeURIComponent(`
    <button title="Import file" onclick="importFile(false)">Import async</button>
    <button onclick="importFile(true)">Import sync</button>
    <button onclick="document.querySelector('input').click()">Renderer upload</button>
    <input type="file" hidden onchange="this.files[0].text().then(text => document.querySelector('output').textContent = text)">
    <button>No chooser</button>
    <output data-testid="result"></output>
    <script>
      const { ipcRenderer } = require('electron');
      async function importFile(sync) {
        document.querySelector('output').textContent = await ipcRenderer.invoke('open-file', sync);
      }
    </script>`));
});
app.on('window-all-closed', () => app.quit());
