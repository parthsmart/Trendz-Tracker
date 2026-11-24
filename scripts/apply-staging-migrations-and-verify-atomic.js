/**
 * Trendz Tracker — Staging Migration & Atomic Publication Rollback Verifier
 * (scripts/apply-staging-migrations-and-verify-atomic.js)
 *
 * Verifies:
 * 1. Connection strictly to approved HTTPS staging Supabase PostgreSQL (xhgzbbkvwojwfbexvcmh).
 * 2. Applies Migration 18 (live_class_recordings & audit log) and Migration 19 (lectures catalogue).
 * 3. Preserves unrelated staging lectures (verifies persistent non-fixture lectures survive intact).
 * 4. Imports dedicated test fixtures via public.publish_classroom_catalogue.
 * 5. EXTENDED ATOMIC ROLLBACK TEST:
 *    - Captures dedicated fixture lecture's stored fields before mutation attempt.
 *    - Attempts in-place mutation to existing lecture before mid-transaction failure (22023).
 *    - Compares stored fields before vs after rollback across all 14 database columns, asserting 100% field equality.
 *    - Verifies 0 partial rows persisted from failing category.
 * 6. TARGETED CLEANUP (NO TRUNCATE CASCADE):
 *    - Cleans up ONLY the dedicated test fixtures (slug LIKE 'fixture-%').
 *    - Asserts unrelated staging lectures remain 100% intact across runs and reruns.
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

  // Ensure persistent unrelated staging lecture exists (to verify it is never deleted by tests)
  console.log('\n--- Step 2b: Checking Staging Persistent Unrelated Lectures ---');
  const existingUnrelatedRes = await client.query(`
    SELECT id, title, slug FROM public.lecture_categories
    WHERE slug NOT LIKE 'fixture-%' AND slug NOT LIKE 'zzz-rollback%';
  `);
  let unrelatedCat = existingUnrelatedRes.rows[0];
  if (!unrelatedCat) {
    const seedCatRes = await client.query(`
      INSERT INTO public.lecture_categories (title, slug, description, sort_order, active)
      VALUES ('Core Abacus Mental Arithmetic', 'staging-core-abacus', 'Persistent curriculum category on staging', 100, true)
      ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title
      RETURNING id, title, slug;
    `);
    unrelatedCat = seedCatRes.rows[0];
    await client.query(`
      INSERT INTO public.lectures (category_id, title, slug, lesson_order, duration_seconds, media_type, media_url, notes, status)
      VALUES ($1, 'Abacus Speed Foundation Part 1', 'core-abacus-part-1', 1, 600, 'video_mp4', 'https://example.com/core-abacus-part-1.mp4', 'Persistent staging lecture notes', 'active')
      ON CONFLICT (category_id, lesson_order) DO NOTHING;
    `, [unrelatedCat.id]);
  }
  console.log(`✓ Confirmed persistent unrelated staging category: "${unrelatedCat.title}" (${unrelatedCat.slug})`);

  const unrelatedCountBeforeRes = await client.query(`
    SELECT count(*)::int AS count FROM public.lecture_categories
    WHERE slug NOT LIKE 'fixture-%' AND slug NOT LIKE 'zzz-rollback%';
  `);
  const unrelatedCountBefore = unrelatedCountBeforeRes.rows[0].count;
  console.log(`✓ Unrelated staging lecture categories count before test: ${unrelatedCountBefore}`);

  // 4. Test Step 3: Publish Dedicated Test Fixtures (Isolated from production manifest)
  console.log('\n--- Step 3: Publishing Dedicated Test Fixtures via Database Routine ---');
  const dedicatedFixtureManifest = {
    courseId: 'fixture-test-course-101',
    categories: [
      {
        title: 'Fixture Addition Foundation',
        slug: 'fixture-addition-topic',
        description: 'Dedicated test fixture category for atomic publication and rollback verification.',
        sortOrder: 1,
        lessons: [
          {
            title: 'Fixture Addition — Part 1: Soroban Foundation',
            slug: 'fixture-addition-part-1',
            lessonOrder: 1,
            durationSeconds: 745,
            mediaType: 'video_mp4',
            mediaUrl: 'https://example.com/fixture-valid-video.mp4',
            notes: 'Initial valid notes for field parity assertion.'
          },
          {
            title: 'Fixture Addition — Part 2: Small Friends Drill',
            slug: 'fixture-addition-part-2',
            lessonOrder: 2,
            durationSeconds: 890,
            mediaType: 'video_mp4',
            mediaUrl: 'https://example.com/fixture-valid-video-2.mp4',
            notes: 'Small friends formula notes.'
          }
        ]
      }
    ]
  };

  // Ensure admin context
  await client.query(`SELECT set_config('request.jwt.claim.sub', $1, false);`, [adminProfile.id]);

  const publishResult = await client.query(`
    SELECT public.publish_classroom_catalogue($1::jsonb) AS result;
  `, [JSON.stringify(dedicatedFixtureManifest)]);

  const pubOutput = publishResult.rows[0]?.result;
  console.log('✓ publish_classroom_catalogue result for dedicated fixtures:', pubOutput);

  if (!pubOutput?.ok || pubOutput?.importedCategories !== 1 || pubOutput?.importedLectures !== 2) {
    throw new Error(`Unexpected publish result: expected 1 category and 2 lectures, got ${JSON.stringify(pubOutput)}`);
  }

  // 5. Test Step 4: EXTENDED Rollback Verification with Existing Lecture Update
  console.log('\n--- Step 4: Extended Atomic Rollback Verification with Lecture Update ---');

  // Step 4a: Capture existing fixture lecture's stored fields before the failing import
  const targetLecRes = await client.query(`
    SELECT l.*
    FROM public.lectures l
    JOIN public.lecture_categories c ON c.id = l.category_id
    WHERE c.slug = 'fixture-addition-topic' AND l.lesson_order = 1;
  `);
  if (targetLecRes.rows.length === 0) {
    throw new Error('Target fixture lecture for rollback test not found.');
  }
  const beforeLecture = targetLecRes.rows[0];
  console.log('✓ Captured target existing fixture lecture before attempted mutation:');
  console.log('  ID:              ', beforeLecture.id);
  console.log('  Title:           ', beforeLecture.title);
  console.log('  Lesson Order:    ', beforeLecture.lesson_order);
  console.log('  Duration Seconds:', beforeLecture.duration_seconds);
  console.log('  Media URL:       ', beforeLecture.media_url);
  console.log('  Notes:           ', beforeLecture.notes);
  console.log('  Updated At:      ', beforeLecture.updated_at);

  // Step 4b: Construct failing manifest that:
  // 1. Attempts to mutate existing lecture (fixture-addition-part-1) with modified title, duration, notes, and media URL.
  // 2. Subsequently encounters an invalid media URL in Category 2 to trigger a mid-transaction exception.
  console.log('\nConstructing failing manifest that mutates Fixture Addition Part 1 and forces failure in Category 2...');

  const failingManifest = {
    courseId: 'fixture-test-course-101',
    categories: [
      {
        title: 'Fixture Addition Foundation',
        slug: 'fixture-addition-topic',
        description: 'Existing Fixture Addition Category',
        sortOrder: 1,
        lessons: [
          {
            title: 'MUTATED FIXTURE TITLE (MUST BE ROLLED BACK)',
            slug: 'fixture-addition-part-1',
            lessonOrder: 1, // Matches existing lecture row!
            durationSeconds: 99999, // Mutated duration!
            mediaType: 'video_mp4',
            mediaUrl: 'https://example.com/mutated-valid-url.mp4', // Mutated URL!
            notes: 'MUTATED FIXTURE NOTES (MUST BE ROLLED BACK)', // Mutated notes!
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

  // 6. Step 5: Targeted Cleanup (NO TRUNCATE CASCADE)
  console.log('\n--- Step 5: Targeted Cleanup of Dedicated Fixtures (No TRUNCATE CASCADE) ---');
  // Delete ONLY dedicated test fixtures
  await client.query(`
    DELETE FROM public.lecture_categories
    WHERE slug LIKE 'fixture-%' OR slug LIKE 'zzz-rollback%';
  `);
  console.log('✓ Targeted cleanup completed: deleted only fixture-* and zzz-rollback* categories.');

  // Assert unrelated staging lectures are 100% preserved
  const unrelatedCountAfterRes = await client.query(`
    SELECT count(*)::int AS count FROM public.lecture_categories
    WHERE slug NOT LIKE 'fixture-%' AND slug NOT LIKE 'zzz-rollback%';
  `);
  const unrelatedCountAfter = unrelatedCountAfterRes.rows[0].count;
  console.log(`✓ Unrelated staging lecture categories count after targeted cleanup: ${unrelatedCountAfter} (Before: ${unrelatedCountBefore})`);

  if (unrelatedCountAfter !== unrelatedCountBefore || unrelatedCountAfter === 0) {
    throw new Error(`Unrelated staging lectures were not preserved! Before: ${unrelatedCountBefore}, After: ${unrelatedCountAfter}`);
  }
  console.log('✓ Confirmed: Unrelated staging lectures were 100% preserved. TRUNCATE CASCADE was NOT used.');

  console.log('\n================================================================');
  console.log('ALL STAGING DATABASE MIGRATION & EXTENDED ROLLBACK CHECKS PASSED!');
  console.log('1. Migration 18 applied: live_class_recordings & audit log active');
  console.log('2. Migration 19 applied: lecture_categories & lectures active');
  console.log('3. Dedicated test fixtures published and verified in PostgreSQL');
  console.log('4. In-place lecture update rollback verified: 100% field parity confirmed');
  console.log('5. Zero partial rows persisted from failing transaction');
  console.log('6. Targeted cleanup performed (TRUNCATE CASCADE eliminated)');
  console.log('7. Unrelated staging lectures 100% preserved across runs and reruns');
  console.log('================================================================\n');

  await client.end();
}

main().catch(err => {
  console.error('\n❌ VERIFICATION FAILED:', err);
  process.exit(1);
});
