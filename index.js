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

// Default banner settings (can be overridden per-request via banner_config)
const DEFAULT_BANNER_CONFIG = {
  y_percent: 0.159,           // Position: ~16% from top
  font_size_percent: 0.04,    // Font: 4% of min dimension
  show_background: false,     // No background box by default
  text_color: '#feb628',      // Gold text
  bg_color: '#1a325b'         // Navy background (if show_background: true)
};

// Download video from URL with retry for CDN propagation delays
async function downloadVideo(url, outputPath, maxRetries = 5, initialDelay = 2000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream',
        timeout: 60000
      });

      const writer = fs.createWriteStream(outputPath);
      response.data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
    } catch (error) {
      const status = error.response?.status;

      // Retry on 404 (CDN not ready) or 5xx (server errors)
      if ((status === 404 || status >= 500) && attempt < maxRetries) {
        const delay = initialDelay * Math.pow(2, attempt - 1); // Exponential backoff
        console.log(`  Download attempt ${attempt} failed (${status}), retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      throw error;
    }
  }
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

// Infer template height from video aspect ratio (standard Creatomate dimensions)
function inferTemplateHeight(width, height) {
  const aspectRatio = width / height;
  if (aspectRatio < 0.7) return 1280;      // 9:16 (portrait) → 720x1280
  if (aspectRatio < 0.9) return 1350;      // 4:5 → 1080x1350
  if (aspectRatio < 1.1) return 1080;      // 1:1 (square) → 1080x1080
  return 720;                               // 16:9 (landscape) → 1280x720
}

// Add scrolling banner to video
async function addScrollingBanner(inputPath, outputPath, options) {
  const { avatarName, platform, duration, bannerConfig = {} } = options;
  const text = `Ask for ${avatarName} and mention you saw this on ${platform}!`;

  // Get video dimensions
  const { width, height } = await getVideoDimensions(inputPath);

  // Merge banner config with defaults
  const config = { ...DEFAULT_BANNER_CONFIG, ...bannerConfig };

  // Calculate font size - prefer font_size_percent, fall back to converting pixel value
  let fontSize;
  if (config.font_size_percent !== undefined) {
    fontSize = Math.round(Math.min(width, height) * config.font_size_percent);
  } else if (config.font_size !== undefined) {
    // Convert pixel font_size to percentage based on template dimensions
    const templateHeight = config.template_height || inferTemplateHeight(width, height);
    const fontSizePercent = config.font_size / Math.min(templateHeight, templateHeight * (width / height));
    fontSize = Math.round(Math.min(width, height) * fontSizePercent);
  } else {
    fontSize = Math.round(Math.min(width, height) * DEFAULT_BANNER_CONFIG.font_size_percent);
  }

  // Calculate Y position - prefer y_percent, fall back to converting pixel value
  let yPercent;
  if (config.y_percent !== undefined) {
    yPercent = config.y_percent;
  } else if (config.y !== undefined) {
    // Convert pixel y to percentage based on template height
    const templateHeight = config.template_height || inferTemplateHeight(width, height);
    yPercent = config.y / templateHeight;
  } else {
    yPercent = DEFAULT_BANNER_CONFIG.y_percent;
  }

  // Creatomate y positions the top of the text bounding box (includes line-height padding)
  // ffmpeg positions the top of actual text glyphs, so add ~30% of fontSize to compensate
  const bannerY = Math.round(height * yPercent + fontSize * 0.3);
  const textColor = (config.text_color || config.fill_color || DEFAULT_BANNER_CONFIG.text_color).replace('0x', '#');
  const bgColor = config.bg_color.replace('0x', '#');

  console.log(`  Banner config received:`, JSON.stringify(bannerConfig));
  console.log(`  Banner positioning: y=${bannerY}px (${(yPercent * 100).toFixed(1)}% of ${height}px), fontSize=${fontSize}px, showBg=${config.show_background}`);

  // Calculate scroll speed - text should scroll 2 times in video duration
  const estimatedTextWidth = fontSize * text.length * 0.6;
  const totalScrollDistance = (estimatedTextWidth + width) * 2;
  const scrollSpeed = totalScrollDistance / duration;

  // Build drawtext options
  const drawtextOptions = {
    text: text,
    fontfile: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    fontsize: fontSize,
    fontcolor: textColor,
    x: `w-mod(t*${scrollSpeed}\\,w+tw+100)`,
    y: bannerY
  };

  // Only add background box if show_background is true
  if (config.show_background) {
    drawtextOptions.box = 1;
    drawtextOptions.boxcolor = bgColor;
    drawtextOptions.boxborderw = Math.round(fontSize * 0.3);
  }

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoFilters([
        {
          filter: 'drawtext',
          options: drawtextOptions
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
  const { video_url, avatar_name, platform, duration, banner_config } = req.body;

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
    if (banner_config) {
      console.log(`[${jobId}] Custom banner_config:`, JSON.stringify(banner_config));
    }

    // Download video
    console.log(`[${jobId}] Downloading video...`);
    await downloadVideo(video_url, inputPath);

    // Get video info if duration not provided
    let videoDuration = duration;
    if (!videoDuration) {
      const info = await getVideoDimensions(inputPath);
      videoDuration = info.duration;
    }

    // Add banner with optional custom config
    console.log(`[${jobId}] Adding scrolling banner...`);
    await addScrollingBanner(inputPath, outputPath, {
      avatarName: avatar_name,
      platform: platform.toUpperCase(),
      duration: videoDuration,
      bannerConfig: banner_config
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
  const { video_url, avatar_name, platforms, duration, banner_config } = req.body;

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
    if (banner_config) {
      console.log(`[${jobId}] Custom banner_config:`, JSON.stringify(banner_config));
    }

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
        duration: videoDuration,
        bannerConfig: banner_config
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
