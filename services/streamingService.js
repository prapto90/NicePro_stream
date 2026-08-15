const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const Stream = require('../models/Stream');
const Playlist = require('../models/Playlist');
const Video = require('../models/Video');

let ffmpegPath;
if (fs.existsSync('/usr/bin/ffmpeg')) {
  ffmpegPath = '/usr/bin/ffmpeg';
} else {
  ffmpegPath = ffmpegInstaller.path;
}

let ffprobePath;
if (fs.existsSync('/usr/bin/ffprobe')) {
  ffprobePath = '/usr/bin/ffprobe';
} else {
  ffprobePath = ffprobeInstaller.path;
}

function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

const activeStreams = new Map();
const streamLogs = new Map();
const streamRetryCount = new Map();
const manuallyStoppingStreams = new Set();
const startingStreams = new Set();

const MAX_LOG_LINES = 50;
const MAX_RETRY_ATTEMPTS = 15;
const BASE_RETRY_DELAY = 2000;
const MAX_RETRY_DELAY = 30000;
const HEALTH_CHECK_INTERVAL = 30000;
const SYNC_INTERVAL = 60000;
const STREAM_START_TIMEOUT = 15000;

const YOUTUBE_COPY_ALLOWED_VIDEO_CODECS = new Set(['h264']);
const YOUTUBE_COPY_ALLOWED_AUDIO_CODECS = new Set(['aac', 'mp3']);

let schedulerService = null;
let syncIntervalId = null;
let healthCheckIntervalId = null;
let initialized = false;

function setSchedulerService(service) {
  schedulerService = service;

  if (!initialized) {
    initialized = true;
    syncIntervalId = setInterval(syncStreamStatuses, SYNC_INTERVAL);
    healthCheckIntervalId = setInterval(healthCheckStreams, HEALTH_CHECK_INTERVAL);
    recoverManagedStreams().catch(() => {});
  }
}

function addStreamLog(streamId, message) {
  if (!streamLogs.has(streamId)) {
    streamLogs.set(streamId, []);
  }
  const logs = streamLogs.get(streamId);
  logs.push({ timestamp: new Date().toISOString(), message });
  if (logs.length > MAX_LOG_LINES) {
    logs.shift();
  }
}

function getStreamLogs(streamId) {
  return streamLogs.get(streamId) || [];
}

function cleanupStreamData(streamId) {
  streamRetryCount.delete(streamId);
  manuallyStoppingStreams.delete(streamId);
  startingStreams.delete(streamId);
}

function getRetryDelay(retryCount) {
  const delay = Math.min(BASE_RETRY_DELAY * Math.pow(1.5, retryCount), MAX_RETRY_DELAY);
  return delay + Math.random() * 1000;
}

function getProjectRoot() {
  return path.resolve(__dirname, '..');
}

function resolvePublicFilePath(relativePath) {
  if (!relativePath) {
    throw new Error('Missing media filepath');
  }

  const relPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
  return path.join(getProjectRoot(), 'public', relPath);
}

function isYouTubeDestination(stream) {
  if (stream && stream.is_youtube_api) {
    return true;
  }

  const rtmpUrl = (stream.rtmp_url || '').toLowerCase();
  return rtmpUrl.includes('youtube.com');
}

function isProgressLogLine(line) {
  return line.includes('frame=') || line.includes('time=') || line.includes('speed=');
}

function buildMediaLabel(media, index, type) {
  if (media && media.title) {
    return `${type} "${media.title}"`;
  }

  return `${type} #${index + 1}`;
}

function isSupportedYouTubePixelFormat(pixFmt) {
  const normalized = (pixFmt || '').toLowerCase();
  return normalized === 'yuv420p' || normalized === 'yuvj420p';
}

function getPrimaryStream(probeData, codecType) {
  return (probeData.streams || []).find(stream => stream.codec_type === codecType) || null;
}

function getFrameRateLabel(videoStream) {
  return videoStream && videoStream.avg_frame_rate ? videoStream.avg_frame_rate : 'unknown fps';
}

function buildCopyModeCompatibilityError(label, detail) {
  return `${label} tidak kompatibel dengan YouTube: ${detail}.`;
}

function createUnsupportedCopyModeError(message) {
  const error = new Error(message);
  error.code = 'UNSUPPORTED_COPY_MODE_MEDIA';
  return error;
}

function getRelevantStartupLog(line) {
  const trimmed = (line || '').trim();
  if (!trimmed || isProgressLogLine(trimmed)) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('press [q]') ||
    lower.startsWith('input #') ||
    lower.startsWith('output #') ||
    lower.startsWith('metadata:') ||
    lower.startsWith('stream mapping:')
  ) {
    return null;
  }

  return trimmed;
}

function buildStartupFailureMessage(startupState, fallbackMessage = null) {
  const detail = startupState.lastErrorLine || startupState.lastLogLine || fallbackMessage;
  if (detail) {
    return `FFmpeg gagal memulai stream: ${detail}`;
  }

  return 'FFmpeg gagal memulai stream';
}

