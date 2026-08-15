const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');

function all(sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || [])));
}
function one(sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}
function run(sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function(err) { err ? reject(err) : resolve(this); }));
}

class NewRotation {
  static async getCategories(userId) {
    const categories = await all(`SELECT c.*, COUNT(t.id) AS title_count
      FROM new_rotation_title_categories c LEFT JOIN new_rotation_titles t ON t.category_id = c.id
      WHERE c.user_id = ? GROUP BY c.id ORDER BY c.name COLLATE NOCASE`, [userId]);
    for (const category of categories) {
      category.titles = await all(`SELECT t.*, EXISTS(
        SELECT 1 FROM new_rotation_used_titles used JOIN new_rotations r ON r.id = used.rotation_id
        WHERE used.title_id = t.id AND r.user_id = ?
      ) AS used_live FROM new_rotation_titles t WHERE t.category_id = ? ORDER BY t.order_index`, [userId, category.id]);
    }
    return categories;
  }

  static async createCategory(userId, name) {
    const id = uuidv4();
    await run('INSERT INTO new_rotation_title_categories (id, user_id, name) VALUES (?, ?, ?)', [id, userId, name.trim()]);
    return { id, user_id: userId, name: name.trim() };
  }

  static async addTitle(categoryId, title) {
    const id = uuidv4();
    const row = await one('SELECT COALESCE(MAX(order_index), -1) + 1 AS next_index FROM new_rotation_titles WHERE category_id = ?', [categoryId]);
    await run('INSERT INTO new_rotation_titles (id, category_id, title, order_index) VALUES (?, ?, ?, ?)', [id, categoryId, title.trim(), row.next_index]);
    return { id, category_id: categoryId, title: title.trim(), order_index: row.next_index };
  }

  static async addTitles(categoryId, rawTitles) {
    const titles = String(rawTitles || '').split(/[\n,]+/).map(title => title.trim()).filter(Boolean);
    if (!titles.length) return [];
    const row = await one('SELECT COALESCE(MAX(order_index), -1) + 1 AS next_index FROM new_rotation_titles WHERE category_id = ?', [categoryId]);
    await run('BEGIN TRANSACTION');
    try {
      const created = [];
      for (let index = 0; index < titles.length; index++) {
        const id = uuidv4();
        await run('INSERT INTO new_rotation_titles (id, category_id, title, order_index) VALUES (?, ?, ?, ?)', [id, categoryId, titles[index], row.next_index + index]);
        created.push({ id, category_id: categoryId, title: titles[index], order_index: row.next_index + index });
      }
      await run('COMMIT');
      return created;
    } catch (error) {
      await run('ROLLBACK');
      throw error;
    }
  }

  static deleteCategory(id, userId) { return run('DELETE FROM new_rotation_title_categories WHERE id = ? AND user_id = ?', [id, userId]); }
  static async isCategoryInUse(id) {
    const result = await one('SELECT COUNT(*) AS count FROM new_rotations WHERE title_category_id = ?', [id]);
    return result.count > 0;
  }
  static deleteTitle(id, userId) {
    return run(`DELETE FROM new_rotation_titles WHERE id = ? AND category_id IN
      (SELECT id FROM new_rotation_title_categories WHERE user_id = ?)`, [id, userId]);
  }

