// This short-lived launcher intentionally exits after it starts FFmpeg.
// That re-parents the detached encoder to init/systemd, so PM2's process-tree
// cleanup cannot terminate a live encoder when the web application restarts.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const { ffmpegPath, args, logPath } = JSON.parse(input);
    if (!ffmpegPath || !Array.isArray(args)) throw new Error('Invalid FFmpeg launch payload');

    let logFd = null;
    if (logPath) {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      logFd = fs.openSync(logPath, 'a');
    }
    const encoder = spawn(ffmpegPath, args, {
      detached: process.platform === 'linux',
      // FFmpeg warnings/errors survive PM2 restarts in a real file. Do not use
      // a pipe here: closing a PM2-owned pipe can terminate a detached FFmpeg.
      stdio: ['ignore', 'ignore', logFd || 'ignore']
    });
    if (logFd !== null) fs.closeSync(logFd);
    encoder.unref();
    process.stdout.write(`${JSON.stringify({ pid: encoder.pid })}\n`);
    process.stdout.end(() => process.exit(0));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
});
