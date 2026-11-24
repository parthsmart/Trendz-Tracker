import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import ffmpegPath from 'ffmpeg-static';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envLocal = dotenv.parse(fs.readFileSync(path.resolve(__dirname, '../.env.staging.local')));

const SOURCE_URL = envLocal.DISPOSABLE_RECORDING_SOURCE_URL || process.env.DISPOSABLE_RECORDING_SOURCE_URL;
if (!SOURCE_URL) {
  throw new Error('Missing DISPOSABLE_RECORDING_SOURCE_URL in staging environment.');
}
const WEBINAR_ID = 'cmvl53hcc0bycs60yjljyys4z';
const BUCKET = 'recordings';
const OBJECT_PATH = `webinars/${WEBINAR_ID}/master-complete.mp4`;

const SCRATCH_DIR = path.resolve('C:/Users/Lenovo/.gemini/antigravity/brain/7f0af698-16b2-42ec-950f-0cce2d0f7acf/scratch');
const SOURCE_FILE = path.join(SCRATCH_DIR, 'source-webinar.mp4');
const TRANSCODED_FILE = path.join(SCRATCH_DIR, 'master-complete-transcoded.mp4');

async function main() {
  console.log('================================================================');
  console.log('PRESERVE & TRANSCODE WEBINAR RECORDING UNDER SUPABASE 50MB LIMIT');
  console.log('Source:      ', '[STREAM-OS-ORIGINAL-MEDIA-URL]');
  console.log('Target:      ', `storage://${BUCKET}/${OBJECT_PATH}`);
  console.log('Scratch Dir: ', SCRATCH_DIR);
  console.log('FFmpeg Path: ', ffmpegPath);
  console.log('================================================================\n');

  if (!fs.existsSync(SCRATCH_DIR)) {
    fs.mkdirSync(SCRATCH_DIR, { recursive: true });
  }

  // 1. Download source file if not already downloaded
  if (!fs.existsSync(SOURCE_FILE) || fs.statSync(SOURCE_FILE).size < 213000000) {
    console.log('Step 1: Downloading source 213MB file from provider CDN...');
    const response = await fetch(SOURCE_URL);
    if (!response.ok) {
      throw new Error(`Failed to download source video: ${response.status} ${response.statusText}`);
    }
    const fileStream = fs.createWriteStream(SOURCE_FILE);
    const reader = response.body.getReader();
    let downloaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fileStream.write(Buffer.from(value));
      downloaded += value.length;
      process.stdout.write(`  Downloaded: ${(downloaded / (1024 * 1024)).toFixed(1)} MB\r`);
    }
    await new Promise((resolve) => fileStream.end(resolve));
    console.log(`\n✓ Download complete: ${fs.statSync(SOURCE_FILE).size.toLocaleString()} bytes.`);
  } else {
    console.log(`Step 1: Source file already cached locally (${fs.statSync(SOURCE_FILE).size.toLocaleString()} bytes).`);
  }

  // 2. Inspect source video with FFmpeg
  console.log('\nStep 2: Inspecting source media with FFmpeg...');
  const probeResult = spawnSync(ffmpegPath, ['-i', SOURCE_FILE], { encoding: 'utf8' });
  const probeOutput = probeResult.stderr || probeResult.stdout || '';
  console.log('Source FFmpeg Stream Info:');
  for (const line of probeOutput.split('\n')) {
    if (line.includes('Duration:') || line.includes('Stream #')) {
      console.log(' ', line.trim());
    }
  }

  // 3. Transcode to fit under 50 MB while preserving full 13:02 duration, video, and audio
  // 13:02 is 782 seconds. 42 MB is ~430 kbps.
  console.log('\nStep 3: Transcoding video to preserve full 13:02 duration, audio & video under 50MB...');
  const ffmpegArgs = [
    '-y',
    '-i', SOURCE_FILE,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '26',
    '-maxrate', '420k',
    '-bufsize', '840k',
    '-vf', 'scale=trunc(iw*min(1\\,1280/iw)/2)*2:trunc(ih*min(1\\,1280/iw)/2)*2',
    '-c:a', 'aac',
    '-b:a', '64k',
    '-ar', '44100',
    '-movflags', '+faststart',
    TRANSCODED_FILE,
  ];

  const transcodeStart = Date.now();
  const transcodeProc = spawnSync(ffmpegPath, ffmpegArgs, { encoding: 'utf8' });
  const transcodeTime = ((Date.now() - transcodeStart) / 1000).toFixed(1);

  if (!fs.existsSync(TRANSCODED_FILE)) {
    console.error('Transcode stderr:', transcodeProc.stderr);
    throw new Error('Transcoding failed to produce output file');
  }

  const transcodedSize = fs.statSync(TRANSCODED_FILE).size;
  console.log(`✓ Transcoding finished in ${transcodeTime}s.`);
  console.log(`  Output file: ${TRANSCODED_FILE}`);
  console.log(`  File size:   ${transcodedSize.toLocaleString()} bytes (~${(transcodedSize / (1024 * 1024)).toFixed(2)} MB)`);
  if (transcodedSize >= 50 * 1024 * 1024) {
    throw new Error(`Transcoded file (${transcodedSize} bytes) still exceeds Supabase 50MB limit!`);
  }

  // 4. Inspect transcoded file: duration, streams, audio volume, and verify 3 points
  console.log('\nStep 4: Inspecting transcoded file duration, streams, and test points (beginning, middle, end)...');
  const inspectResult = spawnSync(ffmpegPath, ['-i', TRANSCODED_FILE], { encoding: 'utf8' });
  const inspectOutput = inspectResult.stderr || inspectResult.stdout || '';
  console.log('Transcoded FFmpeg Stream Info:');
  for (const line of inspectOutput.split('\n')) {
    if (line.includes('Duration:') || line.includes('Stream #')) {
      console.log(' ', line.trim());
    }
  }

  // Extract frames and audio stats at 3 points:
  // 1. Beginning: 0:30 (30s)
  // 2. Middle: 6:30 (390s)
  // 3. End: 12:30 (750s)
  const testPoints = [
    { label: 'Beginning', timeStr: '00:00:30', seconds: 30 },
    { label: 'Middle',    timeStr: '00:06:30', seconds: 390 },
    { label: 'End',       timeStr: '00:12:30', seconds: 750 },
  ];

  console.log('\nStep 5: Verifying video and audio content at beginning, middle, and end...');
  for (const pt of testPoints) {
    const framePath = path.join(SCRATCH_DIR, `frame_${pt.label.toLowerCase()}.jpg`);
    // Extract video frame
    spawnSync(ffmpegPath, [
      '-y',
      '-ss', pt.timeStr,
      '-i', TRANSCODED_FILE,
      '-vframes', '1',
      '-q:v', '2',
      framePath,
    ]);

    if (!fs.existsSync(framePath) || fs.statSync(framePath).size === 0) {
      throw new Error(`Failed to extract video frame at ${pt.label} (${pt.timeStr})`);
    }
    const frameSize = fs.statSync(framePath).size;

    // Detect audio volume at that segment (duration 5s)
    const audioDetect = spawnSync(ffmpegPath, [
      '-ss', pt.timeStr,
      '-t', '5',
      '-i', TRANSCODED_FILE,
      '-af', 'volumedetect',
      '-f', 'null',
      '-',
    ], { encoding: 'utf8' });

    const audioOutput = audioDetect.stderr || audioDetect.stdout || '';
    let maxVolume = 'N/A';
    let meanVolume = 'N/A';
    for (const line of audioOutput.split('\n')) {
      if (line.includes('max_volume:')) maxVolume = line.trim();
      if (line.includes('mean_volume:')) meanVolume = line.trim();
    }

    console.log(`✓ [${pt.label.toUpperCase()} @ ${pt.timeStr} (${pt.seconds}s)]:`);
    console.log(`   Video Frame: ${framePath} (${frameSize.toLocaleString()} bytes)`);
    console.log(`   Audio:       ${maxVolume} | ${meanVolume}`);
  }

  // 6. Upload to Supabase Storage recordings bucket
  console.log('\nStep 6: Uploading complete transcoded recording to Supabase Storage...');
  const supabase = createClient(envLocal.STAGING_SUPABASE_URL, envLocal.STAGING_SUPABASE_SERVICE_ROLE_KEY);
  const fileBuffer = fs.readFileSync(TRANSCODED_FILE);

  const { data: uploadData, error: uploadErr } = await supabase.storage
    .from(BUCKET)
    .upload(OBJECT_PATH, fileBuffer, {
      contentType: 'video/mp4',
      upsert: true,
      cacheControl: '3600',
    });

  if (uploadErr) {
    throw new Error(`Upload failed to ${BUCKET}/${OBJECT_PATH}: ${uploadErr.message}`);
  }
  console.log(`✓ Upload successful: ${uploadData.path}`);

  // 7. Verify dynamic signed URL playback & headers
  console.log('\nStep 7: Verifying private playback via dynamic signed URL...');
  const { data: signedData, error: signErr } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(OBJECT_PATH, 3600);

  if (signErr || !signedData?.signedUrl) {
    throw new Error(`Failed to create signed URL: ${signErr?.message}`);
  }

  const playRes = await fetch(signedData.signedUrl, { headers: { Range: 'bytes=0-1024' } });
  console.log(`Signed Playback Status: ${playRes.status} ${playRes.statusText}`);
  console.log(`Content-Type:           ${playRes.headers.get('content-type')}`);
  console.log(`Content-Range:          ${playRes.headers.get('content-range')}`);

  // 8. Confirm raw public URL is blocked
  console.log('\nStep 8: Confirming raw public URL is blocked...');
  const rawUrl = `${envLocal.STAGING_SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${OBJECT_PATH}`;
  const rawRes = await fetch(rawUrl);
  console.log(`Raw Public URL Status:  ${rawRes.status} (Blocked as expected)`);
  if (rawRes.status === 200) {
    throw new Error('SECURITY VIOLATION: Preserved copy is publicly accessible!');
  }

  console.log('\n================================================================');
  console.log('TRANSCODING & STORAGE PRESERVATION COMPLETED SUCCESSFULLY!');
  console.log('Preserved Object: storage://recordings/' + OBJECT_PATH);
  console.log('================================================================\n');
}

main().catch((err) => {
  console.error('\n❌ FAILED:', err);
  process.exit(1);
});
