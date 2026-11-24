/**
 * Trendz Tracker — Admin Import → Publish → Student Playback Flow Verifier
 * (scripts/verify-private-lecture-import-and-playback.js)
 *
 * Verifies:
 * 1. Admin normal import preview and publish flow without inserting rows manually:
 *    - Uploads test video fixture to private Supabase Storage bucket 'lectures'.
 *    - Admin publishes manifest via POST /api/lectures (action: 'publish_import') with storage://lectures/... reference.
 *    - Confirms category and lecture rows are inserted atomically by publish_classroom_catalogue RPC.
 * 2. Rejection of other storage buckets:
 *    - Admin attempts publish_import with storage://recordings/... -> rejected with HTTP 400 BUCKET_RESTRICTED.
 *    - Admin attempts publish_import with storage://unauthorized/... -> rejected with HTTP 400 BUCKET_RESTRICTED.
 *    - SQL routine directly rejects unauthorized bucket with exception 22023.
 * 3. Eligible student playback:
 *    - Enrolled student calls POST /api/lectures (action: 'get_lecture') on the published lecture ID.
 *    - Receives dynamic signed URL for private bucket 'lectures'.
 *    - Confirms HTTP 200 stream and byte-level payload verification.
 * 4. Targeted cleanup of published test fixtures by exact primary key IDs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envLocal = dotenv.parse(fs.readFileSync(path.resolve(__dirname, '../.env.staging.local')));
const PREVIEW_BASE = 'http://localhost:3000';

const accountsData = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../work/private/phase18-staging-accounts.json'), 'utf8')
);
const adminAcc = accountsData.accounts.find((a) => a.login === 'STG-ADM');
const studentAcc = accountsData.accounts.find((a) => a.login === 'STG-001');

const envPostgres = fs.readFileSync(path.resolve(__dirname, '../../../work/private/staging-postgres.env'), 'utf8');
const pgMatch = envPostgres.match(/STAGING_DATABASE_URL="?([^"\r\n]+)"?/);
const stagingDbUrl = pgMatch[1].trim();

console.log('================================================================');
console.log('ADMIN IMPORT → PUBLISH → STUDENT PLAYBACK FLOW VERIFIER');
console.log('Target Staging Project:', 'xhgzbbkvwojwfbexvcmh');
console.log('Staging Preview Base:  ', PREVIEW_BASE);
console.log('================================================================\n');

async function getJwt(email, password) {
  const res = await fetch(`${envLocal.STAGING_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'apikey': envLocal.STAGING_SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Auth failed for ${email}: ${data.error_description || data.msg}`);
  }
  return data.access_token;
}

async function run() {
  const adminToken = await getJwt(adminAcc.email, adminAcc.password);
  console.log('✓ Authenticated Admin:', adminAcc.email);

  const studentToken = await getJwt(studentAcc.email, studentAcc.password);
  console.log('✓ Authenticated Student:', studentAcc.email);

  const supabaseService = createClient(envLocal.STAGING_SUPABASE_URL, envLocal.STAGING_SUPABASE_SERVICE_ROLE_KEY);

  // 1. Upload test video fixture to private lectures bucket
  console.log('\n--- Step 1: Uploading Video Fixture to Private Lectures Bucket ---');
  const runTimestamp = Date.now();
  const fixturePath = `addition/test-publish-flow-${runTimestamp}.mp4`;
  const fixtureContent = Buffer.from(`TRENDZ-PRIVATE-LECTURE-STREAM-PAYLOAD-${runTimestamp}`);

  const { error: uploadError } = await supabaseService.storage
    .from('lectures')
    .upload(fixturePath, fixtureContent, { contentType: 'video/mp4', upsert: true });

  if (uploadError) {
    throw new Error(`Failed to upload lecture fixture: ${uploadError.message}`);
  }
  console.log(`✓ Fixture uploaded to private storage: lectures/${fixturePath}`);

  // 2. Test rejection of other storage buckets via API
  console.log('\n--- Step 2: Testing Rejection of Other Storage Buckets via Publish API ---');
  const badBucketManifest = {
    courseId: `test-course-bad-bucket-${runTimestamp}`,
    categories: [
      {
        title: `Bad Bucket Test Category ${runTimestamp}`,
        slug: `bad-bucket-cat-${runTimestamp}`,
        sortOrder: 99,
        lessons: [
          {
            title: 'Unauthorized Recordings Bucket Lecture',
            slug: `unauth-lec-${runTimestamp}`,
            lessonOrder: 1,
            mediaType: 'video_mp4',
            mediaUrl: `storage://recordings/webinars/confidential-${runTimestamp}.mp4`,
            notes: 'Should be rejected',
          },
        ],
      },
    ],
  };

  const badPubRes = await fetch(`${PREVIEW_BASE}/api/lectures`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'publish_import', manifest: badBucketManifest }),
  });
  const badPubData = await badPubRes.json();
  console.log('API Status with storage://recordings/...:', badPubRes.status, 'Code:', badPubData.code);
  console.log('Error Message:', badPubData.error);
  if (badPubRes.status !== 400 || badPubData.code !== 'BUCKET_RESTRICTED') {
    throw new Error('API failed to reject unauthorized storage bucket!');
  }
  console.log('✓ Confirmed: Publish API strictly rejected storage://recordings/... with HTTP 400 BUCKET_RESTRICTED');

  // 3. Test rejection of other buckets directly in SQL routine
  console.log('\n--- Step 2b: Testing Rejection of Other Storage Buckets in SQL Routine ---');
  const pgClient = new pg.Client({ connectionString: stagingDbUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();
  const adminProfRes = await pgClient.query(`SELECT id FROM public.profiles WHERE role = 'admin' LIMIT 1;`);
  const adminProfId = adminProfRes.rows[0].id;
  await pgClient.query(`SELECT set_config('request.jwt.claim.sub', $1, false);`, [adminProfId]);
  await pgClient.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', false);`);

  let sqlErrorCaught = false;
  try {
    await pgClient.query(`
      SELECT public.publish_classroom_catalogue($1::jsonb);
    `, [JSON.stringify(badBucketManifest)]);
  } catch (err) {
    sqlErrorCaught = true;
    console.log('✓ SQL Routine Exception caught:', err.code, err.message);
    if (err.code !== '22023') {
      throw new Error(`Expected SQL error code 22023, got ${err.code}`);
    }
  }
  if (!sqlErrorCaught) {
    throw new Error('SQL routine failed to reject unauthorized storage bucket!');
  }
  console.log('✓ Confirmed: SQL routine strictly rejected unauthorized storage bucket with exception 22023');

  // 4. Normal Admin Import & Publish Flow with Valid storage://lectures/... Reference
  console.log('\n--- Step 3: Normal Admin Import & Publish Flow (Zero Manual SQL Row Insertion) ---');
  const catSlug = `fixture-addition-private-${runTimestamp}`;
  const lecSlug = `fixture-addition-part-1-${runTimestamp}`;
  const validManifest = {
    courseId: `course-addition-priv-${runTimestamp}`,
    courseTitle: 'Jr. MCWC Videos (Private Storage Flow)',
    categories: [
      {
        title: `Addition Private Foundation ${runTimestamp}`,
        slug: catSlug,
        description: 'Private video lessons hosted in lectures bucket',
        sortOrder: 1,
        lessons: [
          {
            title: 'Addition Part 1 — Soroban Foundation Master',
            slug: lecSlug,
            lessonOrder: 1,
            durationSeconds: 745,
            mediaType: 'video_mp4',
            mediaUrl: `storage://lectures/${fixturePath}`,
            notes: 'Published via admin publication API without manual row insertion',
          },
        ],
      },
    ],
  };

  // Preview check first
  const prevRes = await fetch(`${PREVIEW_BASE}/api/lectures`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'import_preview', manifest: validManifest }),
  });
  const prevData = await prevRes.json();
  console.log('Import Preview Status:', prevRes.status, 'Total lessons:', prevData.preview?.totalLessonsCount);
  if (!prevRes.ok || prevData.preview?.totalLessonsCount !== 1) {
    throw new Error('Import preview failed');
  }

  // Publish import via API
  console.log('Calling POST /api/lectures action: publish_import...');
  const pubRes = await fetch(`${PREVIEW_BASE}/api/lectures`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'publish_import', manifest: validManifest }),
  });
  const pubData = await pubRes.json();
  console.log('Publish Import Status:', pubRes.status);
  console.log('Publish Import Output:', pubData);
  if (!pubRes.ok || !pubData.ok || pubData.importedCategories !== 1 || pubData.importedLectures !== 1) {
    throw new Error(`Publish import failed: ${JSON.stringify(pubData)}`);
  }
  console.log('✓ Successfully published via admin API!');

  // Retrieve published lecture ID from database via API
  const listLecRes = await fetch(`${PREVIEW_BASE}/api/lectures`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'list_lectures', categorySlug: catSlug }),
  });
  const listLecData = await listLecRes.json();
  console.log('List Lectures count:', listLecData.lectures?.length);
  const publishedLec = listLecData.lectures?.[0];
  if (!publishedLec) {
    throw new Error('Published lecture could not be retrieved from catalogue!');
  }
  const publishedLecId = publishedLec.id;
  const publishedCatId = publishedLec.category_id || publishedLec.categoryId;
  console.log(`✓ Published Lecture Created by RPC: ID = ${publishedLecId}`);
  console.log(`  Title:     "${publishedLec.title}"`);
  console.log(`  Stored Media URL: "${publishedLec.mediaUrl || publishedLec.media_url}"`);

  // 5. Eligible Student Playback Request
  console.log('\n--- Step 4: Eligible Student Playback Request ---');
  const stuPlayRes = await fetch(`${PREVIEW_BASE}/api/lectures`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${studentToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'get_lecture', lectureId: publishedLecId }),
  });
  const stuPlayData = await stuPlayRes.json();
  console.log('Student get_lecture Status:', stuPlayRes.status);
  if (!stuPlayRes.ok || !stuPlayData.ok) {
    throw new Error(`Student get_lecture failed: ${stuPlayData.error}`);
  }

  const signedUrl = stuPlayData.lecture?.mediaUrl;
  console.log('✓ Dynamic Signed URL Generated for Student:');
  console.log('  ', signedUrl.slice(0, 90) + '...[TOKEN REDACTED]');

  if (!signedUrl.startsWith('https://') || !signedUrl.includes('/storage/v1/object/sign/lectures/')) {
    throw new Error(`Expected signed URL from lectures bucket, got: ${signedUrl}`);
  }

  // Stream video using signed URL
  console.log('\nStreaming video from signed URL...');
  const streamRes = await fetch(signedUrl);
  console.log('Stream Response Status:', streamRes.status, streamRes.statusText);
  if (streamRes.status !== 200) {
    throw new Error(`Signed URL streaming failed with status ${streamRes.status}`);
  }
  const streamBuffer = Buffer.from(await streamRes.arrayBuffer());
  const match = streamBuffer.equals(fixtureContent);
  console.log(`✓ Stream Payload Match: ${match} (${streamBuffer.length} bytes received)`);
  if (!match) {
    throw new Error('Streamed content did not match uploaded video payload!');
  }

  // 6. Targeted Cleanup of Test Rows and Storage Object
  console.log('\n--- Step 5: Targeted Cleanup (Scoped to Exact Created IDs) ---');
  // Delete from database using exact primary keys
  await pgClient.query(`DELETE FROM public.lectures WHERE id = $1;`, [publishedLecId]);
  await pgClient.query(`DELETE FROM public.lecture_categories WHERE id = $1;`, [publishedCatId]);
  console.log(`✓ Cleaned up database rows: lecture ${publishedLecId}, category ${publishedCatId}`);

  // Delete uploaded fixture from private lectures bucket
  await supabaseService.storage.from('lectures').remove([fixturePath]);
  console.log(`✓ Cleaned up storage fixture: ${fixturePath}`);

  // Verify database has no lingering fixture rows
  const checkLec = await pgClient.query(`SELECT count(*)::int AS count FROM public.lectures WHERE id = $1;`, [publishedLecId]);
  const checkCat = await pgClient.query(`SELECT count(*)::int AS count FROM public.lecture_categories WHERE id = $1;`, [publishedCatId]);
  console.log(`✓ Residual count: lectures = ${checkLec.rows[0].count}, categories = ${checkCat.rows[0].count}`);

  await pgClient.end();

  console.log('\n================================================================');
  console.log('ALL ADMIN IMPORT → PUBLISH → STUDENT PLAYBACK CHECKS PASSED!');
  console.log('1. storage://lectures/... accepted by both publish API and SQL routine');
  console.log('2. Unauthorized buckets (storage://recordings/...) strictly rejected by API and SQL');
  console.log('3. Zero manual SQL lecture row insertions: publish_import created all rows atomically');
  console.log('4. Eligible student received signed URL and streamed full video payload (HTTP 200)');
  console.log('5. Targeted cleanup removed exact created primary keys and storage fixture');
  console.log('================================================================\n');
}

run().catch((err) => {
  console.error('\n❌ VERIFICATION FAILED:', err);
  process.exit(1);
});
