const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const dbDir = path.join(__dirname);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const dbPath = path.join(dbDir, 'streamflow.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error connecting to database:', err.message);
  }
});

function dbGet(sql) {
  return new Promise((resolve, reject) => db.get(sql, (err, row) => err ? reject(err) : resolve(row)));
}
function dbRun(sql) {
  return new Promise((resolve, reject) => db.run(sql, err => err ? reject(err) : resolve()));
}

async function migrateNewRotationTableNames() {
  const oldCategories = await dbGet("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rotation_title_categories'");
  const newCategories = await dbGet("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'new_rotation_title_categories'");
  if (oldCategories && !newCategories) await dbRun('ALTER TABLE rotation_title_categories RENAME TO new_rotation_title_categories');
  const oldTitles = await dbGet("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rotation_titles'");
  const newTitles = await dbGet("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'new_rotation_titles'");
  if (oldTitles && !newTitles) await dbRun('ALTER TABLE rotation_titles RENAME TO new_rotation_titles');
}

function createTables() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        avatar_path TEXT,
        gdrive_api_key TEXT,
        user_role TEXT DEFAULT 'admin',
        status TEXT DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      
      db.run(`CREATE TABLE IF NOT EXISTS videos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        filepath TEXT NOT NULL,
        thumbnail_path TEXT,
        file_size INTEGER,
        duration REAL,
        format TEXT,
        resolution TEXT,
        bitrate INTEGER,
        fps TEXT,
        user_id TEXT,
        folder_id TEXT,
        upload_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS media_folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`);
      
      db.run(`CREATE TABLE IF NOT EXISTS streams (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        video_id TEXT,
        rtmp_url TEXT NOT NULL,
        stream_key TEXT NOT NULL,
        platform TEXT,
        platform_icon TEXT,
        bitrate INTEGER DEFAULT 2500,
        resolution TEXT,
        fps INTEGER DEFAULT 30,
        orientation TEXT DEFAULT 'horizontal',
        loop_video BOOLEAN DEFAULT 1,
        schedule_time TIMESTAMP,
        duration INTEGER,
        status TEXT DEFAULT 'offline',
        status_updated_at TIMESTAMP,
        start_time TIMESTAMP,
        end_time TIMESTAMP,
        use_advanced_settings BOOLEAN DEFAULT 0,
        youtube_monetization BOOLEAN DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        user_id TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (video_id) REFERENCES videos(id)
      )`);
      
      db.run(`CREATE TABLE IF NOT EXISTS stream_history (
        id TEXT PRIMARY KEY,
        stream_id TEXT,
        title TEXT NOT NULL,
        platform TEXT,
        platform_icon TEXT,
        video_id TEXT,
        video_title TEXT,
        resolution TEXT,
        bitrate INTEGER,
        fps INTEGER,
        start_time TIMESTAMP,
        end_time TIMESTAMP,
        duration INTEGER,
        use_advanced_settings BOOLEAN DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        user_id TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (stream_id) REFERENCES streams(id),
        FOREIGN KEY (video_id) REFERENCES videos(id)
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS playlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        is_shuffle BOOLEAN DEFAULT 0,
        user_id TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS playlist_videos (
        id TEXT PRIMARY KEY,
        playlist_id TEXT NOT NULL,
        video_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS playlist_audios (
        id TEXT PRIMARY KEY,
        playlist_id TEXT NOT NULL,
        audio_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
        FOREIGN KEY (audio_id) REFERENCES videos(id) ON DELETE CASCADE
      )`);
      
      db.run(`ALTER TABLE users ADD COLUMN user_role TEXT DEFAULT 'admin'`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding user_role column:', err.message);
        }
      });
      
      db.run(`ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active'`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding status column:', err.message);
        }
      });

      db.run(`ALTER TABLE users ADD COLUMN youtube_client_id TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding youtube_client_id column:', err.message);
        }
      });

      db.run(`ALTER TABLE users ADD COLUMN youtube_client_secret TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding youtube_client_secret column:', err.message);
        }
      });

      db.run(`ALTER TABLE users ADD COLUMN youtube_access_token TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding youtube_access_token column:', err.message);
        }
      });

      db.run(`ALTER TABLE users ADD COLUMN youtube_refresh_token TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding youtube_refresh_token column:', err.message);
        }
      });

      db.run(`ALTER TABLE users ADD COLUMN youtube_channel_id TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding youtube_channel_id column:', err.message);
        }
      });

      db.run(`ALTER TABLE users ADD COLUMN youtube_channel_name TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding youtube_channel_name column:', err.message);
        }
      });

      db.run(`ALTER TABLE users ADD COLUMN youtube_channel_thumbnail TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding youtube_channel_thumbnail column:', err.message);
        }
      });

      db.run(`ALTER TABLE users ADD COLUMN youtube_subscriber_count TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding youtube_subscriber_count column:', err.message);
        }
      });

      db.run(`ALTER TABLE streams ADD COLUMN youtube_broadcast_id TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding youtube_broadcast_id column:', err.message);
        }
      });

      db.run(`ALTER TABLE streams ADD COLUMN youtube_stream_id TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding youtube_stream_id column:', err.message);
        }
      });

      db.run(`ALTER TABLE streams ADD COLUMN youtube_description TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding youtube_description column:', err.message);
        }
      });

      db.run(`ALTER TABLE streams ADD COLUMN youtube_privacy TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding youtube_privacy column:', err.message);
        }
      });

      db.run(`ALTER TABLE streams ADD COLUMN youtube_category TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding youtube_category column:', err.message);
        }
      });

      db.run(`ALTER TABLE streams ADD COLUMN youtube_tags TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding youtube_tags column:', err.message);
        }
      });

      db.run(`ALTER TABLE streams ADD COLUMN youtube_thumbnail TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding youtube_thumbnail column:', err.message);
        }
      });

      db.run(`CREATE TABLE IF NOT EXISTS stream_rotations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        gap_minutes INTEGER DEFAULT 10,
        is_loop INTEGER DEFAULT 1,
        status TEXT DEFAULT 'inactive',
        current_index INTEGER DEFAULT 0,
        next_run_at TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS rotation_items (
        id TEXT PRIMARY KEY,
        rotation_id TEXT NOT NULL,
        order_index INTEGER NOT NULL,
        video_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        tags TEXT,
        thumbnail_path TEXT,
        privacy TEXT DEFAULT 'unlisted',
        category TEXT DEFAULT '22',
        youtube_monetization INTEGER DEFAULT 0,
        start_time TEXT,
        end_time TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (rotation_id) REFERENCES stream_rotations(id) ON DELETE CASCADE,
        FOREIGN KEY (video_id) REFERENCES videos(id)
      )`);

      // Add start_time, end_time, and repeat_mode columns to stream_rotations table
      db.run(`ALTER TABLE stream_rotations ADD COLUMN start_time TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding start_time column to stream_rotations:', err.message);
        }
      });

      db.run(`ALTER TABLE stream_rotations ADD COLUMN end_time TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding end_time column to stream_rotations:', err.message);
        }
      });

      db.run(`ALTER TABLE stream_rotations ADD COLUMN repeat_mode TEXT DEFAULT 'none'`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding repeat_mode column to stream_rotations:', err.message);
        }
      });

      db.run(`ALTER TABLE rotation_items ADD COLUMN original_thumbnail_path TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding original_thumbnail_path column to rotation_items:', err.message);
        }
      });

      db.run(`ALTER TABLE rotation_items ADD COLUMN youtube_monetization INTEGER DEFAULT 0`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding youtube_monetization column to rotation_items:', err.message);
        }
      });

      db.run(`ALTER TABLE stream_rotations ADD COLUMN youtube_channel_id TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding youtube_channel_id column to stream_rotations:', err.message);
        }
      });

      db.run(`ALTER TABLE users ADD COLUMN youtube_redirect_uri TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding youtube_redirect_uri column:', err.message);
        }
      });

      db.run(`CREATE TABLE IF NOT EXISTS youtube_channels (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        channel_name TEXT,
        channel_thumbnail TEXT,
        subscriber_count TEXT DEFAULT '0',
        access_token TEXT,
        refresh_token TEXT,
        is_default INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`, (err) => {
        if (err && !err.message.includes('already exists')) {
          console.error('Error creating youtube_channels table:', err.message);
        }
      });

      // New Rotations: one media source with daily rotating title and thumbnail warehouses.
      db.run(`CREATE TABLE IF NOT EXISTS new_rotation_title_categories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, name),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS new_rotation_titles (
        id TEXT PRIMARY KEY,
        category_id TEXT NOT NULL,
        title TEXT NOT NULL,
        order_index INTEGER NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (category_id) REFERENCES new_rotation_title_categories(id) ON DELETE CASCADE
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS new_rotations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        video_id TEXT NOT NULL,
        title_category_id TEXT NOT NULL,
        description TEXT DEFAULT '',
        tags TEXT DEFAULT '',
        privacy TEXT DEFAULT 'unlisted',
        category TEXT DEFAULT '22',
        youtube_monetization INTEGER DEFAULT 0,
        youtube_channel_id TEXT,
        youtube_playlist_id TEXT,
        status TEXT DEFAULT 'inactive',
        current_title_index INTEGER DEFAULT 0,
        current_thumbnail_index INTEGER DEFAULT 0,
        live_count INTEGER DEFAULT 0,
        start_time TEXT,
        end_time TEXT,
        repeat_mode TEXT DEFAULT 'daily',
        repeat_days TEXT DEFAULT '',
        disable_used_titles INTEGER DEFAULT 0,
        disable_used_thumbnails INTEGER DEFAULT 0,
        preparation_status TEXT DEFAULT 'pending',
        preparation_error TEXT,
        sync_new_count INTEGER DEFAULT 0,
        sync_removed_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (title_category_id) REFERENCES new_rotation_title_categories(id),
        FOREIGN KEY (youtube_channel_id) REFERENCES youtube_channels(id)
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS new_rotation_thumbnails (
        id TEXT PRIMARY KEY,
        rotation_id TEXT NOT NULL,
        video_id TEXT NOT NULL,
        order_index INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (rotation_id) REFERENCES new_rotations(id) ON DELETE CASCADE,
        FOREIGN KEY (video_id) REFERENCES videos(id)
      )`);
      db.run(`CREATE TABLE IF NOT EXISTS new_rotation_used_titles (
        id TEXT PRIMARY KEY, rotation_id TEXT NOT NULL, title_id TEXT NOT NULL, used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(rotation_id, title_id), FOREIGN KEY (rotation_id) REFERENCES new_rotations(id) ON DELETE CASCADE
      )`);
      db.run(`CREATE TABLE IF NOT EXISTS new_rotation_used_thumbnails (
        id TEXT PRIMARY KEY, rotation_id TEXT NOT NULL, video_id TEXT NOT NULL, used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(rotation_id, video_id), FOREIGN KEY (rotation_id) REFERENCES new_rotations(id) ON DELETE CASCADE
      )`);
      db.run(`CREATE TABLE IF NOT EXISTS new_rotation_playlist_entries (
        id TEXT PRIMARY KEY, rotation_id TEXT NOT NULL, broadcast_id TEXT NOT NULL, playlist_id TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(rotation_id, broadcast_id), FOREIGN KEY (rotation_id) REFERENCES new_rotations(id) ON DELETE CASCADE
      )`);
      db.run(`CREATE TABLE IF NOT EXISTS new_rotation_prepared_media (
        id TEXT PRIMARY KEY, rotation_id TEXT NOT NULL, video_id TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(rotation_id, video_id), FOREIGN KEY (rotation_id) REFERENCES new_rotations(id) ON DELETE CASCADE
      )`);
      db.run(`CREATE TABLE IF NOT EXISTS new_rotation_schedule_slots (
        id TEXT PRIMARY KEY, rotation_id TEXT NOT NULL, day_of_week INTEGER NOT NULL,
        start_time TEXT NOT NULL, end_time TEXT NOT NULL, order_index INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (rotation_id) REFERENCES new_rotations(id) ON DELETE CASCADE
      )`);

      db.run(`ALTER TABLE new_rotations ADD COLUMN repeat_days TEXT DEFAULT ''`, (err) => {
        if (err && !err.message.includes('duplicate column name')) console.error('Error adding repeat_days column:', err.message);
      });
      db.run(`ALTER TABLE new_rotations ADD COLUMN live_count INTEGER DEFAULT 0`, (err) => {
        if (err && !err.message.includes('duplicate column name')) console.error('Error adding live_count column:', err.message);
      });
      for (const column of ['youtube_playlist_id TEXT', 'disable_used_titles INTEGER DEFAULT 0', 'disable_used_thumbnails INTEGER DEFAULT 0']) {
        db.run(`ALTER TABLE new_rotations ADD COLUMN ${column}`, err => {
          if (err && !err.message.includes('duplicate column name')) console.error(`Error adding new_rotations column: ${err.message}`);
        });
      }
      db.run(`ALTER TABLE new_rotations ADD COLUMN preparation_status TEXT DEFAULT 'pending'`, () => {});
      db.run(`ALTER TABLE new_rotations ADD COLUMN preparation_error TEXT`, () => {});
      db.run(`ALTER TABLE new_rotations ADD COLUMN sync_new_count INTEGER DEFAULT 0`, () => {});
      db.run(`ALTER TABLE new_rotations ADD COLUMN sync_removed_count INTEGER DEFAULT 0`, () => {});

      db.run(`ALTER TABLE streams ADD COLUMN youtube_channel_id TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding youtube_channel_id column to streams:', err.message);
        }
      });

      db.run(`ALTER TABLE videos ADD COLUMN audio_codec TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding audio_codec column to videos:', err.message);
        }
      });

      db.run(`ALTER TABLE videos ADD COLUMN folder_id TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding folder_id column to videos:', err.message);
        }
      });
      db.run(`ALTER TABLE videos ADD COLUMN original_filepath TEXT`, () => {});
      db.run(`ALTER TABLE videos ADD COLUMN rotation_ready INTEGER DEFAULT 0`, () => {});
      db.run(`ALTER TABLE videos ADD COLUMN rotation_ready_profile TEXT`, () => {});

      db.run(`ALTER TABLE streams ADD COLUMN is_youtube_api INTEGER DEFAULT 0`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding is_youtube_api column to streams:', err.message);
        }
      });

      db.run(`ALTER TABLE users ADD COLUMN welcome_shown INTEGER DEFAULT 0`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding welcome_shown column to users:', err.message);
        }
      });

      db.run(`ALTER TABLE streams ADD COLUMN youtube_monetization INTEGER DEFAULT 0`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding youtube_monetization column to streams:', err.message);
        }
      });

      // Managed FFmpeg: a live encoder can be reattached after the Node/PM2
      // process restarts.  The token is used to verify ownership before any
      // signal is ever sent to a PID.
      db.run(`ALTER TABLE streams ADD COLUMN ffmpeg_pid INTEGER`, () => {});
      db.run(`ALTER TABLE streams ADD COLUMN ffmpeg_token TEXT`, () => {});
      db.run(`ALTER TABLE streams ADD COLUMN ffmpeg_started_at TEXT`, () => {});
      db.run(`ALTER TABLE streams ADD COLUMN ffmpeg_state TEXT`, () => {});

      db.run(`ALTER TABLE users ADD COLUMN disk_limit INTEGER DEFAULT 0`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding disk_limit column to users:', err.message);
        }
      });

      db.run(`CREATE TABLE IF NOT EXISTS app_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        setting_key TEXT UNIQUE NOT NULL,
        setting_value TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, (err) => {
        if (err && !err.message.includes('already exists')) {
          console.error('Error creating app_settings table:', err.message);
        }
        resolve();
      });
    });
  });
}
function checkIfUsersExist() {
  return new Promise((resolve, reject) => {
    db.get('SELECT COUNT(*) as count FROM users', [], (err, result) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(result.count > 0);
    });
  });
}
async function initializeDatabase() {
  await migrateNewRotationTableNames();
  await createTables();
  console.log('Database tables initialized successfully');
}

module.exports = {
  db,
  checkIfUsersExist,
  initializeDatabase
};
