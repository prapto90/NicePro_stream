const path = require('path');
const NewRotation = require('../models/NewRotation');
const rotationService = require('./rotationService');

let intervalId = null;
// Mirrors RotationService's in-memory protection: a rotation can only create one live stream per slot.
const activeStreams = new Map();
const startingRotations = new Set();
const failedStarts = new Map();

function parseLocal(value) {
  if (!value) return null;
  const [date, time = '00:00:00'] = value.replace('Z', '').split('T');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute, second = 0] = time.split(':').map(Number);
  return new Date(year, month - 1, day, hour, minute, second);
}
function formatLocal(date) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function selectedWeekdays(rotation) {
  return String(rotation.repeat_days || '').split(',').map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6);
}
async function nextWeeklySlot(rotation, from) {
  const slots = await NewRotation.getScheduleSlots(rotation.id);
  if (!slots.length) return null;
  let next = null;
  for (let offset = 0; offset <= 7; offset++) {
    const date = new Date(from); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() + offset);
    for (const slot of slots) {
      if (date.getDay() !== Number(slot.day_of_week)) continue;
      const [startHour, startMinute] = slot.start_time.split(':').map(Number);
      const [endHour, endMinute] = slot.end_time.split(':').map(Number);
      const start = new Date(date); start.setHours(startHour, startMinute, 0, 0);
      if (start <= from) continue;
      const end = new Date(date); end.setHours(endHour, endMinute, 0, 0);
      if (end <= start) end.setDate(end.getDate() + 1);
      if (!next || start < next.start) next = { start, end };
    }
  }
  return next;
}
async function nextSchedule(rotation) {
  const start = parseLocal(rotation.start_time);
  const end = parseLocal(rotation.end_time);
  const now = new Date();
  const repeatMode = rotation.repeat_mode || 'daily';
  if (repeatMode === 'weekly') {
    const slot = await nextWeeklySlot(rotation, now);
    if (slot) return slot;
  }
  if (repeatMode === 'monthly') {
    do { start.setMonth(start.getMonth() + 1); end.setMonth(end.getMonth() + 1); } while (start <= now);
  } else if (repeatMode === 'weekly') {
    const weekdays = selectedWeekdays(rotation);
    do {
      start.setDate(start.getDate() + 1); end.setDate(end.getDate() + 1);
    } while (start <= now || (weekdays.length && !weekdays.includes(start.getDay())));
  } else {
    do { start.setDate(start.getDate() + 1); end.setDate(end.getDate() + 1); } while (start <= now);
  }
  return { start, end };
}
function buildItem(rotation, title, thumbnail) {
  return {
    id: `new-${rotation.id}`,
    video_id: rotation.video_id,
    title: title.title,
    description: rotation.description,
    tags: rotation.tags,
    privacy: rotation.privacy,
    category: rotation.category,
    youtube_monetization: rotation.youtube_monetization === 1,
    // RotationService stores old thumbnails as a filename; Gallery stores a relative path.
    // Gallery thumbnail records store the real image in filepath. Use it rather than a generated preview.
    original_thumbnail_path: thumbnail?.filepath || thumbnail?.thumbnail_path || null
  };
}

async function checkRotations() {
  try {
    const rotations = await NewRotation.findAllActive?.() || [];
    const now = new Date();
    for (const rotation of rotations) {
      const start = parseLocal(rotation.start_time);
      const end = parseLocal(rotation.end_time);
      if (!start || !end) continue;
      const titles = rotation.disable_used_titles
        ? await NewRotation.getUnusedTitles(rotation.id, rotation.title_category_id)
        : await NewRotation.getTitlesPrioritizingUnused(rotation.id, rotation.title_category_id);
      const thumbnails = rotation.disable_used_thumbnails
        ? await NewRotation.getUnusedThumbnails(rotation.id)
        : await NewRotation.getThumbnailsPrioritizingUnused(rotation.id);
      if (!titles.length || !thumbnails.length) {
        if (now >= end) {
          activeStreams.delete(rotation.id);
          await NewRotation.update(rotation.id, { status: 'completed' });
          console.log(`[NewRotationService] ${rotation.name} completed: no unused title or thumbnail remains`);
        }
        continue;
      }
      // When reuse is allowed, consume all never-used items first. Once every
      // item has been live at least once, continue normal round-robin reuse.
      const unusedTitles = rotation.disable_used_titles ? titles : titles.filter(row => !Number(row.has_been_used));
      const unusedThumbnails = rotation.disable_used_thumbnails ? thumbnails : thumbnails.filter(row => !Number(row.has_been_used));
      const title = unusedTitles.length
        ? unusedTitles[0]
        : titles[rotation.current_title_index % titles.length];
      const thumbnail = unusedThumbnails.length
        ? unusedThumbnails[0]
        : thumbnails[rotation.current_thumbnail_index % thumbnails.length];
      const item = buildItem(rotation, title, thumbnail);
      const windowKey = `${rotation.start_time}|${rotation.end_time}`;

      if (now < start) continue;
      if (now >= end) {
        // The map is intentionally empty after PM2 restart; stopping by the
        // rotation item also finds and stops a recovered managed live stream.
        await rotationService.stopRotationStream(rotation, item);
        activeStreams.delete(rotation.id);
        startingRotations.delete(rotation.id);
        failedStarts.delete(rotation.id);
        await NewRotation.markTitleUsed(rotation.id, title.id);
        await NewRotation.markThumbnailUsed(rotation.id, thumbnail.video_id);
        const remainingTitles = rotation.disable_used_titles ? await NewRotation.getUnusedTitles(rotation.id, rotation.title_category_id) : titles;
        const remainingThumbnails = rotation.disable_used_thumbnails ? await NewRotation.getUnusedThumbnails(rotation.id) : thumbnails;
        if (!remainingTitles.length || !remainingThumbnails.length) {
          await NewRotation.update(rotation.id, { status: 'completed' });
          console.log(`[NewRotationService] ${rotation.name} completed: all configured metadata has been used`);
          continue;
        }
        const schedule = await nextSchedule(rotation);
        await NewRotation.update(rotation.id, {
          current_title_index: rotation.disable_used_titles ? 0 : (rotation.current_title_index + 1) % titles.length,
          current_thumbnail_index: rotation.disable_used_thumbnails ? 0 : (rotation.current_thumbnail_index + 1) % thumbnails.length,
          start_time: formatLocal(schedule.start), end_time: formatLocal(schedule.end)
        });
        console.log(`[NewRotationService] ${rotation.name} scheduled next metadata at ${formatLocal(schedule.start)}`);
        continue;
      }

      if (failedStarts.get(rotation.id) === windowKey || activeStreams.has(rotation.id) || startingRotations.has(rotation.id)) {
        continue;
      }

      startingRotations.add(rotation.id);
      try {
        const result = await rotationService.startRotationStream(rotation, item);
        if (result.success) {
          activeStreams.set(rotation.id, { streamId: result.streamId, windowKey });
          failedStarts.delete(rotation.id);
          await NewRotation.update(rotation.id, { live_count: (rotation.live_count || 0) + 1 });
        } else {
          // Do not repeatedly create broadcasts/retry a failed source during the same time window.
          failedStarts.set(rotation.id, windowKey);
          console.error(`[NewRotationService] Failed to start ${rotation.name}: ${result.error}`);
        }
      } finally {
        startingRotations.delete(rotation.id);
      }
    }
  } catch (error) {
    console.error('[NewRotationService] Error checking rotations:', error);
  }
}

