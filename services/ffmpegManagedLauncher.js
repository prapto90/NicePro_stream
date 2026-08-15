// This short-lived launcher intentionally exits after it starts FFmpeg.
// That re-parents the detached encoder to init/systemd, so PM2's process-tree
// cleanup cannot terminate a live encoder when the web application restarts.
const { spawn } = require('child_process');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const { ffmpegPath, args } = JSON.parse(input);
    if (!ffmpegPath || !Array.isArray(args)) throw new Error('Invalid FFmpeg launch payload');

    const encoder = spawn(ffmpegPath, args, {
      detached: process.platform === 'linux',
      stdio: 'ignore'
    });
    encoder.unref();
    process.stdout.write(`${JSON.stringify({ pid: encoder.pid })}\n`);
    process.stdout.end(() => process.exit(0));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
});
