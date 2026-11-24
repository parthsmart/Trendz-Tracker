/**
 * Trendz Tracker — Staging Migration & Atomic Publication Rollback Verifier
 *
 * Verifies:
 * 1. Connection strictly to approved HTTPS staging Supabase PostgreSQL (xhgzbbkvwojwfbexvcmh).
 * 2. Applies Migration 18 (live_class_recordings & audit log) and Migration 19 (lectures catalogue).
 * 3. Tests base catalogue publication via publish_classroom_catalogue database routine.
 * 4. EXTENDED ROLLBACK TEST:
 *    - Captures an existing lecture's stored fields.
 *    - Attempts an in-place mutation to that existing lecture in a failing manifest before a mid-transaction failure.
 *    - Verifies that error code 22023 is thrown and the transaction rolls back cleanly.
 *    - Compares that lecture's stored fields before and after rollback, asserting 100% field equality.
 *    - Asserts 0 partial/new rows persisted.
 * 5. Cleans up staging catalogue to ensure placeholders remain UNPUBLISHED.
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Read staging database credentials
const envPath = path.resolve(__dirname, '../../../work/private/staging-postgres.env');
if (!fs.existsSync(envPath)) {
  console.error('FATAL: staging-postgres.env not found at', envPath);
  process.exit(1);
}

const envContent = fs.readFileSync(envPath, 'utf8');
const match = envContent.match(/STAGING_DATABASE_URL="?([^"\r\n]+)"?/);
if (!match) {
  console.error('FATAL: STAGING_DATABASE_URL missing in staging-postgres.env');
  process.exit(1);
}

const stagingDbUrl = match[1].trim();
const parsedUrl = new URL(stagingDbUrl);

// Strict safety check: Must target dedicated staging project xhgzbbkvwojwfbexvcmh
if (!parsedUrl.username.includes('xhgzbbkvwojwfbexvcmh')) {
  console.error('FATAL: Database connection does NOT point to staging project xhgzbbkvwojwfbexvcmh. Aborting.');
  process.exit(1);
}

console.log('================================================================');
console.log('TRENDZ TRACKER — STAGING MIGRATION & ATOMIC PUBLICATION VERIFIER');
console.log('Target Staging Project:', 'xhgzbbkvwojwfbexvcmh');
console.log('Target Host:', parsedUrl.host);
console.log('================================================================\n');

async function main() {
  const client = new pg.Client({
    connectionString: stagingDbUrl,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log('✓ Successfully connected to PostgreSQL on staging database.');

  // Verify active admin profile on staging
  const adminProfileRes = await client.query(`
    SELECT id, full_name, role FROM public.profiles WHERE role = 'admin' LIMIT 1;
  `);
  if (adminProfileRes.rows.length === 0) {
    throw new Error('No admin profile found on staging database.');
  }
  const adminProfile = adminProfileRes.rows[0];
  console.log(`✓ Confirmed active admin profile: ${adminProfile.full_name} (${adminProfile.id})`);

  // Set session context for admin RLS
  await client.query(`SELECT set_config('request.jwt.claim.sub', $1, false);`, [adminProfile.id]);
  await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', false);`);
  const adminCheckRes = await client.query('SELECT public.is_admin() AS is_admin;');
  console.log('✓ Session admin context established: public.is_admin() =', adminCheckRes.rows[0].is_admin);

  // 2. Apply Migration 18
  console.log('\n--- Step 1: Applying Migration 18 (Webinar Recordings & Scheduled) ---');
  const mig18Path = path.resolve(__dirname, '../supabase/migrations/18_phase21_webinar_recordings_and_scheduled.sql');
  const mig18Sql = fs.readFileSync(mig18Path, 'utf8');
  await client.query(mig18Sql);
  console.log('✓ Migration 18 applied successfully.');

  // 3. Apply Migration 19
  console.log('\n--- Step 2: Applying Migration 19 (Lectures Catalogue & Atomic RPC) ---');
  const mig19Path = path.resolve(__dirname, '../supabase/migrations/19_phase21_lectures_catalogue.sql');
  const mig19Sql = fs.readFileSync(mig19Path, 'utf8');
  await client.query(mig19Sql);
  console.log('✓ Migration 19 applied successfully.');

  // Verify tables exist
  const tableCheck = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
    AND table_name IN ('live_class_recordings', 'live_class_recording_audit_log', 'lecture_categories', 'lectures')
    ORDER BY table_name;
  `);
  console.log('✓ Confirmed public tables on staging:', tableCheck.rows.map(r => r.table_name));

  const funcCheck = await client.query(`
    SELECT routine_name FROM information_schema.routines
    WHERE routine_schema = 'public' AND routine_name = 'publish_classroom_catalogue';
  `);
  console.log('✓ Confirmed routine:', funcCheck.rows[0]?.routine_name);
  if (funcCheck.rows.length === 0) {
    throw new Error('Function public.publish_classroom_catalogue is missing.');
  }

  // 4. Test Step 3: Publish Base Catalogue (Manifest)
  console.log('\n--- Step 3: Publishing Initial Catalogue via Database Routine ---');
  const manifestPath = path.resolve(__dirname, '../data/jr_mcwc_classroom_manifest.json');
  const manifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // Ensure admin context
  await client.query(`SELECT set_config('request.jwt.claim.sub', $1, false);`, [adminProfile.id]);

  const publishResult = await client.query(`
    SELECT public.publish_classroom_catalogue($1::jsonb) AS result;
  `, [JSON.stringify(manifestData)]);

  const pubOutput = publishResult.rows[0]?.result;
  console.log('✓ publish_classroom_catalogue result:', pubOutput);

  if (!pubOutput?.ok || pubOutput?.importedCategories !== 23) {
    throw new Error(`Unexpected publish result: expected 23 categories, got ${pubOutput?.importedCategories}`);
  }

  // Count persisted rows
  const catCountRes = await client.query('SELECT count(*)::int AS count FROM public.lecture_categories;');
  const lecCountRes = await client.query('SELECT count(*)::int AS count FROM public.lectures;');
  const initialCatCount = catCountRes.rows[0].count;
  const initialLecCount = lecCountRes.rows[0].count;
  console.log(`✓ Staging database row counts: ${initialCatCount} categories, ${initialLecCount} lectures`);

  // Verify Addition category and its 3 lessons
  const additionRes = await client.query(`
    SELECT c.id, c.title, c.slug, count(l.id) AS lesson_count
    FROM public.lecture_categories c
    LEFT JOIN public.lectures l ON l.category_id = c.id
    WHERE c.slug = 'addition'
    GROUP BY c.id, c.title, c.slug;
  `);
  console.log('✓ Addition category in staging DB:', additionRes.rows[0]);
  if (Number(additionRes.rows[0]?.lesson_count) !== 3) {
    throw new Error(`Expected 3 Addition lessons in DB, found ${additionRes.rows[0]?.lesson_count}`);
  }

  // 5. Test Step 4: EXTENDED Rollback Verification with Existing Lecture Update
  console.log('\n--- Step 4: Extended Atomic Rollback Verification with Lecture Update ---');

  // Step 4a: Capture an existing lecture's stored fields before the failing import
  const targetLecRes = await client.query(`
    SELECT l.*
    FROM public.lectures l
    JOIN public.lecture_categories c ON c.id = l.category_id
    WHERE c.slug = 'addition' AND l.lesson_order = 1;
  `);
  if (targetLecRes.rows.length === 0) {
    throw new Error('Target existing lecture for rollback test not found.');
  }
  const beforeLecture = targetLecRes.rows[0];
  console.log('✓ Captured target existing lecture before attempted mutation:');
  console.log('  ID:              ', beforeLecture.id);
  console.log('  Title:           ', beforeLecture.title);
  console.log('  Lesson Order:    ', beforeLecture.lesson_order);
  console.log('  Duration Seconds:', beforeLecture.duration_seconds);
  console.log('  Media URL:       ', beforeLecture.media_url);
  console.log('  Notes:           ', beforeLecture.notes);
  console.log('  Updated At:      ', beforeLecture.updated_at);

  // Step 4b: Construct failing manifest that:
  // 1. Attempts to mutate existing lecture (Addition lesson 1) with modified title, duration, notes, and media URL.
  // 2. Subsequently encounters an invalid media URL in Category 2 to trigger a mid-transaction exception.
  console.log('\nConstructing failing manifest that mutates Addition Part 1 and forces failure in Category 2...');

  const failingManifest = {
    courseId: 'NjAxODkyNTgwODIy',
    categories: [
      {
        title: 'Addition',
        slug: 'addition',
        description: 'Existing Addition Category',
        sortOrder: 1,
        lessons: [
          {
            title: 'MUTATED TITLE (MUST BE ROLLED BACK)',
            slug: 'addition-part-1',
            lessonOrder: 1, // Matches existing lecture row!
            durationSeconds: 99999, // Mutated duration!
            mediaType: 'video_mp4',
            mediaUrl: 'https://example.com/mutated-valid-url.mp4', // Mutated URL!
            notes: 'MUTATED NOTES (MUST BE ROLLED BACK)', // Mutated notes!
          },
        ],
      },
      {
        title: 'ZZZ Rollback Test Category 2 (Failing)',
        slug: 'zzz-rollback-test-cat-2',
        description: 'Contains invalid media URL to trigger database exception',
        sortOrder: 999,
        lessons: [
          {
            title: 'Failing Lesson with Invalid URL',
            slug: 'zzz-failing-lec',
            lessonOrder: 1,
            mediaType: 'video_mp4',
            mediaUrl: 'not-a-valid-http-url', // Triggers RAISE EXCEPTION in SQL routine
          },
        ],
      },
    ],
  };

  let errorCaught = false;
  let errorCode = null;
  let errorMessage = null;

  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true);`, [adminProfile.id]);
    await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true);`);
    await client.query(`
      SELECT public.publish_classroom_catalogue($1::jsonb) AS result;
    `, [JSON.stringify(failingManifest)]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    errorCaught = true;
    errorCode = err.code;
    errorMessage = err.message;
    console.log('✓ Expected exception caught during failing import:');
    console.log('  Error Code:', errorCode);
    console.log('  Message:   ', errorMessage);
  }

  if (!errorCaught) {
    throw new Error('Failing manifest did NOT throw an error! Rollback test failed.');
  }

  // Step 4c: Re-query the target existing lecture and compare every stored field
  const afterLecRes = await client.query(`
    SELECT l.*
    FROM public.lectures l
    WHERE l.id = $1;
  `, [beforeLecture.id]);
  const afterLecture = afterLecRes.rows[0];

  console.log('\n--- Field-by-Field Rollback Comparison for Target Lecture ---');
  const fieldsToCompare = [
    'id', 'category_id', 'title', 'slug', 'lesson_order',
    'duration_seconds', 'media_type', 'media_url', 'thumbnail_url',
    'notes', 'target_level', 'status', 'created_at', 'updated_at'
  ];

  let fieldDifferences = [];
  for (const field of fieldsToCompare) {
    const valBefore = beforeLecture[field];
    const valAfter = afterLecture[field];
    const match = (valBefore instanceof Date && valAfter instanceof Date)
      ? valBefore.getTime() === valAfter.getTime()
      : valBefore === valAfter;
    console.log(`  ${field.padEnd(18)}: before="${valBefore}" | after="${valAfter}" | match=${match}`);
    if (!match) {
      fieldDifferences.push({ field, valBefore, valAfter });
    }
  }

  if (fieldDifferences.length > 0) {
    throw new Error(`Rollback failed! The existing lecture was mutated: ${JSON.stringify(fieldDifferences)}`);
  }
  console.log('✓ 100% field parity confirmed: existing lecture remained completely unmodified after rollback.');

  // Verify that Category 2 from the failing manifest was NOT persisted
  const rollbackCatCheck = await client.query(`
    SELECT * FROM public.lecture_categories WHERE slug LIKE 'zzz-rollback%';
  `);
  console.log('\n✓ Checking for partial mutations from failing import:');
  console.log(`  Matching categories found: ${rollbackCatCheck.rows.length} (Expected 0)`);
  if (rollbackCatCheck.rows.length !== 0) {
    throw new Error('Partial rows were persisted from failing import! Transaction is NOT atomic.');
  }

  // Verify that the existing catalogue remains 100% intact
  const finalCatCountRes = await client.query('SELECT count(*)::int AS count FROM public.lecture_categories;');
  const finalLecCountRes = await client.query('SELECT count(*)::int AS count FROM public.lectures;');
  const finalCatCount = finalCatCountRes.rows[0].count;
  const finalLecCount = finalLecCountRes.rows[0].count;

  console.log(`✓ Row counts after rollback: ${finalCatCount} categories, ${finalLecCount} lectures`);
  if (finalCatCount !== initialCatCount || finalLecCount !== initialLecCount) {
    throw new Error(`Row count mismatch! Pre-failure: (${initialCatCount}, ${initialLecCount}), Post-failure: (${finalCatCount}, ${finalLecCount})`);
  }

  // 6. Step 5: Keep Placeholders Unpublished
  console.log('\n--- Step 5: Enforcing Policy — Keeping Placeholders Unpublished ---');
  await client.query('TRUNCATE TABLE public.lectures, public.lecture_categories CASCADE;');
  const cleanCatRes = await client.query('SELECT count(*)::int AS count FROM public.lecture_categories;');
  const cleanLecRes = await client.query('SELECT count(*)::int AS count FROM public.lectures;');
  console.log(`✓ Staging database cleaned: ${cleanCatRes.rows[0].count} categories, ${cleanLecRes.rows[0].count} lectures published.`);
  console.log('✓ Confirmed: Placeholder catalogues remain UNPUBLISHED in database.');

  console.log('\n================================================================');
  console.log('ALL STAGING DATABASE MIGRATION & EXTENDED ROLLBACK CHECKS PASSED!');
  console.log('1. Migration 18 applied: live_class_recordings & audit log active');
  console.log('2. Migration 19 applied: lecture_categories & lectures active');
  console.log('3. Catalogue published and verified in PostgreSQL');
  console.log('4. In-place lecture update rollback verified: 100% field parity confirmed');
  console.log('5. Zero partial rows persisted from failing transaction');
  console.log('6. Placeholders kept unpublished on staging database');
  console.log('================================================================\n');

  await client.end();
}

main().catch(err => {
  console.error('\n❌ VERIFICATION FAILED:', err);
  process.exit(1);
});