async function activateRotation(id) {
  const rotation = await NewRotation.findById(id);
  if (!rotation) return { success: false, error: 'New Rotation not found' };
  const originalStart = parseLocal(rotation.start_time);
  const originalEnd = parseLocal(rotation.end_time);
  const now = new Date();
  const start = new Date(now); start.setHours(originalStart.getHours(), originalStart.getMinutes(), 0, 0);
  const end = new Date(now); end.setHours(originalEnd.getHours(), originalEnd.getMinutes(), 0, 0);
  if (end <= start) end.setDate(end.getDate() + 1);
  const repeatMode = rotation.repeat_mode || 'daily';
  const weekdays = selectedWeekdays(rotation);
  if (repeatMode === 'weekly') {
    const slot = await nextWeeklySlot(rotation, now);
    if (slot) {
      await NewRotation.update(id, { status: 'active', start_time: formatLocal(slot.start), end_time: formatLocal(slot.end) });
      return { success: true };
    }
    while (start <= now || (weekdays.length && !weekdays.includes(start.getDay()))) {
      start.setDate(start.getDate() + 1); end.setDate(end.getDate() + 1);
    }
  } else if (repeatMode === 'monthly') {
    while (start <= now) { start.setMonth(start.getMonth() + 1); end.setMonth(end.getMonth() + 1); }
  } else if (now >= start) {
    start.setDate(start.getDate() + 1); end.setDate(end.getDate() + 1);
  }
  await NewRotation.update(id, { status: 'active', start_time: formatLocal(start), end_time: formatLocal(end) });
  return { success: true };
}
async function stopRotation(id) {
  const rotation = await NewRotation.findById(id);
  if (!rotation) return { success: false, error: 'New Rotation not found' };
  const titles = rotation.disable_used_titles
    ? await NewRotation.getUnusedTitles(rotation.id, rotation.title_category_id)
    : await NewRotation.getTitlesPrioritizingUnused(rotation.id, rotation.title_category_id);
  const thumbs = rotation.disable_used_thumbnails
    ? await NewRotation.getUnusedThumbnails(rotation.id)
    : await NewRotation.getThumbnailsPrioritizingUnused(rotation.id);
  const unusedTitles = rotation.disable_used_titles ? titles : titles.filter(row => !Number(row.has_been_used));
  const unusedThumbs = rotation.disable_used_thumbnails ? thumbs : thumbs.filter(row => !Number(row.has_been_used));
  const title = unusedTitles.length ? unusedTitles[0] : titles[rotation.current_title_index % titles.length];
  const thumb = unusedThumbs.length ? unusedThumbs[0] : thumbs[rotation.current_thumbnail_index % thumbs.length];
  if (title && thumb) await rotationService.stopRotationStream(rotation, buildItem(rotation, title, thumb));
  activeStreams.delete(id);
  startingRotations.delete(id);
  failedStarts.delete(id);
  await NewRotation.update(id, { status: 'inactive', current_title_index: 0, current_thumbnail_index: 0 });
  return { success: true };
}
function init() { intervalId = setInterval(checkRotations, 60 * 1000); checkRotations(); }
function shutdown() {
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
  activeStreams.clear();
  startingRotations.clear();
  failedStarts.clear();
}
module.exports = { init, shutdown, checkRotations, activateRotation, stopRotation };
