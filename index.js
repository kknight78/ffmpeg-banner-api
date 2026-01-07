const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const cloudinary = require('cloudinary').v2;

const app = express();
app.use(express.json());

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Temp directory for processing
const TEMP_DIR = '/tmp';

// Platform colors (optional - currently all use same style)
const PLATFORM_COLORS = {
  YOUTUBE: { bg: '0x1a325b', text: '0xfeb628' },
  TIKTOK: { bg: '0x1a325b', text: '0xfeb628' },
  FACEBOOK: { bg: '0x1a325b', text: '0xfeb628' },
  INSTAGRAM: { bg: '0x1a325b', text: '0xfeb628' }
};

// Download video from URL
async function downloadVideo(url, outputPath) {
  const response = await axios({
    method: 'GET',
    url: url,
    responseType: 'stream'
  });

  const writer = fs.createWriteStream(outputPath);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// Get video dimensions
function getVideoDimensions(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) return reject(err);
      const video = metadata.streams.find(s => s.codec_type === 'video');
      resolve({
        width: video.width,
        height: video.height,
        duration: metadata.format.duration
      });
    });
  });
}

// Add scrolling banner to video
async function addScrollingBanner(inputPath, outputPath, options) {
  const { avatarName, platform, duration } = options;
  const text = `Ask for ${avatarName} and mention you saw this on ${platform}!`;

  // Get video dimensions
  const { width, height } = await getVideoDimensions(inputPath);

  // Banner settings matching Creatomate
  const colors = PLATFORM_COLORS[platform] || PLATFORM_COLORS.YOUTUBE;
  const fontSize = Math.round(Math.min(width, height) * 0.04); // 4 vmin equivalent
  const bannerY = Math.round(height * 0.159); // ~16% from top

  // Calculate scroll speed - text should scroll 3 times in video duration
  // Speed = (text_width + video_width) * 3 / duration
  // We estimate text width as roughly fontSize * text.length * 0.6
  const estimatedTextWidth = fontSize * text.length * 0.6;
  const totalScrollDistance = (estimatedTextWidth + width) * 3;
  const scrollSpeed = totalScrollDistance / duration;

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoFilters([
        {
          filter: 'drawtext',
          options: {
            text: text,
            fontfile: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
            fontsize: fontSize,
            fontcolor: colors.text.replace('0x', '#'),
            box: 1,
            boxcolor: colors.bg.replace('0x', '#'),
            boxborderw: Math.round(fontSize * 0.3),
            x: `w-mod(t*${scrollSpeed}\\,w+tw+100)`,
            y: bannerY
          }
        }
      ])
      .outputOptions([
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-c:a', 'copy'
      ])
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .save(outputPath);
  });
}

// Upload to Cloudinary
async function uploadToCloudinary(filePath, folder = 'ad-pilot-banners') {
  const result = await cloudinary.uploader.upload(filePath, {
    resource_type: 'video',
    folder: folder,
    overwrite: true
  });
  return result.secure_url;
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ffmpeg-banner-api' });
});

// Main endpoint: Add banner to video
app.post('/add-banner', async (req, res) => {
  const { video_url, avatar_name, platform, duration } = req.body;

  if (!video_url || !avatar_name || !platform) {
    return res.status(400).json({
      error: 'Missing required fields: video_url, avatar_name, platform'
    });
  }

  const jobId = uuidv4();
  const inputPath = path.join(TEMP_DIR, `input-${jobId}.mp4`);
  const outputPath = path.join(TEMP_DIR, `output-${jobId}.mp4`);

  try {
    console.log(`[${jobId}] Starting banner job for ${platform}`);

    // Download video
    console.log(`[${jobId}] Downloading video...`);
    await downloadVideo(video_url, inputPath);

    // Get video info if duration not provided
    let videoDuration = duration;
    if (!videoDuration) {
      const info = await getVideoDimensions(inputPath);
      videoDuration = info.duration;
    }

    // Add banner
    console.log(`[${jobId}] Adding scrolling banner...`);
    await addScrollingBanner(inputPath, outputPath, {
      avatarName: avatar_name,
      platform: platform.toUpperCase(),
      duration: videoDuration
    });

    // Upload to Cloudinary
    console.log(`[${jobId}] Uploading to Cloudinary...`);
    const outputUrl = await uploadToCloudinary(outputPath);

    // Cleanup temp files
    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);

    console.log(`[${jobId}] Complete! ${outputUrl}`);

    res.json({
      success: true,
      video_url: outputUrl,
      platform: platform.toUpperCase(),
      avatar_name: avatar_name
    });

  } catch (error) {
    console.error(`[${jobId}] Error:`, error);

    // Cleanup on error
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

    res.status(500).json({
      error: 'Failed to process video',
      details: error.message
    });
  }
});

// Batch endpoint: Add banners for multiple platforms
app.post('/add-banners-batch', async (req, res) => {
  const { video_url, avatar_name, platforms, duration } = req.body;

  if (!video_url || !avatar_name || !platforms || !Array.isArray(platforms)) {
    return res.status(400).json({
      error: 'Missing required fields: video_url, avatar_name, platforms (array)'
    });
  }

  const jobId = uuidv4();
  const inputPath = path.join(TEMP_DIR, `input-${jobId}.mp4`);
  const results = [];

  try {
    console.log(`[${jobId}] Starting batch job for ${platforms.length} platforms`);

    // Download video once
    console.log(`[${jobId}] Downloading video...`);
    await downloadVideo(video_url, inputPath);

    // Get video info
    const info = await getVideoDimensions(inputPath);
    const videoDuration = duration || info.duration;

    // Process each platform
    for (const platform of platforms) {
      const outputPath = path.join(TEMP_DIR, `output-${jobId}-${platform}.mp4`);

      console.log(`[${jobId}] Processing ${platform}...`);
      await addScrollingBanner(inputPath, outputPath, {
        avatarName: avatar_name,
        platform: platform.toUpperCase(),
        duration: videoDuration
      });

      const outputUrl = await uploadToCloudinary(outputPath);
      fs.unlinkSync(outputPath);

      results.push({
        platform: platform.toUpperCase(),
        video_url: outputUrl
      });
    }

    // Cleanup input
    fs.unlinkSync(inputPath);

    console.log(`[${jobId}] Batch complete!`);

    res.json({
      success: true,
      avatar_name: avatar_name,
      results: results
    });

  } catch (error) {
    console.error(`[${jobId}] Error:`, error);

    // Cleanup
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);

    res.status(500).json({
      error: 'Failed to process videos',
      details: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ffmpeg-banner-api running on port ${PORT}`);
});
