/**
 * Trendz Tracker — Resources Lectures Catalogue Test Suite
 * (tests/lecturesCatalogue.test.js)
 *
 * Verifies Phase 21 Workstream B:
 * 1. Google Classroom Manifest validation:
 *    - Preserves all 23 calculation categories
 *    - Addition category has 3 sequential lesson parts
 * 2. Unauthenticated access protection:
 *    - Missing or invalid tokens fail with 401 UNAUTHENTICATED
 * 3. Read-only category browsing (list_categories):
 *    - Authenticated student receives categories with accurate lesson counts
 * 4. Structured lecture listing (list_lectures):
 *    - Returns lessons in proper sequential order (lesson_order)
 *    - Filters by category slug (e.g. 'addition')
 *    - Hides non-active lectures from non-admin users
 * 5. Single lecture queue resolution (get_lecture):
 *    - Resolves previous and next lecture IDs in queue
 * 6. Admin Classroom Import and Draft Preview:
 *    - Admin preview succeeds and validates structure
 *    - Non-admin calls (student/teacher) are strictly rejected with 403 FORBIDDEN
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { handleLecturesRequest, loadDefaultManifest } from '../api/_lectures.js';

function createMockReqRes({ method = 'POST', headers = {}, body = {} } = {}) {
  const req = {
    method,
    headers: {
      authorization: 'Bearer mock-token',
      ...headers,
    },
    body,
  };

  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, val) {
      this.headers[name] = val;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
    end() {
      return this;
    },
  };

  return { req, res };
}

function createMockSupabase(callerProfile, dbState = {}) {
  const categories = dbState.categories || [];
  const lectures = dbState.lectures || [];

  return {
    auth: {
      getUser: async () => ({
        data: { user: { id: callerProfile.id, email: callerProfile.email } },
        error: null,
      }),
    },
    storage: dbState.noStorage ? undefined : {
      from: (bucket) => ({
        createSignedUrl: async (objectPath, expiresIn) => {
          if (dbState.storageError) {
            return { data: null, error: { message: dbState.storageError } };
          }
          return {
            data: { signedUrl: `https://signed.supabase.co/storage/v1/object/sign/${bucket}/${objectPath}?token=mock-lecture-signed-exp-${expiresIn}` },
            error: null,
          };
        },
      }),
    },
    rpc: async (fn, params) => {
      if (fn === 'publish_classroom_catalogue') {
        const manifest = params?.p_manifest;
        if (!manifest || !Array.isArray(manifest.categories)) {
          return { data: null, error: { message: 'Invalid manifest array', code: '22023' } };
        }
        if (dbState.shouldFailRpc) {
          return { data: null, error: { message: 'Transaction aborted due to database constraint failure', code: '40001' } };
        }
        let catCount = 0;
        let lecCount = 0;
        for (const cat of manifest.categories) {
          let existingCat = categories.find((c) => c.slug === cat.slug);
          if (!existingCat) {
            existingCat = { id: `cat-${categories.length + 1}`, ...cat };
            categories.push(existingCat);
          } else {
            Object.assign(existingCat, cat);
          }
          catCount++;
          const lessons = Array.isArray(cat.lessons) ? cat.lessons : [];
          for (const l of lessons) {
            let existingLec = lectures.find((lec) => lec.category_id === existingCat.id && lec.lesson_order === l.lessonOrder);
            if (!existingLec) {
              existingLec = { id: `lec-${lectures.length + 1}`, category_id: existingCat.id, ...l };
              lectures.push(existingLec);
            } else {
              Object.assign(existingLec, l);
            }
            lecCount++;
          }
        }
        return { data: { ok: true, importedCategories: catCount, importedLectures: lecCount }, error: null };
      }
      return { data: null, error: { message: `Unknown RPC ${fn}`, code: '42883' } };
    },
    from: (table) => {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: callerProfile, error: null }),
            }),
          }),
        };
      }

      if (table === 'lecture_categories') {
        return {
          select: (columns) => {
            const queryState = {
              orderCol: 'sort_order',
              ascending: true,
            };
            const chain = {
              order: (col, { ascending = true } = {}) => {
                queryState.orderCol = col;
                queryState.ascending = ascending;
                return chain;
              },
              then: (resolve) => {
                const sorted = [...categories].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
                const res = sorted.map((cat) => {
                  const catLectures = lectures.filter((l) => l.category_id === cat.id);
                  return {
                    ...cat,
                    lectures: catLectures.map((l) => ({ id: l.id, status: l.status })),
                  };
                });
                resolve({ data: res, error: null });
              },
            };
            return chain;
          },
          delete: () => ({
            in: async (col, vals) => {
              for (const v of vals) {
                const idx = categories.findIndex((c) => c.id === v);
                if (idx !== -1) categories.splice(idx, 1);
              }
              return { data: null, error: null };
            },
          }),
          upsert: (catData) => {
            let existing = categories.find((c) => c.slug === catData.slug);
            if (!existing) {
              existing = { id: `cat-${categories.length + 1}`, ...catData };
              categories.push(existing);
            } else {
              Object.assign(existing, catData);
            }
            return {
              select: () => ({
                single: async () => ({ data: existing, error: null }),
              }),
              then: (resolve) => resolve({ data: existing, error: null }),
            };
          },
        };
      }

      if (table === 'lectures') {
        return {
          delete: () => ({
            in: async (col, vals) => {
              for (const v of vals) {
                const idx = lectures.findIndex((l) => l.id === v);
                if (idx !== -1) lectures.splice(idx, 1);
              }
              return { data: null, error: null };
            },
          }),
          select: (columns) => {
            const filters = {
              category_id: null,
              status: null,
              id: null,
            };
            let orderCol = 'lesson_order';
            let ascending = true;

            const chain = {
              eq: (col, val) => {
                filters[col] = val;
                return chain;
              },
              order: (col, opts = {}) => {
                orderCol = col;
                ascending = opts.ascending !== false;
                return chain;
              },
              single: async () => {
                const found = lectures.find((l) => l.id === filters.id);
                if (!found) return { data: null, error: new Error('Not found') };
                const cat = categories.find((c) => c.id === found.category_id);
                return {
                  data: {
                    ...found,
                    category: cat ? { id: cat.id, title: cat.title, slug: cat.slug } : null,
                  },
                  error: null,
                };
              },
              then: (resolve) => {
                let results = lectures.filter((l) => {
                  if (filters.category_id && l.category_id !== filters.category_id) return false;
                  if (filters.status && l.status !== filters.status) return false;
                  return true;
                });
                results.sort((a, b) => (a.lesson_order || 0) - (b.lesson_order || 0));
                const mapped = results.map((l) => {
                  const cat = categories.find((c) => c.id === l.category_id);
                  return {
                    ...l,
                    category: cat ? { id: cat.id, title: cat.title, slug: cat.slug } : null,
                  };
                });
                resolve({ data: mapped, error: null });
              },
            };
            return chain;
          },
          upsert: (lecData) => {
            let existing = lectures.find((l) => l.slug === lecData.slug);
            if (!existing) {
              existing = { id: `lec-${lectures.length + 1}`, ...lecData };
              lectures.push(existing);
            } else {
              Object.assign(existing, lecData);
            }
            return {
              select: () => ({
                single: async () => ({ data: existing, error: null }),
              }),
              then: (resolve) => resolve({ data: existing, error: null }),
            };
          },
        };
      }

      return {};
    },
  };
}

test('1. Google Classroom course manifest preserves all 23 categories and sequential lessons', () => {
  const manifest = loadDefaultManifest();
  assert.ok(manifest, 'Expected default manifest to load from data directory');
  assert.equal(manifest.courseTitle, 'Jr. MCWC Videos');
  assert.equal(manifest.categories.length, 23, 'Must preserve all 23 calculation categories');

  // Verify Addition category preserves its 3 distinct parts
  const addition = manifest.categories.find((c) => c.slug === 'addition');
  assert.ok(addition, 'Expected addition category in manifest');
  assert.equal(addition.lessons.length, 3, 'Addition must have 3 video lessons');
  assert.ok(addition.lessons[0].title.includes('Part 1'), 'Lesson 1 must be Part 1');
  assert.ok(addition.lessons[1].title.includes('Part 2'), 'Lesson 2 must be Part 2');
  assert.ok(addition.lessons[2].title.includes('Part 3'), 'Lesson 3 must be Part 3');
  assert.equal(addition.lessons[0].lessonOrder, 1);
  assert.equal(addition.lessons[1].lessonOrder, 2);
  assert.equal(addition.lessons[2].lessonOrder, 3);
});

test('2. Unauthenticated calls fail closed with 401 UNAUTHENTICATED', async () => {
  const { req, res } = createMockReqRes({ headers: { authorization: '' } });
  await handleLecturesRequest(req, res, { supabase: null });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'UNAUTHENTICATED');
});

test('3. Enrolled student can list categories with accurate lesson counts', async () => {
  const student = { id: 'stu-1', email: 'stu@example.com', role: 'student', active: true };
  const mockCategories = [
    { id: 'cat-1', title: 'Addition', slug: 'addition', sort_order: 1, active: true },
    { id: 'cat-2', title: 'Subtraction', slug: 'subtraction', sort_order: 2, active: true },
  ];
  const mockLectures = [
    { id: 'lec-1', category_id: 'cat-1', title: 'Addition Part 1', status: 'active', lesson_order: 1 },
    { id: 'lec-2', category_id: 'cat-1', title: 'Addition Part 2', status: 'active', lesson_order: 2 },
    { id: 'lec-3', category_id: 'cat-1', title: 'Addition Part 3', status: 'draft', lesson_order: 3 }, // draft
    { id: 'lec-4', category_id: 'cat-2', title: 'Subtraction Part 1', status: 'active', lesson_order: 1 },
  ];

  const supabase = createMockSupabase(student, { categories: mockCategories, lectures: mockLectures });
  const { req, res } = createMockReqRes({ body: { action: 'list_categories' } });

  await handleLecturesRequest(req, res, { supabase });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.categories.length, 2);

  // Student should only see count of ACTIVE lessons (Addition has 2 active, 1 draft)
  const addCat = res.body.categories.find((c) => c.slug === 'addition');
  assert.equal(addCat.lessonCount, 2, 'Student should see 2 active lessons in Addition');
});

test('4. Enrolled student can list lectures filtered by category and receive active lessons in order', async () => {
  const student = { id: 'stu-1', email: 'stu@example.com', role: 'student', active: true };
  const mockCategories = [
    { id: 'cat-1', title: 'Addition', slug: 'addition', sort_order: 1, active: true },
  ];
  const mockLectures = [
    { id: 'lec-2', category_id: 'cat-1', title: 'Addition Part 2', slug: 'addition-part-2', lesson_order: 2, status: 'active' },
    { id: 'lec-1', category_id: 'cat-1', title: 'Addition Part 1', slug: 'addition-part-1', lesson_order: 1, status: 'active' },
    { id: 'lec-3', category_id: 'cat-1', title: 'Addition Part 3', slug: 'addition-part-3', lesson_order: 3, status: 'draft' },
  ];

  const supabase = createMockSupabase(student, { categories: mockCategories, lectures: mockLectures });
  const { req, res } = createMockReqRes({
    body: { action: 'list_lectures', categoryId: 'cat-1' },
  });

  await handleLecturesRequest(req, res, { supabase });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  // Draft lesson should be excluded for students
  assert.equal(res.body.lectures.length, 2);
  // Lessons must be sorted by lesson_order ascending
  assert.equal(res.body.lectures[0].lessonOrder, 1);
  assert.equal(res.body.lectures[0].title, 'Addition Part 1');
  assert.equal(res.body.lectures[1].lessonOrder, 2);
  assert.equal(res.body.lectures[1].title, 'Addition Part 2');
});

test('5. get_lecture resolves sequential queue navigation (previous and next lecture IDs)', async () => {
  const student = { id: 'stu-1', email: 'stu@example.com', role: 'student', active: true };
  const mockCategories = [
    { id: 'cat-1', title: 'Addition', slug: 'addition', sort_order: 1, active: true },
  ];
  const mockLectures = [
    { id: 'lec-1', category_id: 'cat-1', title: 'Addition Part 1', slug: 'addition-part-1', lesson_order: 1, status: 'active', media_type: 'drive_embed', media_url: 'https://drive.google.com/file/d/abc1/preview' },
    { id: 'lec-2', category_id: 'cat-1', title: 'Addition Part 2', slug: 'addition-part-2', lesson_order: 2, status: 'active', media_type: 'drive_embed', media_url: 'https://drive.google.com/file/d/abc2/preview' },
    { id: 'lec-3', category_id: 'cat-1', title: 'Addition Part 3', slug: 'addition-part-3', lesson_order: 3, status: 'active', media_type: 'drive_embed', media_url: 'https://drive.google.com/file/d/abc3/preview' },
  ];

  const supabase = createMockSupabase(student, { categories: mockCategories, lectures: mockLectures });

  // Check middle lesson (Part 2): should have Part 1 as previous, Part 3 as next
  const { req, res } = createMockReqRes({
    body: { action: 'get_lecture', lectureId: 'lec-2' },
  });

  await handleLecturesRequest(req, res, { supabase });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.lecture.title, 'Addition Part 2');
  assert.equal(res.body.lecture.previousLectureId, 'lec-1');
  assert.equal(res.body.lecture.previousLectureTitle, 'Addition Part 1');
  assert.equal(res.body.lecture.nextLectureId, 'lec-3');
  assert.equal(res.body.lecture.nextLectureTitle, 'Addition Part 3');
});

test('6. Admin Classroom Import & Draft Preview enforces role boundary', async () => {
  const student = { id: 'stu-1', email: 'stu@example.com', role: 'student', active: true };
  const admin = { id: 'adm-1', email: 'admin@example.com', role: 'admin', active: true };

  // Student call to import_preview should be rejected with 403
  const studentSupabase = createMockSupabase(student);
  const { req: stuReq, res: stuRes } = createMockReqRes({ body: { action: 'import_preview' } });
  await handleLecturesRequest(stuReq, stuRes, { supabase: studentSupabase });
  assert.equal(stuRes.statusCode, 403);
  assert.equal(stuRes.body.code, 'FORBIDDEN');

  // Admin call to import_preview should succeed
  const adminSupabase = createMockSupabase(admin);
  const { req: admReq, res: admRes } = createMockReqRes({ body: { action: 'import_preview' } });
  await handleLecturesRequest(admReq, admRes, { supabase: adminSupabase });
  assert.equal(admRes.statusCode, 200);
  assert.equal(admRes.body.ok, true);
  assert.equal(admRes.body.preview.categoriesCount, 23);
  assert.equal(admRes.body.preview.totalLessonsCount, 28);
  assert.ok(Array.isArray(admRes.body.preview.categories));
});

test('7. Enforces publication and audience access on list and direct playback', async () => {
  const basicStudent = { id: 'stu-basic', email: 'basic@example.com', role: 'student', level: 'Basic 1', active: true };
  const mockCategories = [
    { id: 'cat-1', title: 'Addition', slug: 'addition', sort_order: 1, active: true },
  ];
  const mockLectures = [
    { id: 'lec-open', category_id: 'cat-1', title: 'Open Lecture', slug: 'open-lec', lesson_order: 1, status: 'active', target_level: null },
    { id: 'lec-basic', category_id: 'cat-1', title: 'Basic 1 Lecture', slug: 'basic-lec', lesson_order: 2, status: 'active', target_level: 'Basic 1' },
    { id: 'lec-master', category_id: 'cat-1', title: 'Grand Master Lecture', slug: 'master-lec', lesson_order: 3, status: 'active', target_level: 'Grand Master' },
    { id: 'lec-draft', category_id: 'cat-1', title: 'Draft Lecture', slug: 'draft-lec', lesson_order: 4, status: 'draft', target_level: 'Basic 1' },
  ];

  const supabase = createMockSupabase(basicStudent, { categories: mockCategories, lectures: mockLectures });

  // 1. list_lectures: Basic 1 student only sees open lecture and Basic 1 lecture (excludes Grand Master and draft)
  {
    const { req, res } = createMockReqRes({ body: { action: 'list_lectures', categoryId: 'cat-1' } });
    await handleLecturesRequest(req, res, { supabase });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.lectures.length, 2);
    const titles = res.body.lectures.map((l) => l.title);
    assert.deepEqual(titles, ['Open Lecture', 'Basic 1 Lecture']);
  }

  // 2. Direct playback of open lecture: succeeds
  {
    const { req, res } = createMockReqRes({ body: { action: 'get_lecture', lectureId: 'lec-open' } });
    await handleLecturesRequest(req, res, { supabase });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.lecture.title, 'Open Lecture');
  }

  // 3. Direct playback of matching level: succeeds
  {
    const { req, res } = createMockReqRes({ body: { action: 'get_lecture', lectureId: 'lec-basic' } });
    await handleLecturesRequest(req, res, { supabase });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.lecture.title, 'Basic 1 Lecture');
  }

  // 4. Direct playback of audience-restricted lecture: 403 AUDIENCE_RESTRICTED
  {
    const { req, res } = createMockReqRes({ body: { action: 'get_lecture', lectureId: 'lec-master' } });
    await handleLecturesRequest(req, res, { supabase });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'AUDIENCE_RESTRICTED');
  }

  // 5. Direct playback of draft lecture: 403 LECTURE_UNPUBLISHED
  {
    const { req, res } = createMockReqRes({ body: { action: 'get_lecture', lectureId: 'lec-draft' } });
    await handleLecturesRequest(req, res, { supabase });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'LECTURE_UNPUBLISHED');
  }
});

test('8. Database errors fail with 500 DATABASE_ERROR without silent manifest fallback', async () => {
  const student = { id: 'stu-1', email: 'stu@example.com', role: 'student', active: true };
  const failingSupabase = {
    auth: {
      getUser: async () => ({ data: { user: { id: student.id, email: student.email } }, error: null }),
    },
    from: (table) => {
      if (table === 'profiles') {
        return {
          select: () => ({ eq: () => ({ single: async () => ({ data: student, error: null }) }) }),
        };
      }
      return {
        select: () => ({
          order: () => Promise.resolve({ data: null, error: { message: 'relation "lecture_categories" does not exist', code: '42P01' } }),
          eq: () => ({ single: async () => ({ data: null, error: { message: 'Database query failed', code: '500' } }) }),
        }),
      };
    },
  };

  const { req, res } = createMockReqRes({ body: { action: 'list_categories' } });
  await handleLecturesRequest(req, res, { supabase: failingSupabase });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, 'DATABASE_ERROR');
});

test('9. Admin publish_import enforces pre-validation and atomic publishing', async () => {
  const admin = { id: 'adm-1', email: 'admin@example.com', role: 'admin', active: true };
  const dbState = { categories: [], lectures: [] };
  const supabase = createMockSupabase(admin, dbState);

  // 1. Invalid manifest (missing lecture mediaUrl) fails pre-validation with 400
  {
    const invalidManifest = {
      categories: [
        {
          title: 'Addition',
          slug: 'addition',
          lessons: [
            { title: 'Part 1', mediaUrl: '' }, // invalid URL
          ],
        },
      ],
    };
    const { req, res } = createMockReqRes({ body: { action: 'publish_import', manifest: invalidManifest } });
    await handleLecturesRequest(req, res, { supabase });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'INVALID_MANIFEST');
    assert.equal(dbState.categories.length, 0, 'No categories should be created on validation failure');
  }

  // 2. Valid manifest publishes atomically
  {
    const validManifest = {
      categories: [
        {
          title: 'Addition',
          slug: 'addition',
          lessons: [
            { title: 'Part 1', lessonOrder: 1, mediaUrl: 'https://www.w3schools.com/html/mov_bbb.mp4' },
          ],
        },
      ],
    };
    const { req, res } = createMockReqRes({ body: { action: 'publish_import', manifest: validManifest } });
    await handleLecturesRequest(req, res, { supabase });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.importedCategories, 1);
    assert.equal(res.body.importedLectures, 1);
  }

  // 3. Failed transactional publication fails with 500 DATABASE_ERROR and preserves the last good catalogue
  {
    dbState.shouldFailRpc = true;
    const failingManifest = {
      categories: [
        {
          title: 'Corrupted Category',
          slug: 'corrupted-cat',
          lessons: [
            { title: 'Bad Lesson', lessonOrder: 1, mediaUrl: 'https://example.com/bad.mp4' },
          ],
        },
      ],
    };
    const { req, res } = createMockReqRes({ body: { action: 'publish_import', manifest: failingManifest } });
    await handleLecturesRequest(req, res, { supabase });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.code, 'DATABASE_ERROR');
    // Ensure previous good catalogue state was untouched
    assert.equal(dbState.categories.length, 1, 'Previous good category must be preserved');
    assert.equal(dbState.categories[0].slug, 'addition', 'Addition category must be preserved');
    assert.equal(dbState.lectures.length, 1, 'Previous good lecture must be preserved');
  }
});

test('10. Private lecture storage signed URL resolution and security boundaries', async () => {
  const student = { id: 'stu-playback', role: 'student', active: true, email: 'stu@example.com' };
  const dbState = {
    categories: [
      { id: 'cat-add', title: 'Addition', slug: 'addition', sort_order: 1, active: true },
    ],
    lectures: [
      {
        id: 'lec-priv-1',
        category_id: 'cat-add',
        title: 'Addition Part 1 Private Master',
        slug: 'addition-part-1-priv',
        lesson_order: 1,
        status: 'active',
        duration_seconds: 600,
        media_type: 'video_mp4',
        media_url: 'storage://lectures/addition/part1-master.mp4',
        notes: 'Private lecture video reference',
      },
      {
        id: 'lec-bad-bucket',
        category_id: 'cat-add',
        title: 'Leaked Recording Reference',
        slug: 'leaked-recording',
        lesson_order: 2,
        status: 'active',
        duration_seconds: 600,
        media_type: 'video_mp4',
        media_url: 'storage://recordings/webinars/confidential.mp4',
        notes: 'Restricted bucket reference',
      },
      {
        id: 'lec-bad-uri',
        category_id: 'cat-add',
        title: 'Malformed URI',
        slug: 'malformed-uri',
        lesson_order: 3,
        status: 'active',
        duration_seconds: 600,
        media_type: 'video_mp4',
        media_url: 'storage://no-slash-path',
        notes: 'Invalid URI',
      },
    ],
  };

  const supabase = createMockSupabase(student, dbState);

  // 1. Authorized student requests private lecture in lectures bucket -> receives dynamic signed URL
  {
    const { req, res } = createMockReqRes({ body: { action: 'get_lecture', lectureId: 'lec-priv-1' } });
    await handleLecturesRequest(req, res, { supabase });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.ok(
      res.body.lecture.mediaUrl.startsWith('https://signed.supabase.co/storage/v1/object/sign/lectures/addition/part1-master.mp4?token='),
      `Expected signed URL, got ${res.body.lecture.mediaUrl}`
    );
  }

  // 2. Lecture attempting to access unauthorized bucket (recordings) is rejected with 403 BUCKET_RESTRICTED
  {
    const { req, res } = createMockReqRes({ body: { action: 'get_lecture', lectureId: 'lec-bad-bucket' } });
    await handleLecturesRequest(req, res, { supabase });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'BUCKET_RESTRICTED');
  }

  // 3. Lecture with malformed storage URI is rejected with 400 INVALID_STORAGE_URI
  {
    const { req, res } = createMockReqRes({ body: { action: 'get_lecture', lectureId: 'lec-bad-uri' } });
    await handleLecturesRequest(req, res, { supabase });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'INVALID_STORAGE_URI');
  }

  // 4. Storage signing failure returns 502 STORAGE_SIGNING_FAILED
  {
    dbState.storageError = 'Object not found in storage bucket';
    const { req, res } = createMockReqRes({ body: { action: 'get_lecture', lectureId: 'lec-priv-1' } });
    await handleLecturesRequest(req, res, { supabase });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.code, 'STORAGE_SIGNING_FAILED');
    delete dbState.storageError;
  }

  // 5. Storage service unavailable returns 500 STORAGE_UNAVAILABLE
  {
    dbState.noStorage = true;
    const noStorageSupabase = createMockSupabase(student, dbState);
    const { req, res } = createMockReqRes({ body: { action: 'get_lecture', lectureId: 'lec-priv-1' } });
    await handleLecturesRequest(req, res, { supabase: noStorageSupabase });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.code, 'STORAGE_UNAVAILABLE');
    delete dbState.noStorage;
  }
});