  static async create(data, thumbnailVideoIds) {
    const id = uuidv4();
    await run(`INSERT INTO new_rotations (id, user_id, name, video_id, title_category_id, description, tags, privacy, category,
      youtube_monetization, youtube_channel_id, youtube_playlist_id, start_time, end_time, repeat_mode, repeat_days, disable_used_titles, disable_used_thumbnails)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, data.user_id, data.name, data.video_id, data.title_category_id, data.description || '', data.tags || '',
        data.privacy || 'unlisted', data.category || '22', data.youtube_monetization ? 1 : 0, data.youtube_channel_id || null, data.youtube_playlist_id || null,
        data.start_time, data.end_time, data.repeat_mode || 'daily', data.repeat_days || '', data.disable_used_titles ? 1 : 0, data.disable_used_thumbnails ? 1 : 0]);
    for (let i = 0; i < thumbnailVideoIds.length; i++) {
      await run('INSERT INTO new_rotation_thumbnails (id, rotation_id, video_id, order_index) VALUES (?, ?, ?, ?)', [uuidv4(), id, thumbnailVideoIds[i], i]);
    }
    return this.findById(id);
  }

  static findAll(userId) {
    return all(`SELECT r.*, c.name AS title_category_name, yc.channel_name AS youtube_channel_name,
      (SELECT COUNT(*) FROM new_rotation_titles t WHERE t.category_id = r.title_category_id AND t.is_active = 1) AS title_count,
      (SELECT COUNT(*) FROM new_rotation_thumbnails nt WHERE nt.rotation_id = r.id) AS thumbnail_count
      FROM new_rotations r JOIN new_rotation_title_categories c ON c.id = r.title_category_id
      LEFT JOIN youtube_channels yc ON yc.id = r.youtube_channel_id WHERE r.user_id = ? ORDER BY r.created_at DESC`, [userId]);
  }
  static findAllActive() {
    return all('SELECT * FROM new_rotations WHERE status = ?', ['active']);
  }
  static findAllPending() { return all("SELECT * FROM new_rotations WHERE preparation_status IN ('pending', 'processing')"); }
  static findForPlaylist(playlistId) {
    return all("SELECT * FROM new_rotations WHERE video_id = ?", [`playlist:${playlistId}`]);
  }
  static findById(id) { return one('SELECT * FROM new_rotations WHERE id = ?', [id]); }
  static async findByIdWithThumbnails(id) {
    const rotation = await this.findById(id);
    if (!rotation) return null;
    rotation.thumbnails = await all(`SELECT nt.video_id, nt.order_index, v.folder_id
      FROM new_rotation_thumbnails nt JOIN videos v ON v.id = nt.video_id
      WHERE nt.rotation_id = ? ORDER BY nt.order_index`, [id]);
    rotation.schedule_slots = await this.getScheduleSlots(id);
    return rotation;
  }
  static getTitles(categoryId) { return all('SELECT * FROM new_rotation_titles WHERE category_id = ? AND is_active = 1 ORDER BY order_index', [categoryId]); }
  // Reuse is allowed by default, but new metadata must be consumed before an
  // old title is selected again. `has_been_used` is only a priority flag; it
  // does not disable the title.
  static getTitlesPrioritizingUnused(rotationId, categoryId) {
    return all(`SELECT t.*, CASE WHEN used.title_id IS NULL THEN 0 ELSE 1 END AS has_been_used
      FROM new_rotation_titles t
      LEFT JOIN new_rotation_used_titles used ON used.rotation_id = ? AND used.title_id = t.id
      WHERE t.category_id = ? AND t.is_active = 1
      ORDER BY has_been_used ASC, t.order_index ASC`, [rotationId, categoryId]);
  }
  static getUnusedTitles(rotationId, categoryId) {
    return all(`SELECT t.* FROM new_rotation_titles t WHERE t.category_id = ? AND t.is_active = 1 AND t.id NOT IN
      (SELECT title_id FROM new_rotation_used_titles WHERE rotation_id = ?) ORDER BY t.order_index`, [categoryId, rotationId]);
  }
  static getThumbnails(rotationId) {
    return all(`SELECT nt.*, v.filepath, v.thumbnail_path FROM new_rotation_thumbnails nt JOIN videos v ON v.id = nt.video_id
      WHERE nt.rotation_id = ? ORDER BY nt.order_index`, [rotationId]);
  }
  static getThumbnailsPrioritizingUnused(rotationId) {
    return all(`SELECT nt.*, v.filepath, v.thumbnail_path,
      CASE WHEN used.video_id IS NULL THEN 0 ELSE 1 END AS has_been_used
      FROM new_rotation_thumbnails nt
      JOIN videos v ON v.id = nt.video_id
      LEFT JOIN new_rotation_used_thumbnails used ON used.rotation_id = nt.rotation_id AND used.video_id = nt.video_id
      WHERE nt.rotation_id = ?
      ORDER BY has_been_used ASC, nt.order_index ASC`, [rotationId]);
  }
  static getUnusedThumbnails(rotationId) {
    return all(`SELECT nt.*, v.filepath, v.thumbnail_path FROM new_rotation_thumbnails nt JOIN videos v ON v.id = nt.video_id
      WHERE nt.rotation_id = ? AND nt.video_id NOT IN (SELECT video_id FROM new_rotation_used_thumbnails WHERE rotation_id = ?) ORDER BY nt.order_index`, [rotationId, rotationId]);
  }
  static markTitleUsed(rotationId, titleId) { return run('INSERT OR IGNORE INTO new_rotation_used_titles (id, rotation_id, title_id) VALUES (?, ?, ?)', [uuidv4(), rotationId, titleId]); }
  static markThumbnailUsed(rotationId, videoId) { return run('INSERT OR IGNORE INTO new_rotation_used_thumbnails (id, rotation_id, video_id) VALUES (?, ?, ?)', [uuidv4(), rotationId, videoId]); }
  static clearUsedItems(rotationId) { return Promise.all([run('DELETE FROM new_rotation_used_titles WHERE rotation_id = ?', [rotationId]), run('DELETE FROM new_rotation_used_thumbnails WHERE rotation_id = ?', [rotationId])]); }
  static playlistEntryExists(rotationId, broadcastId) { return one('SELECT id FROM new_rotation_playlist_entries WHERE rotation_id = ? AND broadcast_id = ?', [rotationId, broadcastId]); }
  static markPlaylistEntry(rotationId, broadcastId, playlistId) { return run('INSERT OR IGNORE INTO new_rotation_playlist_entries (id, rotation_id, broadcast_id, playlist_id) VALUES (?, ?, ?, ?)', [uuidv4(), rotationId, broadcastId, playlistId]); }
  static getPreparedMedia(rotationId) { return all('SELECT video_id FROM new_rotation_prepared_media WHERE rotation_id = ?', [rotationId]); }
  static async getGalleryUsage(userId) {
    const usage = new Map();
    const add = (videoId, data) => usage.set(videoId, { ...(usage.get(videoId) || {}), ...data });
    const [thumbnails] = await Promise.all([
      all(`SELECT nt.video_id, MAX(CASE WHEN used.video_id IS NOT NULL THEN 1 ELSE 0 END) AS used_live
        FROM new_rotation_thumbnails nt JOIN new_rotations r ON r.id = nt.rotation_id
        LEFT JOIN new_rotation_used_thumbnails used ON used.rotation_id = nt.rotation_id AND used.video_id = nt.video_id
        WHERE r.user_id = ? GROUP BY nt.video_id`, [userId]),
    ]);
    thumbnails.forEach(row => add(row.video_id, { new_rotation_thumbnail: 1, thumbnail_used_live: Number(row.used_live) }));
    return usage;
  }
  static markPreparedMedia(rotationId, videoId) { return run('INSERT OR IGNORE INTO new_rotation_prepared_media (id, rotation_id, video_id) VALUES (?, ?, ?)', [uuidv4(), rotationId, videoId]); }
  static removePreparedMedia(rotationId, videoId) { return run('DELETE FROM new_rotation_prepared_media WHERE rotation_id = ? AND video_id = ?', [rotationId, videoId]); }
  static getScheduleSlots(rotationId) { return all('SELECT * FROM new_rotation_schedule_slots WHERE rotation_id = ? ORDER BY day_of_week, start_time, order_index', [rotationId]); }
  static async replaceScheduleSlots(rotationId, slots) {
    await run('DELETE FROM new_rotation_schedule_slots WHERE rotation_id = ?', [rotationId]);
    for (let index = 0; index < slots.length; index++) {
      const slot = slots[index];
      await run('INSERT INTO new_rotation_schedule_slots (id, rotation_id, day_of_week, start_time, end_time, order_index) VALUES (?, ?, ?, ?, ?, ?)', [uuidv4(), rotationId, slot.day_of_week, slot.start_time, slot.end_time, index]);
    }
  }
  static update(id, data) {
    const fields = Object.keys(data); if (!fields.length) return Promise.resolve();
    return run(`UPDATE new_rotations SET ${fields.map(key => `${key} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [...fields.map(key => data[key]), id]);
  }
  static async replaceThumbnails(id, thumbnailVideoIds) {
    await run('DELETE FROM new_rotation_thumbnails WHERE rotation_id = ?', [id]);
    for (let index = 0; index < thumbnailVideoIds.length; index++) {
      await run('INSERT INTO new_rotation_thumbnails (id, rotation_id, video_id, order_index) VALUES (?, ?, ?, ?)', [uuidv4(), id, thumbnailVideoIds[index], index]);
    }
  }
  static delete(id, userId) { return run('DELETE FROM new_rotations WHERE id = ? AND user_id = ?', [id, userId]); }
}
module.exports = NewRotation;
