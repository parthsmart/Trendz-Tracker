/**
 * Trendz Tracker — Resources Lectures Catalogue Engine (api/_lectures.js)
 *
 * Implements:
 * - Google Classroom "Jr. MCWC Videos" catalogue management
 * - Preserves category and lesson ordering (e.g. Addition with 3 parts)
 * - Read-only student and staff category/lecture browsing
 * - Next / Previous lesson queue resolution for uninterrupted video watching
 * - Admin Classroom Import & Draft Preview workflow with validation
 * - Adheres to Vercel Hobby serverless limits.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdminClient, getCallerClient } from './_supabaseAdmin.js';
import { hasSupabaseAdminConfig } from './_configHelper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function extractBearerToken(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

async function authenticateCaller(supabase, req) {
  const token = extractBearerToken(req);
  if (!token) {
    const err = new Error('Authentication required. Missing Bearer token.');
    err.statusCode = 401;
    err.code = 'UNAUTHENTICATED';
    throw err;
  }

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    const err = new Error('Invalid or expired authentication token.');
    err.statusCode = 401;
    err.code = 'INVALID_TOKEN';
    throw err;
  }

  const { data: profile, error: profError } = await supabase
    .from('profiles')
    .select('id, full_name, role, level, active')
    .eq('id', user.id)
    .single();

  if (profError || !profile || !profile.active) {
    const err = new Error('Unauthorized or inactive account.');
    err.statusCode = 403;
    err.code = 'FORBIDDEN';
    throw err;
  }

  return {
    id: profile.id,
    email: user.email,
    fullName: profile.full_name || 'User',
    role: profile.role,
    level: profile.level,
  };
}

export function loadDefaultManifest() {
  const manifestPath = path.resolve(__dirname, '../data/jr_mcwc_classroom_manifest.json');
  if (fs.existsSync(manifestPath)) {
    const content = fs.readFileSync(manifestPath, 'utf-8');
    return JSON.parse(content);
  }
  return null;
}

export async function handleLecturesRequest(req, res, options = {}) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const callerToken = extractBearerToken(req);
  if (!callerToken) {
    return res.status(401).json({
      error: 'Authentication required. Missing Bearer token.',
      code: 'UNAUTHENTICATED',
    });
  }

  const supabase = options.supabase || (hasSupabaseAdminConfig() ? getAdminClient() : getCallerClient(callerToken || ''));

  try {
    const caller = await authenticateCaller(supabase, req);
    const body = req.body || {};
    const action = body.action || 'list_categories';

    switch (action) {
      // 1. List Categories with lesson counts
      case 'list_categories': {
        const { data: categories, error } = await supabase
          .from('lecture_categories')
          .select(`
            id,
            title,
            slug,
            description,
            sort_order,
            active,
            lectures (id, status)
          `)
          .order('sort_order', { ascending: true });

        if (error && (error.code === '42P01' || error.message?.includes('does not exist') || error.message?.includes('schema cache') || error.message?.includes('table'))) {
          // Table lecture_categories not yet applied to database; load from manifest
          const manifest = loadDefaultManifest();
          const cats = manifest?.categories || [];
          const formatted = cats.map((cat, idx) => ({
            id: `cat-${cat.slug}`,
            title: cat.title,
            slug: cat.slug,
            description: cat.description || '',
            sortOrder: cat.sortOrder || idx + 1,
            active: true,
            lessonCount: Array.isArray(cat.lessons) ? cat.lessons.length : 0,
          }));
          return res.status(200).json({ ok: true, categories: formatted });
        }

        if (error) {
          return res.status(500).json({ error: error.message, code: 'DATABASE_ERROR' });
        }

        const formatted = (categories || []).map((cat) => {
          const activeLessons = (cat.lectures || []).filter(
            (l) => caller.role === 'admin' || l.status === 'active'
          );
          return {
            id: cat.id,
            title: cat.title,
            slug: cat.slug,
            description: cat.description,
            sortOrder: cat.sort_order,
            active: cat.active,
            lessonCount: activeLessons.length,
          };
        });

        return res.status(200).json({
          ok: true,
          categories: formatted,
        });
      }

      // 2. List Lectures for a category
      case 'list_lectures': {
        const { categoryId, categorySlug, search } = body;
        let query = supabase
          .from('lectures')
          .select(`
            id,
            category_id,
            title,
            slug,
            lesson_order,
            duration_seconds,
            media_type,
            media_url,
            thumbnail_url,
            notes,
            target_level,
            status,
            category:lecture_categories!category_id (id, title, slug)
          `)
          .order('lesson_order', { ascending: true });

        if (categoryId) {
          query = query.eq('category_id', categoryId);
        }

        if (caller.role !== 'admin') {
          query = query.eq('status', 'active');
        }

        const { data: lectures, error } = await query;
        if (error && (error.code === '42P01' || error.message?.includes('does not exist') || error.message?.includes('schema cache') || error.message?.includes('table'))) {
          const manifest = loadDefaultManifest();
          const cats = manifest?.categories || [];
          let filteredCats = cats;
          if (categorySlug) {
            filteredCats = cats.filter((c) => c.slug === categorySlug);
          }
          let allLessons = [];
          filteredCats.forEach((c) => {
            (c.lessons || []).forEach((l, lIdx) => {
              allLessons.push({
                id: `lec-${c.slug}-${lIdx + 1}`,
                categoryId: `cat-${c.slug}`,
                categoryTitle: c.title,
                categorySlug: c.slug,
                title: l.title,
                slug: l.slug || `${c.slug}-part-${lIdx + 1}`,
                lessonOrder: l.lessonOrder || lIdx + 1,
                durationSeconds: l.durationSeconds || 0,
                mediaType: l.mediaType || 'drive_embed',
                mediaUrl: l.mediaUrl,
                thumbnailUrl: l.thumbnailUrl || null,
                notes: l.notes || '',
                targetLevel: l.targetLevel || null,
                status: 'active',
              });
            });
          });
          if (search) {
            const s = search.toLowerCase();
            allLessons = allLessons.filter((l) =>
              l.title.toLowerCase().includes(s) ||
              l.categoryTitle.toLowerCase().includes(s) ||
              l.notes.toLowerCase().includes(s)
            );
          }
          return res.status(200).json({ ok: true, lectures: allLessons });
        }

        if (error) {
          return res.status(500).json({ error: error.message, code: 'DATABASE_ERROR' });
        }

        let filtered = lectures || [];
        if (categorySlug) {
          filtered = filtered.filter((l) => l.category?.slug === categorySlug);
        }
        if (search) {
          const s = search.toLowerCase();
          filtered = filtered.filter((l) =>
            l.title.toLowerCase().includes(s) ||
            (l.category?.title && l.category.title.toLowerCase().includes(s)) ||
            (l.notes && l.notes.toLowerCase().includes(s))
          );
        }

        return res.status(200).json({
          ok: true,
          lectures: filtered.map((l) => ({
            id: l.id,
            categoryId: l.category_id,
            categoryTitle: l.category?.title || 'General',
            categorySlug: l.category?.slug || '',
            title: l.title,
            slug: l.slug,
            lessonOrder: l.lesson_order,
            durationSeconds: l.duration_seconds,
            mediaType: l.media_type,
            mediaUrl: l.media_url,
            thumbnailUrl: l.thumbnail_url,
            notes: l.notes,
            targetLevel: l.target_level,
            status: l.status,
          })),
        });
      }

      // 3. Get Single Lecture Details with queue resolution
      case 'get_lecture': {
        const { lectureId } = body;
        if (!lectureId) {
          return res.status(400).json({ error: 'Missing required lectureId parameter.', code: 'INVALID_REQUEST' });
        }

        const { data: lecture, error } = await supabase
          .from('lectures')
          .select(`
            id,
            category_id,
            title,
            slug,
            lesson_order,
            duration_seconds,
            media_type,
            media_url,
            thumbnail_url,
            notes,
            target_level,
            status,
            category:lecture_categories!category_id (id, title, slug)
          `)
          .eq('id', lectureId)
          .single();

        if (error && (error.code === '42P01' || error.message?.includes('does not exist') || error.message?.includes('schema cache') || error.message?.includes('table'))) {
          const manifest = loadDefaultManifest();
          const cats = manifest?.categories || [];
          for (const c of cats) {
            const lessons = c.lessons || [];
            const idx = lessons.findIndex((l, i) => `lec-${c.slug}-${i + 1}` === lectureId || l.slug === lectureId);
            if (idx !== -1) {
              const current = lessons[idx];
              const prev = idx > 0 ? lessons[idx - 1] : null;
              const next = idx < lessons.length - 1 ? lessons[idx + 1] : null;
              return res.status(200).json({
                ok: true,
                lecture: {
                  id: lectureId,
                  categoryId: `cat-${c.slug}`,
                  categoryTitle: c.title,
                  categorySlug: c.slug,
                  title: current.title,
                  slug: current.slug || `${c.slug}-part-${idx + 1}`,
                  lessonOrder: current.lessonOrder || idx + 1,
                  totalLessons: lessons.length,
                  durationSeconds: current.durationSeconds || 0,
                  mediaType: current.mediaType || 'drive_embed',
                  mediaUrl: current.mediaUrl,
                  notes: current.notes || '',
                  targetLevel: current.targetLevel || null,
                  previousLectureId: prev ? `lec-${c.slug}-${idx}` : null,
                  previousLectureTitle: prev ? prev.title : null,
                  nextLectureId: next ? `lec-${c.slug}-${idx + 2}` : null,
                  nextLectureTitle: next ? next.title : null,
                },
              });
            }
          }
          return res.status(404).json({ error: 'Lecture not found.', code: 'LECTURE_NOT_FOUND' });
        }

        if (error || !lecture) {
          return res.status(404).json({ error: 'Lecture not found.', code: 'LECTURE_NOT_FOUND' });
        }

        // Fetch sibling lectures in same category to resolve next/previous navigation
        const { data: siblings } = await supabase
          .from('lectures')
          .select('id, title, lesson_order')
          .eq('category_id', lecture.category_id)
          .eq('status', 'active')
          .order('lesson_order', { ascending: true });

        const sorted = siblings || [];
        const currentIndex = sorted.findIndex((s) => s.id === lecture.id);
        const previousLecture = currentIndex > 0 ? sorted[currentIndex - 1] : null;
        const nextLecture = currentIndex >= 0 && currentIndex < sorted.length - 1 ? sorted[currentIndex + 1] : null;

        return res.status(200).json({
          ok: true,
          lecture: {
            id: lecture.id,
            categoryId: lecture.category_id,
            categoryTitle: lecture.category?.title || 'General',
            categorySlug: lecture.category?.slug || '',
            title: lecture.title,
            slug: lecture.slug,
            lessonOrder: lecture.lesson_order,
            totalLessons: sorted.length,
            durationSeconds: lecture.duration_seconds,
            mediaType: lecture.media_type,
            mediaUrl: lecture.media_url,
            notes: lecture.notes,
            targetLevel: lecture.target_level,
            previousLectureId: previousLecture?.id || null,
            previousLectureTitle: previousLecture?.title || null,
            nextLectureId: nextLecture?.id || null,
            nextLectureTitle: nextLecture?.title || null,
          },
        });
      }

      // 4. Admin Classroom Import Preview
      case 'import_preview': {
        if (caller.role !== 'admin') {
          return res.status(403).json({ error: 'Only administrators can preview Classroom imports.', code: 'FORBIDDEN' });
        }

        const manifest = body.manifest || loadDefaultManifest();
        if (!manifest || !Array.isArray(manifest.categories)) {
          return res.status(400).json({
            error: 'Invalid or missing classroom manifest data.',
            code: 'INVALID_MANIFEST',
          });
        }

        let totalLessons = 0;
        const warnings = [];
        const validatedCategories = manifest.categories.map((cat, idx) => {
          const lessons = Array.isArray(cat.lessons) ? cat.lessons : [];
          totalLessons += lessons.length;

          if (lessons.length === 0) {
            warnings.push(`Category "${cat.title}" contains 0 video attachments.`);
          }

          return {
            title: cat.title,
            slug: cat.slug || cat.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
            description: cat.description || '',
            sortOrder: cat.sortOrder || idx + 1,
            lessonCount: lessons.length,
            lessons: lessons.map((l, lIdx) => ({
              title: l.title,
              slug: l.slug || `${cat.slug}-part-${lIdx + 1}`,
              lessonOrder: l.lessonOrder || lIdx + 1,
              durationSeconds: l.durationSeconds || 0,
              mediaType: l.mediaType || 'drive_embed',
              mediaUrl: l.mediaUrl,
              notes: l.notes || '',
            })),
          };
        });

        return res.status(200).json({
          ok: true,
          preview: {
            courseId: manifest.courseId || 'NjAxODkyNTgwODIy',
            courseTitle: manifest.courseTitle || 'Jr. MCWC Videos',
            categoriesCount: validatedCategories.length,
            totalLessonsCount: totalLessons,
            warnings,
            categories: validatedCategories,
          },
        });
      }

      // 5. Admin Publish Classroom Import
      case 'publish_import': {
        if (caller.role !== 'admin') {
          return res.status(403).json({ error: 'Only administrators can publish Classroom imports.', code: 'FORBIDDEN' });
        }

        const manifest = body.manifest || loadDefaultManifest();
        if (!manifest || !Array.isArray(manifest.categories)) {
          return res.status(400).json({ error: 'Invalid manifest data to publish.', code: 'INVALID_MANIFEST' });
        }

        let createdCategories = 0;
        let createdLectures = 0;

        for (let i = 0; i < manifest.categories.length; i++) {
          const cat = manifest.categories[i];
          const slug = cat.slug || cat.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');

          // Upsert category
          const { data: categoryRow, error: catError } = await supabase
            .from('lecture_categories')
            .upsert(
              {
                title: cat.title,
                slug,
                description: cat.description || '',
                sort_order: cat.sortOrder || i + 1,
                active: true,
                updated_at: new Date().toISOString(),
              },
              { onConflict: 'slug' }
            )
            .select('id')
            .single();

          if (catError || !categoryRow) {
            continue;
          }
          createdCategories++;

          const lessons = Array.isArray(cat.lessons) ? cat.lessons : [];
          for (let j = 0; j < lessons.length; j++) {
            const l = lessons[j];
            const lessonSlug = l.slug || `${slug}-part-${j + 1}`;

            const { error: lecError } = await supabase
              .from('lectures')
              .upsert(
                {
                  category_id: categoryRow.id,
                  title: l.title,
                  slug: lessonSlug,
                  lesson_order: l.lessonOrder || j + 1,
                  duration_seconds: l.durationSeconds || 0,
                  media_type: l.mediaType || 'drive_embed',
                  media_url: l.mediaUrl,
                  notes: l.notes || '',
                  status: 'active',
                  updated_at: new Date().toISOString(),
                },
                { onConflict: 'category_id, lesson_order' }
              );

            if (!lecError) {
              createdLectures++;
            }
          }
        }

        return res.status(200).json({
          ok: true,
          message: 'Google Classroom lecture catalogue successfully imported and published!',
          importedCategories: createdCategories,
          importedLectures: createdLectures,
        });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}`, code: 'UNKNOWN_ACTION' });
    }
  } catch (err) {
    const status = Number(err?.statusCode) || 500;
    return res.status(status).json({
      error: err?.message || 'An unexpected error occurred processing lectures request.',
      code: err?.code || 'INTERNAL_ERROR',
    });
  }
}
