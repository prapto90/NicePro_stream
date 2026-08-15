const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { getVideoDurationInSeconds } = require('get-video-duration');
const fs = require('fs');
const path = require('path');
const { getUniqueFilename, paths } = require('./storage');
ffmpeg.setFfmpegPath(ffmpegPath);
const getVideoInfo = async (filepath) => {
  try {
    const duration = await getVideoDurationInSeconds(filepath);
    const stats = fs.statSync(filepath);
    const fileSizeInBytes = stats.size;
    return {
      duration,
      fileSize: fileSizeInBytes
    };
  } catch (error) {
    console.error('Error getting video info:', error);
    throw error;
  }
};
const generateThumbnail = (videoPath, thumbnailName) => {
  return new Promise((resolve, reject) => {
    const thumbnailPath = path.join(paths.thumbnails, thumbnailName);
    ffmpeg(videoPath)
      .screenshots({
        count: 1,
        folder: paths.thumbnails,
        filename: thumbnailName,
        size: '320x180'
      })
      .on('end', () => {
        resolve(thumbnailPath);
      })
      .on('error', (err) => {
        console.error('Error generating thumbnail:', err);
        reject(err);
      });
  });
};

const generateImageThumbnail = (imagePath, thumbnailName) => {
  return new Promise((resolve, reject) => {
    const thumbnailPath = path.join(paths.thumbnails, thumbnailName);
    ffmpeg(imagePath)
      .outputOptions([
        '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2'
      ])
      .output(thumbnailPath)
      .on('end', () => {
        resolve(thumbnailPath);
      })
      .on('error', (err) => {
        console.error('Error generating image thumbnail:', err);
        reject(err);
      })
      .run();
  });
};

// YouTube is stricter than the Gallery preview: normalize every source image to a
// conventional 1280x720 JPEG before it is sent to the thumbnails API.
const generateYouTubeThumbnail = (imagePath, thumbnailName) => {
  return new Promise((resolve, reject) => {
    const thumbnailPath = path.join(paths.thumbnails, thumbnailName);
    ffmpeg(imagePath)
      .outputOptions([
        '-frames:v 1',
        '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black',
        '-q:v', '2'
      ])
      .output(thumbnailPath)
      .on('end', () => resolve(thumbnailPath))
      .on('error', reject)
      .run();
  });
};

const normalizeVideoForRotation = (inputPath, outputPath) => new Promise((resolve, reject) => {
  ffmpeg(inputPath).outputOptions(['-c:v libx264', '-preset veryfast', '-pix_fmt yuv420p', '-vf scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black', '-r 30', '-b:v 4000k', '-minrate 4000k', '-maxrate 4000k', '-bufsize 8000k', '-x264-params nal-hrd=cbr:force-cfr=1', '-g 60', '-keyint_min 60', '-c:a aac', '-b:a 128k', '-ar 44100', '-ac 2', '-movflags +faststart']).output(outputPath).on('end', resolve).on('error', reject).run();
});

module.exports = {
  getVideoInfo,
  generateThumbnail,
  generateImageThumbnail,
  generateYouTubeThumbnail,
  normalizeVideoForRotation
};
