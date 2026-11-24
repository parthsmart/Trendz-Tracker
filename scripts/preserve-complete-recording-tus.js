import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

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
const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB chunks

async function main() {
  console.log('================================================================');
  console.log('PRESERVE COMPLETE WEBINAR.GG RECORDING VIA TUS (UNCHANGED)');
  console.log('Source:      ', '[STREAM-OS-ORIGINAL-MEDIA-URL]');
  console.log('Target:      ', `storage://${BUCKET}/${OBJECT_PATH}`);
  console.log('Staging DB:  ', 'xhgzbbkvwojwfbexvcmh');
  console.log('================================================================\n');

  // 1. Get HEAD / size of source file
  console.log('Step 1: Inspecting source file headers and total size...');
  const headRes = await fetch(SOURCE_URL, { method: 'HEAD' });
  const totalLengthStr = headRes.headers.get('content-length');
  if (!totalLengthStr) {
    throw new Error('Unable to determine Content-Length of source video');
  }
  const totalLength = parseInt(totalLengthStr, 10);
  console.log(`Source Content-Length: ${totalLength.toLocaleString()} bytes (~${(totalLength / (1024 * 1024)).toFixed(2)} MB)`);
  console.log(`Source Content-Type:   ${headRes.headers.get('content-type')}`);

  // 2. Initiate TUS upload session
  console.log('\nStep 2: Initiating Supabase Storage TUS Resumable Upload Session...');
  const tusUrl = `${envLocal.STAGING_SUPABASE_URL}/storage/v1/upload/resumable`;
  const metadata = [
    `bucketName ${Buffer.from(BUCKET).toString('base64')}`,
    `objectName ${Buffer.from(OBJECT_PATH).toString('base64')}`,
    `contentType ${Buffer.from('video/mp4').toString('base64')}`,
    `cacheControl ${Buffer.from('3600').toString('base64')}`,
  ].join(',');

  const initRes = await fetch(tusUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${envLocal.STAGING_SUPABASE_SERVICE_ROLE_KEY}`,
      'apikey': envLocal.STAGING_SUPABASE_SERVICE_ROLE_KEY,
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(totalLength),
      'Upload-Metadata': metadata,
      'x-upsert': 'true',
    },
  });

  if (initRes.status !== 201) {
    const errText = await initRes.text();
    throw new Error(`TUS Init failed with status ${initRes.status}: ${errText}`);
  }

  const location = initRes.headers.get('location');
  if (!location) {
    throw new Error('TUS Init succeeded but returned no Location header');
  }

  const uploadUrl = location.startsWith('http')
    ? location
    : `${envLocal.STAGING_SUPABASE_URL}${location.startsWith('/') ? '' : '/'}${location}`;

  console.log(`✓ TUS session initiated successfully. Upload location established.`);

  // 3. Upload chunks in loop while calculating source SHA-256
  console.log('\nStep 3: Streaming chunks from source to Supabase TUS endpoint...');
  const sourceHasher = crypto.createHash('sha256');
  let offset = 0;
  let chunkIndex = 0;
  const totalChunks = Math.ceil(totalLength / CHUNK_SIZE);

  while (offset < totalLength) {
    const end = Math.min(offset + CHUNK_SIZE - 1, totalLength - 1);
    const expectedChunkLen = end - offset + 1;
    chunkIndex++;

    const chunkRes = await fetch(SOURCE_URL, {
      headers: {
        'Range': `bytes=${offset}-${end}`,
      },
    });

    if (chunkRes.status !== 206 && chunkRes.status !== 200) {
      throw new Error(`Failed to fetch chunk ${chunkIndex} (${offset}-${end}) from source: HTTP ${chunkRes.status}`);
    }

    const chunkArrayBuffer = await chunkRes.arrayBuffer();
    const chunkBuffer = Buffer.from(chunkArrayBuffer);

    if (chunkBuffer.length !== expectedChunkLen) {
      throw new Error(`Chunk size mismatch: expected ${expectedChunkLen}, got ${chunkBuffer.length}`);
    }

    // Update source hash
    sourceHasher.update(chunkBuffer);

    // PATCH to TUS endpoint with retry
    let patchSuccess = false;
    let retries = 3;
    while (!patchSuccess && retries > 0) {
      try {
        const patchRes = await fetch(uploadUrl, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${envLocal.STAGING_SUPABASE_SERVICE_ROLE_KEY}`,
            'apikey': envLocal.STAGING_SUPABASE_SERVICE_ROLE_KEY,
            'Tus-Resumable': '1.0.0',
            'Upload-Offset': String(offset),
            'Content-Type': 'application/offset+octet-stream',
          },
          body: chunkBuffer,
        });

        if (patchRes.status !== 204) {
          const patchErr = await patchRes.text();
          throw new Error(`TUS PATCH status ${patchRes.status}: ${patchErr}`);
        }

        const newOffsetStr = patchRes.headers.get('upload-offset');
        const newOffset = parseInt(newOffsetStr || '0', 10);
        if (newOffset !== offset + expectedChunkLen) {
          throw new Error(`TUS Upload-Offset mismatch: expected ${offset + expectedChunkLen}, got ${newOffset}`);
        }

        patchSuccess = true;
      } catch (err) {
        retries--;
        console.warn(`  Warning: PATCH failed for chunk ${chunkIndex} (offset ${offset}), retries left: ${retries}. Error: ${err.message}`);
        if (retries === 0) throw err;
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    offset += expectedChunkLen;
    const progressPct = ((offset / totalLength) * 100).toFixed(1);
    process.stdout.write(`  Chunk [${chunkIndex}/${totalChunks}] | Offset: ${(offset / (1024 * 1024)).toFixed(1)} MB / ${(totalLength / (1024 * 1024)).toFixed(1)} MB (${progressPct}%)\r`);
  }

  const sourceSha256 = sourceHasher.digest('hex');
  console.log(`\n✓ All ${totalChunks} chunks uploaded successfully! Total uploaded: ${offset.toLocaleString()} bytes.`);
  console.log(`Source SHA-256 Checksum:  ${sourceSha256}`);

  // 4. Download preserved copy from Supabase Storage & verify SHA-256
  console.log('\nStep 4: Downloading preserved copy from Supabase Storage to verify bitwise SHA-256 checksum...');
  const supabase = createClient(envLocal.STAGING_SUPABASE_URL, envLocal.STAGING_SUPABASE_SERVICE_ROLE_KEY);
  const { data: signedData, error: signErr } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(OBJECT_PATH, 3600);

  if (signErr || !signedData?.signedUrl) {
    throw new Error(`Failed to generate signed URL for verification: ${signErr?.message}`);
  }

  const targetHasher = crypto.createHash('sha256');
  let verifyOffset = 0;
  let verifyChunkIndex = 0;

  while (verifyOffset < totalLength) {
    const end = Math.min(verifyOffset + CHUNK_SIZE - 1, totalLength - 1);
    const expectedChunkLen = end - verifyOffset + 1;
    verifyChunkIndex++;

    const chunkRes = await fetch(signedData.signedUrl, {
      headers: {
        'Range': `bytes=${verifyOffset}-${end}`,
      },
    });

    if (chunkRes.status !== 206 && chunkRes.status !== 200) {
      throw new Error(`Failed to fetch verification chunk ${verifyChunkIndex} (${verifyOffset}-${end}): HTTP ${chunkRes.status}`);
    }

    const chunkArrayBuffer = await chunkRes.arrayBuffer();
    const chunkBuffer = Buffer.from(chunkArrayBuffer);

    if (chunkBuffer.length !== expectedChunkLen) {
      throw new Error(`Verification chunk size mismatch: expected ${expectedChunkLen}, got ${chunkBuffer.length}`);
    }

    targetHasher.update(chunkBuffer);
    verifyOffset += expectedChunkLen;
    const progressPct = ((verifyOffset / totalLength) * 100).toFixed(1);
    process.stdout.write(`  Verifying [${verifyChunkIndex}/${totalChunks}] | Offset: ${(verifyOffset / (1024 * 1024)).toFixed(1)} MB (${progressPct}%)\r`);
  }

  const targetSha256 = targetHasher.digest('hex');
  console.log(`\n✓ Downloaded ${verifyOffset.toLocaleString()} bytes from Supabase Storage.`);
  console.log(`Stored SHA-256 Checksum:  ${targetSha256}`);

  console.log('\nStep 5: Checksum Comparison:');
  console.log(`Source Checksum:  ${sourceSha256}`);
  console.log(`Stored Checksum:  ${targetSha256}`);
  if (sourceSha256 !== targetSha256) {
    throw new Error(`FATAL: SHA-256 Checksum Mismatch between Source and Stored Storage Object!`);
  }
  console.log('✓ PERFECT 100% BITWISE MATCH! The complete master recording is preserved unchanged.');

  // 6. Security verification: Verify raw public access is blocked
  console.log('\nStep 6: Confirming raw public URL is blocked...');
  const rawPublicUrl = `${envLocal.STAGING_SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${OBJECT_PATH}`;
  const rawRes = await fetch(rawPublicUrl);
  console.log(`Raw Public URL Status: ${rawRes.status} (Expected: 400 NoSuchBucket / 403 Forbidden)`);
  if (rawRes.status === 200) {
    throw new Error('SECURITY VIOLATION: Preserved copy is publicly accessible!');
  }
  console.log('✓ Confirmed: Raw public access is strictly blocked.');

  console.log('\n================================================================');
  console.log('PRESERVED MASTER RECORDING VERIFICATION COMPLETED SUCCESSFULLY!');
  console.log('================================================================\n');

  return {
    sourceSha256,
    targetSha256,
    totalLength,
    objectPath: `storage://${BUCKET}/${OBJECT_PATH}`,
  };
}

main().catch((err) => {
  console.error('\n❌ PRESERVATION SCRIPT FAILED:', err);
  process.exit(1);
});