const MANAGED_FFMPEG_TOKEN_PREFIX = 'streamflow_token=';

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isPidRunning(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// On the VPS (Linux), /proc exposes the command line exactly as it was
// launched.  A PID alone is never trusted because Linux can reuse a PID.
function verifyManagedFFmpeg(pid, token) {
  if (!isPidRunning(pid) || !token) {
    return { valid: false, running: isPidRunning(pid), reason: 'PID/token cannot be safely verified' };
  }

  // Windows has no /proc command-line interface. It can still control an
  // encoder started by this same application instance, but it intentionally
  // will not recover a PID after a restart. The production VPS uses Linux.
  if (process.platform !== 'linux') {
    const localProcess = Array.from(activeStreams.values()).find(stream =>
      Number(stream.pid) === Number(pid) && stream.token === token &&
      stream.process && stream.process.exitCode === null
    );
    return {
      valid: Boolean(localProcess),
      running: true,
      reason: localProcess ? null : 'Persistent process recovery requires Linux'
    };
  }

  try {
    const commandLine = fs.readFileSync(`/proc/${Number(pid)}/cmdline`, 'utf8');
    const ownsToken = commandLine.includes(`${MANAGED_FFMPEG_TOKEN_PREFIX}${token}`);
    const isFfmpeg = /(^|\0|\/)ffmpeg(?:\0|\s|$)/i.test(commandLine);
    return {
      valid: ownsToken && isFfmpeg,
      running: true,
      reason: ownsToken && isFfmpeg ? null : 'Process token or FFmpeg command does not match'
    };
  } catch (error) {
    return { valid: false, running: isPidRunning(pid), reason: 'Unable to read process identity' };
  }
}

async function clearManagedProcess(streamId) {
  await Stream.update(streamId, {
    ffmpeg_pid: null,
    ffmpeg_token: null,
    ffmpeg_started_at: null,
    ffmpeg_state: null
  });
}

async function persistManagedProcess(streamId, pid, token) {
  await Stream.update(streamId, {
    ffmpeg_pid: Number(pid),
    ffmpeg_token: token,
    ffmpeg_started_at: new Date().toISOString(),
    ffmpeg_state: 'running'
  });
}

function runFFprobe(filePath) {
  return new Promise((resolve, reject) => {
    const ffprobeProcess = spawn(ffprobePath, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    ffprobeProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ffprobeProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffprobeProcess.on('error', (error) => {
      reject(error);
    });

    ffprobeProcess.on('exit', (code) => {
      if (code !== 0) {
        return reject(new Error(stderr.trim() || `ffprobe exited with code ${code}`));
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function validateYouTubeCopyVideoProbe(probeData, label) {
  const videoStream = getPrimaryStream(probeData, 'video');
  if (!videoStream) {
    return buildCopyModeCompatibilityError(label, 'video stream tidak ditemukan');
  }

  const videoCodec = (videoStream.codec_name || '').toLowerCase();
  if (!YOUTUBE_COPY_ALLOWED_VIDEO_CODECS.has(videoCodec)) {
    return buildCopyModeCompatibilityError(label, `codec video ${videoCodec || 'unknown'} tidak didukung`);
  }

  if (!isSupportedYouTubePixelFormat(videoStream.pix_fmt)) {
    return buildCopyModeCompatibilityError(label, `pixel format ${videoStream.pix_fmt || 'unknown'} bukan 4:2:0 standar`);
  }

  const audioStream = getPrimaryStream(probeData, 'audio');
  if (audioStream) {
    const audioCodec = (audioStream.codec_name || '').toLowerCase();
    if (!YOUTUBE_COPY_ALLOWED_AUDIO_CODECS.has(audioCodec)) {
      return buildCopyModeCompatibilityError(label, `codec audio ${audioCodec || 'unknown'} tidak didukung`);
    }
  }

  return null;
}

function validateYouTubeCopyAudioProbe(probeData, label) {
  const audioStream = getPrimaryStream(probeData, 'audio');
  if (!audioStream) {
    return buildCopyModeCompatibilityError(label, 'audio stream tidak ditemukan');
  }

  const audioCodec = (audioStream.codec_name || '').toLowerCase();
  if (!YOUTUBE_COPY_ALLOWED_AUDIO_CODECS.has(audioCodec)) {
    return buildCopyModeCompatibilityError(label, `codec audio ${audioCodec || 'unknown'} tidak didukung`);
  }

  return null;
}

function validatePlaylistCopyConsistency(referenceStream, currentStream, label) {
  const mismatches = [];

  if ((currentStream.codec_name || '').toLowerCase() !== (referenceStream.codec_name || '').toLowerCase()) {
    mismatches.push('codec video berbeda');
  }

  if (currentStream.width !== referenceStream.width || currentStream.height !== referenceStream.height) {
    mismatches.push('resolusi berbeda');
  }

  if ((currentStream.pix_fmt || '').toLowerCase() !== (referenceStream.pix_fmt || '').toLowerCase()) {
    mismatches.push('pixel format berbeda');
  }

  if (getFrameRateLabel(currentStream) !== getFrameRateLabel(referenceStream)) {
    mismatches.push('frame rate berbeda');
  }

  if (mismatches.length === 0) {
    return null;
  }

  return `${label} tidak bisa digabung aman di copy mode YouTube karena ${mismatches.join(', ')}.`;
}

async function validateCopyModeCompatibility(stream) {
  return validateCopyModeCompatibilityForInput({
    videoId: stream.video_id,
    useAdvancedSettings: stream.use_advanced_settings,
    isYouTubeApi: stream.is_youtube_api,
    rtmpUrl: stream.rtmp_url
  });
}

async function validateCopyModeCompatibilityForInput({
  videoId,
  useAdvancedSettings = false,
  isYouTubeApi = false,
  rtmpUrl = ''
}) {
  if (useAdvancedSettings || !isYouTubeDestination({ is_youtube_api: isYouTubeApi, rtmp_url: rtmpUrl })) {
    return;
  }

  const playlist = await Playlist.findByIdWithVideos(videoId);

  if (playlist) {
    if (!playlist.videos || playlist.videos.length === 0) {
      throw new Error('Playlist is empty');
    }

    let referenceVideoStream = null;

    for (let index = 0; index < playlist.videos.length; index++) {
      const video = playlist.videos[index];
      const probeData = await runFFprobe(resolvePublicFilePath(video.filepath));
      const label = buildMediaLabel(video, index, 'Video');
      const compatibilityError = validateYouTubeCopyVideoProbe(probeData, label);

      if (compatibilityError) {
        throw createUnsupportedCopyModeError(compatibilityError);
      }

      const currentVideoStream = getPrimaryStream(probeData, 'video');
      if (!referenceVideoStream) {
        referenceVideoStream = currentVideoStream;
      } else {
        const consistencyError = validatePlaylistCopyConsistency(referenceVideoStream, currentVideoStream, label);
        if (consistencyError) {
          throw createUnsupportedCopyModeError(consistencyError);
        }
      }
    }

    for (let index = 0; index < (playlist.audios || []).length; index++) {
      const audio = playlist.audios[index];
      const probeData = await runFFprobe(resolvePublicFilePath(audio.filepath));
      const label = buildMediaLabel(audio, index, 'Audio');
      const compatibilityError = validateYouTubeCopyAudioProbe(probeData, label);

      if (compatibilityError) {
        throw createUnsupportedCopyModeError(compatibilityError);
      }
    }

    return;
  }

  const video = await Video.findById(videoId);
  if (!video) {
    throw new Error('Video not found');
  }

  const compatibilityError = validateYouTubeCopyVideoProbe(
    await runFFprobe(resolvePublicFilePath(video.filepath)),
    buildMediaLabel(video, 0, 'Video')
  );

  if (compatibilityError) {
    throw createUnsupportedCopyModeError(compatibilityError);
  }
}

function waitForStreamStartup(streamId, ffmpegProcess, startupState) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finishResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const finishReject = (message) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(new Error(message));
    };

    const timer = setTimeout(() => {
      finishReject(buildStartupFailureMessage(
        startupState,
        `tidak ada progres FFmpeg dalam ${Math.round(STREAM_START_TIMEOUT / 1000)} detik`
      ));
    }, STREAM_START_TIMEOUT);

    startupState.resolve = finishResolve;

    startupState.reject = finishReject;
  });
}

async function buildFFmpegArgsForPlaylist(stream, playlist) {
  if (!playlist.videos || playlist.videos.length === 0) {
    throw new Error('Playlist is empty');
  }

  const projectRoot = path.resolve(__dirname, '..');
  const rtmpUrl = `${stream.rtmp_url.replace(/\/$/, '')}/${stream.stream_key}`;
  const tempDir = path.join(projectRoot, 'temp');

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  let videoPaths = [];
  const videos = playlist.is_shuffle ? shuffleArray(playlist.videos) : playlist.videos;

  for (const video of videos) {
    const relPath = video.filepath.startsWith('/') ? video.filepath.substring(1) : video.filepath;
    const fullPath = path.join(projectRoot, 'public', relPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Video file not found: ${fullPath}`);
    }
    videoPaths.push(fullPath);
  }

  const concatFile = path.join(tempDir, `playlist_${stream.id}.txt`);
  let content = '';
  const loopCount = stream.loop_video ? 10000 : 1;

  for (let i = 0; i < loopCount; i++) {
    for (const vp of videoPaths) {
      content += `file '${vp.replace(/\\/g, '/')}'\n`;
    }
  }
  fs.writeFileSync(concatFile, content);

  const hasAudio = playlist.audios && playlist.audios.length > 0;

  if (!hasAudio) {
    if (!stream.use_advanced_settings) {
      return [
        '-nostdin',
        '-loglevel', 'warning',
        '-stats',
        '-re',
        '-fflags', '+genpts+igndts+discardcorrupt',
        '-avoid_negative_ts', 'make_zero',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatFile,
        '-c:v', 'copy',
        '-c:a', 'copy',
        '-bsf:a', 'aac_adtstoasc',
        '-f', 'flv',
        '-flvflags', 'no_duration_filesize',
        rtmpUrl
      ];
    }

    const resolution = stream.resolution || '1280x720';
    const bitrate = stream.bitrate || 2500;
    const fps = stream.fps || 30;

    return [
      '-nostdin',
      '-loglevel', 'warning',
      '-stats',
      '-re',
      '-fflags', '+genpts+igndts+discardcorrupt',
      '-avoid_negative_ts', 'make_zero',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFile,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'zerolatency',
      '-profile:v', 'high',
      '-level', '4.1',
      '-b:v', `${bitrate}k`,
      '-maxrate', `${Math.round(bitrate * 1.1)}k`,
      '-bufsize', `${bitrate * 2}k`,
      '-pix_fmt', 'yuv420p',
      '-g', String(fps * 2),
      '-keyint_min', String(fps),
      '-sc_threshold', '0',
      '-s', resolution,
      '-r', String(fps),
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-ac', '2',
      '-f', 'flv',
      '-flvflags', 'no_duration_filesize',
      rtmpUrl
    ];
  }

  let audioPaths = [];
  const audios = playlist.is_shuffle ? shuffleArray(playlist.audios) : playlist.audios;

  for (const audio of audios) {
    const relPath = audio.filepath.startsWith('/') ? audio.filepath.substring(1) : audio.filepath;
    const fullPath = path.join(projectRoot, 'public', relPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Audio file not found: ${fullPath}`);
    }
    audioPaths.push(fullPath);
  }

  const audioConcatFile = path.join(tempDir, `playlist_audio_${stream.id}.txt`);
  let audioContent = '';
  for (let i = 0; i < 10000; i++) {
    for (const ap of audioPaths) {
      audioContent += `file '${ap.replace(/\\/g, '/')}'\n`;
    }
  }
  fs.writeFileSync(audioConcatFile, audioContent);

  if (!stream.use_advanced_settings) {
    return [
      '-nostdin',
      '-loglevel', 'warning',
      '-stats',
      '-re',
      '-fflags', '+genpts+igndts+discardcorrupt',
      '-avoid_negative_ts', 'make_zero',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFile,
      '-re',
      '-f', 'concat',
      '-safe', '0',
      '-i', audioConcatFile,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-f', 'flv',
      '-flvflags', 'no_duration_filesize',
      rtmpUrl
    ];
  }

  const resolution = stream.resolution || '1280x720';
  const bitrate = stream.bitrate || 2500;
  const fps = stream.fps || 30;

  return [
    '-nostdin',
    '-loglevel', 'warning',
    '-stats',
    '-re',
    '-fflags', '+genpts+igndts+discardcorrupt',
    '-avoid_negative_ts', 'make_zero',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatFile,
    '-re',
    '-f', 'concat',
    '-safe', '0',
    '-i', audioConcatFile,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-profile:v', 'high',
    '-level', '4.1',
    '-b:v', `${bitrate}k`,
    '-maxrate', `${Math.round(bitrate * 1.1)}k`,
    '-bufsize', `${bitrate * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-g', String(fps * 2),
    '-keyint_min', String(fps),
    '-sc_threshold', '0',
    '-s', resolution,
    '-r', String(fps),
    '-c:a', 'copy',
    '-f', 'flv',
    '-flvflags', 'no_duration_filesize',
    rtmpUrl
  ];
}

async function buildFFmpegArgs(stream) {
  const streamWithVideo = await Stream.getStreamWithVideo(stream.id);

  if (streamWithVideo && streamWithVideo.video_type === 'playlist') {
    const playlist = await Playlist.findByIdWithVideos(stream.video_id);
    if (!playlist) {
      throw new Error('Playlist not found');
    }
    return await buildFFmpegArgsForPlaylist(stream, playlist);
  }

  const video = await Video.findById(stream.video_id);
  if (!video) {
    throw new Error('Video not found');
  }

  const relPath = video.filepath.startsWith('/') ? video.filepath.substring(1) : video.filepath;
  const projectRoot = path.resolve(__dirname, '..');
  const videoPath = path.join(projectRoot, 'public', relPath);

  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  const rtmpUrl = `${stream.rtmp_url.replace(/\/$/, '')}/${stream.stream_key}`;
  const loopValue = stream.loop_video ? '-1' : '0';

  if (!stream.use_advanced_settings) {
    return [
      '-nostdin',
      '-loglevel', 'warning',
      '-stats',
      '-re',
      '-fflags', '+genpts+igndts+discardcorrupt',
      '-avoid_negative_ts', 'make_zero',
      '-stream_loop', loopValue,
      '-i', videoPath,
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-f', 'flv',
      '-flvflags', 'no_duration_filesize',
      rtmpUrl
    ];
  }

  const resolution = stream.resolution || '1280x720';
  const bitrate = stream.bitrate || 2500;
  const fps = stream.fps || 30;

  return [
    '-nostdin',
    '-loglevel', 'warning',
    '-stats',
    '-re',
    '-fflags', '+genpts+igndts+discardcorrupt',
    '-avoid_negative_ts', 'make_zero',
    '-stream_loop', loopValue,
    '-i', videoPath,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-profile:v', 'high',
    '-level', '4.1',
    '-b:v', `${bitrate}k`,
    '-maxrate', `${Math.round(bitrate * 1.1)}k`,
    '-bufsize', `${bitrate * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-g', String(fps * 2),
    '-keyint_min', String(fps),
    '-sc_threshold', '0',
    '-s', resolution,
    '-r', String(fps),
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-f', 'flv',
    '-flvflags', 'no_duration_filesize',
    rtmpUrl
  ];
}


async function killFFmpegProcess(streamId, streamData) {
  const stream = await Stream.findById(streamId);
  const pid = Number((streamData && streamData.pid) || (stream && stream.ffmpeg_pid));
  const token = (streamData && streamData.token) || (stream && stream.ffmpeg_token);

  if (!pid || !token) {
    return true;
  }

  const verification = verifyManagedFFmpeg(pid, token);
  if (!verification.running) {
    await clearManagedProcess(streamId);
    return true;
  }
  if (!verification.valid) {
    addStreamLog(streamId, `Refusing to stop PID ${pid}: ${verification.reason}`);
    await Stream.update(streamId, { ffmpeg_state: 'needs_attention' });
    return false;
  }

  const sendSignal = (signal) => {
    try {
      // FFmpeg is launched in its own process group. Stopping the group also
      // stops any helper it created, while the verified token protects it.
      process.kill(process.platform === 'linux' ? -pid : pid, signal);
      return true;
    } catch (error) {
      try {
        process.kill(pid, signal);
        return true;
      } catch (fallbackError) {
        return false;
      }
    }
  };

  sendSignal('SIGTERM');
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await wait(500);
    if (!isPidRunning(pid)) {
      await clearManagedProcess(streamId);
      return true;
    }
  }

  // Re-verify immediately before an irreversible signal.
  if (!verifyManagedFFmpeg(pid, token).valid) {
    addStreamLog(streamId, `Refusing to force-stop PID ${pid}: process identity changed`);
    await Stream.update(streamId, { ffmpeg_state: 'needs_attention' });
    return false;
  }

  sendSignal('SIGKILL');
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await wait(500);
    if (!isPidRunning(pid)) {
      await clearManagedProcess(streamId);
      return true;
    }
  }

  await Stream.update(streamId, { ffmpeg_state: 'needs_attention' });
  return false;
}

async function startStream(streamId, isRetry = false, baseUrl = null) {
  if (startingStreams.has(streamId)) {
    return { success: false, error: 'Stream start is already in progress' };
  }

  startingStreams.add(streamId);

  try {
    if (!isRetry) {
      streamRetryCount.set(streamId, 0);
    }

    if (activeStreams.has(streamId)) {
      const existing = activeStreams.get(streamId);
      const existingIsRunning = existing && existing.pid && existing.token && verifyManagedFFmpeg(existing.pid, existing.token).valid;
      if (existingIsRunning) {
        if (!isRetry) {
          return { success: false, error: 'Stream is already active' };
        }
        addStreamLog(streamId, 'Killing existing FFmpeg process before restart...');
        manuallyStoppingStreams.add(streamId);
        await killFFmpegProcess(streamId, existing);
        manuallyStoppingStreams.delete(streamId);
      }
      activeStreams.delete(streamId);
    }

    let stream = await Stream.findById(streamId);
    if (!stream) {
      return { success: false, error: 'Stream not found' };
    }

    const persistedProcess = verifyManagedFFmpeg(stream.ffmpeg_pid, stream.ffmpeg_token);
    if (persistedProcess.valid) {
      activeStreams.set(streamId, {
        process: null,
        userId: stream.user_id,
        startTime: stream.start_time,
        endTime: stream.end_time,
        pid: Number(stream.ffmpeg_pid),
        token: stream.ffmpeg_token,
        recovered: true,
        lastActivity: Date.now()
      });
      return { success: false, error: 'Stream is already active' };
    }
    if (stream.ffmpeg_pid || stream.ffmpeg_token) {
      await clearManagedProcess(streamId);
      stream = await Stream.findById(streamId);
    }

    const originalStartTime = stream.start_time;
    const originalEndTime = stream.end_time;

    await validateCopyModeCompatibility(stream);

    if (stream.is_youtube_api) {
      const youtubeService = require('./youtubeService');
      const effectiveBaseUrl = baseUrl || process.env.BASE_URL || 'http://localhost:7575';

      addStreamLog(streamId, 'Creating YouTube broadcast...');

      try {
        const ytResult = await youtubeService.createYouTubeBroadcast(streamId, effectiveBaseUrl);
        if (!ytResult.success) {
          addStreamLog(streamId, `YouTube broadcast failed: ${ytResult.error}`);
          return { success: false, error: ytResult.error || 'Failed to create YouTube broadcast' };
        }
        stream = await Stream.findById(streamId);
        addStreamLog(streamId, `YouTube broadcast created: ${ytResult.broadcastId}`);
      } catch (ytError) {
        addStreamLog(streamId, `YouTube API error: ${ytError.message}`);
        return { success: false, error: `YouTube API error: ${ytError.message}` };
      }
    }

    if (!stream.rtmp_url || !stream.stream_key) {
      return { success: false, error: 'Missing RTMP URL or stream key' };
    }

    const ffmpegArgs = await buildFFmpegArgs(stream);
    const outputUrl = ffmpegArgs.pop();
    const processToken = uuidv4();
    ffmpegArgs.push('-metadata', `${MANAGED_FFMPEG_TOKEN_PREFIX}${processToken}`, outputUrl);

    addStreamLog(streamId, `Starting managed FFmpeg process`);

    const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, {
      // Detached on Linux means PM2 may exit and replace Node without taking
      // down the encoder. stdio is deliberately ignored so FFmpeg is not
      // coupled to pipes that disappear during the restart.
      detached: process.platform === 'linux',
      stdio: 'ignore'
    });
    ffmpegProcess.unref();

    let startTimeIso;
    if (isRetry && originalStartTime) {
      startTimeIso = originalStartTime;
    } else {
      startTimeIso = new Date().toISOString();
    }

    activeStreams.set(streamId, {
      process: ffmpegProcess,
      userId: stream.user_id,
      startTime: startTimeIso,
      endTime: originalEndTime,
      pid: ffmpegProcess.pid,
      token: processToken,
      lastActivity: Date.now()
    });
    await persistManagedProcess(streamId, ffmpegProcess.pid, processToken);

    ffmpegProcess.on('exit', async (code, signal) => {
      addStreamLog(streamId, `FFmpeg exited: code=${code}, signal=${signal}`);

      const wasActive = activeStreams.delete(streamId);
      const isManualStop = manuallyStoppingStreams.has(streamId);

      if (isManualStop) {
        manuallyStoppingStreams.delete(streamId);
        cleanupStreamData(streamId);
        return;
      }

      try {
        await clearManagedProcess(streamId);
      } catch (e) { }

      const currentStream = await Stream.findById(streamId);

      if (currentStream && currentStream.end_time) {
        const endTime = new Date(currentStream.end_time);
        const now = new Date();
        if (endTime.getTime() <= now.getTime()) {
          addStreamLog(streamId, 'Stream ended - scheduled end time reached');
          if (wasActive) {
            try {
              await Stream.updateStatus(streamId, 'offline', currentStream.user_id);
              if (schedulerService) {
                schedulerService.handleStreamStopped(streamId);
              }
            } catch (e) { }
          }
          cleanupStreamData(streamId);
          return;
        }
      }

      const shouldRetry = signal === 'SIGSEGV' || signal === 'SIGKILL' || signal === 'SIGPIPE' ||
        (code !== 0 && code !== null) || (code === null && signal === null);

      if (shouldRetry && currentStream && currentStream.status !== 'offline') {
        const retryCount = streamRetryCount.get(streamId) || 0;

        if (retryCount < MAX_RETRY_ATTEMPTS) {
          streamRetryCount.set(streamId, retryCount + 1);
          const delay = getRetryDelay(retryCount);

          addStreamLog(streamId, `Retry #${retryCount + 1} in ${Math.round(delay / 1000)}s`);

          setTimeout(async () => {
            try {
              const latestStream = await Stream.findById(streamId);
              if (latestStream && latestStream.status !== 'offline') {
                if (latestStream.end_time) {
                  const endTime = new Date(latestStream.end_time);
                  const now = new Date();
                  if (endTime.getTime() <= now.getTime()) {
                    await Stream.updateStatus(streamId, 'offline', latestStream.user_id);
                    cleanupStreamData(streamId);
                    return;
                  }
                }
                const result = await startStream(streamId, true, baseUrl);
                if (!result.success) {
                  await Stream.updateStatus(streamId, 'offline', latestStream.user_id);
                  cleanupStreamData(streamId);
                }
              } else {
                cleanupStreamData(streamId);
              }
            } catch (e) {
              cleanupStreamData(streamId);
            }
          }, delay);
          return;
        } else {
          addStreamLog(streamId, `Max retries (${MAX_RETRY_ATTEMPTS}) reached`);
        }
      }

      if (wasActive && currentStream) {
        try {
          await Stream.updateStatus(streamId, 'offline', currentStream.user_id);
          if (schedulerService) {
            schedulerService.handleStreamStopped(streamId);
          }
        } catch (e) { }
        cleanupStreamData(streamId);
      }
    });

    ffmpegProcess.on('error', async (err) => {
      addStreamLog(streamId, `Process error: ${err.message}`);
      activeStreams.delete(streamId);
      try {
        await clearManagedProcess(streamId);
        await Stream.updateStatus(streamId, 'offline', stream.user_id);
      } catch (e) { }
      cleanupStreamData(streamId);
    });

    // Give an immediate failure a chance to surface without tying FFmpeg to
    // this Node process through stdout/stderr pipes.
    await wait(1200);
    if (!verifyManagedFFmpeg(ffmpegProcess.pid, processToken).valid) {
      manuallyStoppingStreams.add(streamId);
      await killFFmpegProcess(streamId, activeStreams.get(streamId));
      manuallyStoppingStreams.delete(streamId);
      activeStreams.delete(streamId);
      cleanupTempFiles(streamId);
      cleanupStreamData(streamId);
      throw new Error('FFmpeg gagal memulai stream. Periksa source media atau RTMP stream key.');
    }

    if (!isRetry) {
      await Stream.updateStatus(streamId, 'live', stream.user_id, { startTimeOverride: startTimeIso });
    }

    if (schedulerService && originalEndTime) {
      if (typeof schedulerService.scheduleStreamTerminationByEndTime === 'function') {
        schedulerService.scheduleStreamTerminationByEndTime(streamId, originalEndTime, stream.user_id);
      }
    }

    return {
      success: true,
      message: 'Stream started successfully',
      isAdvancedMode: stream.use_advanced_settings
    };
  } catch (error) {
    addStreamLog(streamId, `Start failed: ${error.message}`);
    return { success: false, error: error.message, code: error.code || null };
  } finally {
    startingStreams.delete(streamId);
  }
}

function updateStreamActivity(streamId) {
  const streamData = activeStreams.get(streamId);
  if (streamData) {
    streamData.lastActivity = Date.now();
  }
}

async function stopStream(streamId) {
  try {
    const streamData = activeStreams.get(streamId);
    const stream = await Stream.findById(streamId);

    if (!streamData && stream && verifyManagedFFmpeg(stream.ffmpeg_pid, stream.ffmpeg_token).valid) {
      activeStreams.set(streamId, {
        process: null,
        userId: stream.user_id,
        startTime: stream.start_time,
        endTime: stream.end_time,
        pid: Number(stream.ffmpeg_pid),
        token: stream.ffmpeg_token,
        recovered: true,
        lastActivity: Date.now()
      });
    }

    const managedStreamData = activeStreams.get(streamId);
    if (!managedStreamData) {
      if (stream && stream.status === 'live') {
        if (stream.ffmpeg_pid && isPidRunning(stream.ffmpeg_pid)) {
          await Stream.update(streamId, { ffmpeg_state: 'needs_attention' });
          return { success: false, error: 'Proses dengan PID tersimpan masih hidup tetapi token tidak cocok; aplikasi tidak menghentikannya demi keamanan.' };
        }
        await clearManagedProcess(streamId);
        await Stream.updateStatus(streamId, 'offline', stream.user_id);
        if (schedulerService) {
          schedulerService.handleStreamStopped(streamId);
        }
        cleanupStreamData(streamId);
        return { success: true, message: 'Stream status fixed' };
      }
      return { success: false, error: 'Stream is not active' };
    }

    addStreamLog(streamId, 'Stopping stream...');
    manuallyStoppingStreams.add(streamId);

    const stopped = await killFFmpegProcess(streamId, managedStreamData);
    if (!stopped) {
      manuallyStoppingStreams.delete(streamId);
      return { success: false, error: 'FFmpeg tidak dihentikan karena identitas proses tidak cocok. Status dibuat needs attention.' };
    }

    activeStreams.delete(streamId);
    cleanupTempFiles(streamId);

    if (stream) {
      if (stream.is_youtube_api && stream.youtube_broadcast_id) {
        try {
          const youtubeService = require('./youtubeService');
          await youtubeService.deleteYouTubeBroadcast(streamId);
        } catch (e) { }
      }

      await saveStreamHistory(stream);
      await Stream.updateStatus(streamId, 'offline', stream.user_id);
    }

    if (schedulerService) {
      schedulerService.handleStreamStopped(streamId);
    }

    cleanupStreamData(streamId);
    return { success: true, message: 'Stream stopped successfully' };
  } catch (error) {
    manuallyStoppingStreams.delete(streamId);
    return { success: false, error: error.message };
  }
}

function cleanupTempFiles(streamId) {
  const tempDir = path.join(__dirname, '..', 'temp');
  const files = [
    path.join(tempDir, `playlist_${streamId}.txt`),
    path.join(tempDir, `playlist_audio_${streamId}.txt`)
  ];

  for (const file of files) {
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch (e) { }
  }
}

function isStreamActive(streamId) {
  const streamData = activeStreams.get(streamId);
  if (!streamData) return false;

  if (streamData.pid && streamData.token) {
    if (!verifyManagedFFmpeg(streamData.pid, streamData.token).valid) {
      activeStreams.delete(streamId);
      return false;
    }
    return true;
  }

  if (streamData.process && streamData.process.exitCode !== null) {
    activeStreams.delete(streamId);
    return false;
  }

  return true;
}

function isStreamStarting(streamId) {
  return startingStreams.has(streamId);
}

function getActiveStreams() {
  return Array.from(activeStreams.keys());
}

function getActiveStreamInfo(streamId) {
  const streamData = activeStreams.get(streamId);
  if (!streamData) return null;

  return {
    streamId,
    userId: streamData.userId,
    startTime: streamData.startTime,
    endTime: streamData.endTime,
    pid: streamData.pid,
    lastActivity: streamData.lastActivity,
    retryCount: streamRetryCount.get(streamId) || 0
  };
}


async function syncStreamStatuses() {
  try {
    const liveStreams = await Stream.findAll(null, 'live');

    for (const stream of liveStreams) {
      const isActive = activeStreams.has(stream.id);

      if (!isActive) {
        const managedProcess = verifyManagedFFmpeg(stream.ffmpeg_pid, stream.ffmpeg_token);
        if (managedProcess.valid) {
          activeStreams.set(stream.id, {
            process: null,
            userId: stream.user_id,
            startTime: stream.start_time,
            endTime: stream.end_time,
            pid: Number(stream.ffmpeg_pid),
            token: stream.ffmpeg_token,
            recovered: true,
            lastActivity: Date.now()
          });
          continue;
        }
        const retryCount = streamRetryCount.get(stream.id);
        if (retryCount !== undefined && retryCount < MAX_RETRY_ATTEMPTS) {
          continue;
        }

        if (stream.end_time) {
          const endTime = new Date(stream.end_time);
          if (endTime.getTime() <= Date.now()) {
            await Stream.updateStatus(stream.id, 'offline', stream.user_id);
            cleanupStreamData(stream.id);
            continue;
          }
        }

        await Stream.updateStatus(stream.id, 'offline', stream.user_id, { preserveEndTime: true });
        cleanupStreamData(stream.id);
      }
    }

    for (const [streamId, streamData] of activeStreams) {
      const stream = await Stream.findById(streamId);

      if (!stream) {
        const proc = streamData.process;
        if (proc && typeof proc.kill === 'function') {
          try {
            proc.kill('SIGTERM');
          } catch (e) { }
        }
        activeStreams.delete(streamId);
        cleanupStreamData(streamId);
        continue;
      }

      if (stream.status !== 'live') {
        await Stream.updateStatus(streamId, 'live', stream.user_id);
      }

      if (streamData.pid && streamData.token && !verifyManagedFFmpeg(streamData.pid, streamData.token).valid) {
        activeStreams.delete(streamId);
        await clearManagedProcess(streamId);
        await Stream.updateStatus(streamId, 'offline', stream.user_id);
        cleanupStreamData(streamId);
        continue;
      }

      if (streamData.process && streamData.process.exitCode !== null) {
        activeStreams.delete(streamId);
        await Stream.updateStatus(streamId, 'offline', stream.user_id);
        cleanupStreamData(streamId);
      }
    }
  } catch (error) { }
}

async function recoverManagedStreams() {
  try {
    const liveStreams = await Stream.findAll(null, 'live');
    let recovered = 0;

    for (const stream of liveStreams) {
      const verification = verifyManagedFFmpeg(stream.ffmpeg_pid, stream.ffmpeg_token);
      if (verification.valid) {
        activeStreams.set(stream.id, {
          process: null,
          userId: stream.user_id,
          startTime: stream.start_time,
          endTime: stream.end_time,
          pid: Number(stream.ffmpeg_pid),
          token: stream.ffmpeg_token,
          recovered: true,
          lastActivity: Date.now()
        });
        await Stream.update(stream.id, { ffmpeg_state: 'recovered' });
        addStreamLog(stream.id, `Recovered managed FFmpeg PID ${stream.ffmpeg_pid} after application restart`);
        recovered += 1;
      } else if (stream.ffmpeg_pid || stream.ffmpeg_token) {
        await clearManagedProcess(stream.id);
        await Stream.updateStatus(stream.id, 'offline', stream.user_id, { preserveEndTime: true });
      }
    }

    if (recovered > 0) {
      console.log(`[StreamingService] Recovered ${recovered} managed FFmpeg stream(s)`);
    }
    return recovered;
  } catch (error) {
    console.error('[StreamingService] Failed to recover managed FFmpeg streams:', error.message);
    return 0;
  }
}

async function healthCheckStreams() {
  try {
    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000;

    for (const [streamId, streamData] of activeStreams) {
      // Detached processes do not keep a log pipe to Node. Their liveness is
      // checked by the PID/token instead of the old "last stderr activity"
      // heuristic, which would otherwise restart a healthy live every 5 min.
      if (streamData.pid && streamData.token) {
        if (!verifyManagedFFmpeg(streamData.pid, streamData.token).valid) {
          activeStreams.delete(streamId);
          const stream = await Stream.findById(streamId);
          if (stream && stream.status === 'live') {
            await clearManagedProcess(streamId);
            await Stream.updateStatus(streamId, 'offline', stream.user_id, { preserveEndTime: true });
          }
          cleanupStreamData(streamId);
        }
        continue;
      }

      if (streamData.process && streamData.process.exitCode !== null) {
        activeStreams.delete(streamId);
        const stream = await Stream.findById(streamId);
        if (stream && stream.status === 'live') {
          if (stream.end_time) {
            const endTime = new Date(stream.end_time);
            if (endTime.getTime() <= Date.now()) {
              await Stream.updateStatus(streamId, 'offline', stream.user_id);
              cleanupStreamData(streamId);
              continue;
            }
          }
          await Stream.updateStatus(streamId, 'offline', stream.user_id, { preserveEndTime: true });
        }
        cleanupStreamData(streamId);
        continue;
      }

      if (streamData.lastActivity && (now - streamData.lastActivity) > staleThreshold) {
        addStreamLog(streamId, 'Stream appears stale, restarting...');

        const stream = await Stream.findById(streamId);
        if (stream && stream.status === 'live') {
          if (stream.end_time) {
            const endTime = new Date(stream.end_time);
            if (endTime.getTime() <= Date.now()) {
              manuallyStoppingStreams.add(streamId);
              await killFFmpegProcess(streamId, streamData);
              activeStreams.delete(streamId);
              manuallyStoppingStreams.delete(streamId);
              await Stream.updateStatus(streamId, 'offline', stream.user_id);
              cleanupStreamData(streamId);
              continue;
            }
          }

          manuallyStoppingStreams.add(streamId);
          await killFFmpegProcess(streamId, streamData);
          activeStreams.delete(streamId);
          manuallyStoppingStreams.delete(streamId);

          setTimeout(async () => {
            try {
              const currentStream = await Stream.findById(streamId);
              if (currentStream && currentStream.status === 'live') {
                await startStream(streamId, true);
              }
            } catch (e) { }
          }, 3000);
        }
      }
    }
  } catch (error) { }
}

async function saveStreamHistory(stream) {
  try {
    if (!stream.start_time) {
      return false;
    }

    const startTime = new Date(stream.start_time);
    const endTime = new Date();
    const durationSeconds = Math.floor((endTime - startTime) / 1000);

    if (durationSeconds < 10) {
      return false;
    }

    const videoDetails = stream.video_id ? await Video.findById(stream.video_id) : null;

    const historyData = {
      id: uuidv4(),
      stream_id: stream.id,
      title: stream.title,
      platform: stream.platform || 'Custom',
      platform_icon: stream.platform_icon,
      video_id: stream.video_id,
      video_title: videoDetails ? videoDetails.title : null,
      resolution: stream.resolution,
      bitrate: stream.bitrate,
      fps: stream.fps,
      start_time: stream.start_time,
      end_time: endTime.toISOString(),
      duration: durationSeconds,
      use_advanced_settings: stream.use_advanced_settings ? 1 : 0,
      user_id: stream.user_id
    };

    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO stream_history (
          id, stream_id, title, platform, platform_icon, video_id, video_title,
          resolution, bitrate, fps, start_time, end_time, duration, use_advanced_settings, user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          historyData.id, historyData.stream_id, historyData.title,
          historyData.platform, historyData.platform_icon, historyData.video_id, historyData.video_title,
          historyData.resolution, historyData.bitrate, historyData.fps,
          historyData.start_time, historyData.end_time, historyData.duration,
          historyData.use_advanced_settings, historyData.user_id
        ],
        function (err) {
          if (err) {
            return reject(err);
          }
          resolve(historyData);
        }
      );
    });
  } catch (error) {
    return false;
  }
}

async function gracefulShutdown() {
  if (syncIntervalId) {
    clearInterval(syncIntervalId);
    syncIntervalId = null;
  }
  if (healthCheckIntervalId) {
    clearInterval(healthCheckIntervalId);
    healthCheckIntervalId = null;
  }

  // Deliberately do not stop managed FFmpeg here. PM2 sends SIGTERM while it
  // replaces the web app; the encoder keeps streaming and is recovered using
  // its PID + token when Node starts again. Normal Stop Stream still calls
  // stopStream(), which performs a verified graceful stop.
  activeStreams.clear();
  streamRetryCount.clear();
  manuallyStoppingStreams.clear();
  startingStreams.clear();
}

process.on('SIGTERM', async () => {
  await gracefulShutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await gracefulShutdown();
  process.exit(0);
});

module.exports = {
  startStream,
  stopStream,
  validateCopyModeCompatibilityForInput,
  isStreamActive,
  isStreamStarting,
  getActiveStreams,
  getActiveStreamInfo,
  getStreamLogs,
  syncStreamStatuses,
  healthCheckStreams,
  recoverManagedStreams,
  saveStreamHistory,
  gracefulShutdown,
  setSchedulerService
};
