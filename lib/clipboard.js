'use strict';
// Copia texto al portapapeles del sistema; si no hay herramienta disponible usa OSC 52 (lo soportan
// iTerm2, kitty, WezTerm, Windows Terminal, tmux con set-clipboard, etc.).
const { spawn } = require('child_process');

function candidates() {
  if (process.platform === 'darwin') return [['pbcopy', []]];
  if (process.platform === 'win32') return [['clip', []]];
  const list = [];
  if (process.env.WAYLAND_DISPLAY) list.push(['wl-copy', []]);
  list.push(['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]);
  return list;
}

function tryCmd(cmd, args, text) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch { return resolve(false); }
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    child.stdin.end(text);
  });
}

async function copy(text, writeRaw) {
  for (const [cmd, args] of candidates()) {
    if (await tryCmd(cmd, args, text)) return cmd;
  }
  if (writeRaw) {
    writeRaw(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`);
    return 'OSC 52';
  }
  return null;
}

module.exports = { copy };
