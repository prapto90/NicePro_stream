const fs = require('fs');
const path = require('path');
const NewRotation = require('../models/NewRotation');
const Video = require('../models/Video');
const Playlist = require('../models/Playlist');
const { normalizeVideoForRotation } = require('../utils/videoProcessor');
const running = new Set();
let workerBusy = false;
const ROTATION_READY_PROFILE = '720p30-h264-cbr-4000k-v3';

// Playlist changes are detected when the user edits a local Playlist. This is only a
// database comparison; FFmpeg is not started until the user chooses Sync.
async function markPlaylistChanges(playlistId) {
  const rotations = await NewRotation.findForPlaylist(playlistId);
  if (!rotations.length) return [];
  const playlist = await Playlist.findByIdWithVideos(playlistId);
  const currentIds = new Set((playlist?.videos || []).map(video => video.id));
  const changed = [];

  for (const rotation of rotations) {
    // Initial preparation owns its own media snapshot. Do not interrupt it.
    if (['pending', 'processing'].includes(rotation.preparation_status)) continue;
    const preparedIds = new Set((await NewRotation.getPreparedMedia(rotation.id)).map(item => item.video_id));
    const newCount = [...currentIds].filter(id => !preparedIds.has(id)).length;
    const removedCount = [...preparedIds].filter(id => !currentIds.has(id)).length;
    if (!newCount && !removedCount) continue;
    await NewRotation.update(rotation.id, {
      preparation_status: 'needs_sync', preparation_error: null,
      sync_new_count: newCount, sync_removed_count: removedCount
    });
    changed.push({ rotationId: rotation.id, newCount, removedCount });
  }
  return changed;
}
async function prepare(rotationId) {
  if (running.has(rotationId)) return; running.add(rotationId);
  if (workerBusy) { running.delete(rotationId); setTimeout(() => prepare(rotationId), 1000); return; }
  workerBusy = true;
  try {
    const rotation = await NewRotation.findById(rotationId); if (!rotation) return;
    await NewRotation.update(rotationId, { preparation_status: 'processing', preparation_error: null });
    let videos = [];
    if (String(rotation.video_id).startsWith('playlist:')) { const playlist = await Playlist.findByIdWithVideos(rotation.video_id.slice(9)); videos = playlist?.videos || []; }
    else { const video = await Video.findById(rotation.video_id); if (video) videos = [video]; }
    if (!videos.length) throw new Error('No video source found');
    const currentIds = new Set(videos.map(video => video.id));
    const previous = await NewRotation.getPreparedMedia(rotationId);
    for (const item of previous) {
      if (currentIds.has(item.video_id)) continue;
      const removedVideo = await Video.findById(item.video_id);
      if (removedVideo?.rotation_ready && removedVideo.original_filepath) {
        const oldPrepared = path.join(__dirname, '..', 'public', String(removedVideo.filepath).replace(/^\//, ''));
        if (fs.existsSync(oldPrepared)) fs.unlinkSync(oldPrepared);
        await Video.update(removedVideo.id, { filepath: removedVideo.original_filepath, original_filepath: null, rotation_ready: 0, rotation_ready_profile: null });
      }
      await NewRotation.removePreparedMedia(rotationId, item.video_id);
    }
    const outputDir = path.join(__dirname, '..', 'public', 'uploads', 'rotation-ready'); fs.mkdirSync(outputDir, { recursive: true });
    for (const video of videos) {
      if (video.rotation_ready && video.rotation_ready_profile === ROTATION_READY_PROFILE) { await NewRotation.markPreparedMedia(rotationId, video.id); continue; }
      // Older ready files are rebuilt from
      // the preserved original rather than being transcoded a second time.
      const sourcePath = video.rotation_ready && video.original_filepath ? video.original_filepath : video.filepath;
      const source = path.join(__dirname, '..', 'public', String(sourcePath).replace(/^\//, ''));
      if (!fs.existsSync(source)) throw new Error(`Source video not found: ${video.title}`);
      const filename = `rotation-${video.id}.mp4`;
      const output = path.join(outputDir, filename);
      if (fs.existsSync(output)) fs.unlinkSync(output);
      await normalizeVideoForRotation(source, output);
      await Video.update(video.id, { original_filepath: video.original_filepath || video.filepath, filepath: `/uploads/rotation-ready/${filename}`, format: 'mp4', resolution: '1280x720', bitrate: 4000, fps: '30', rotation_ready: 1, rotation_ready_profile: ROTATION_READY_PROFILE });
      await NewRotation.markPreparedMedia(rotationId, video.id);
    }
    await NewRotation.update(rotationId, { preparation_status: 'ready', preparation_error: null, sync_new_count: 0, sync_removed_count: 0 });
  } catch (error) { await NewRotation.update(rotationId, { preparation_status: 'failed', preparation_error: error.message }); }
  finally { running.delete(rotationId); workerBusy = false; }
}
async function cleanup(rotation) {
  if (!rotation) return;
  let videos = [];
  if (String(rotation.video_id).startsWith('playlist:')) { const playlist = await Playlist.findByIdWithVideos(rotation.video_id.slice(9)); videos = playlist?.videos || []; }
  else { const video = await Video.findById(rotation.video_id); if (video) videos = [video]; }
  for (const video of videos) {
    if (!video.rotation_ready || !video.original_filepath) continue;
    const prepared = path.join(__dirname, '..', 'public', String(video.filepath).replace(/^\//, ''));
    if (fs.existsSync(prepared)) fs.unlinkSync(prepared);
    await Video.update(video.id, { filepath: video.original_filepath, original_filepath: null, rotation_ready: 0, rotation_ready_profile: null });
    await NewRotation.removePreparedMedia(rotation.id, video.id);
  }
}
function init() { NewRotation.findAllPending().then(rows => rows.forEach(row => prepare(row.id))).catch(console.error); }
module.exports = { prepare, cleanup, init, markPlaylistChanges };
