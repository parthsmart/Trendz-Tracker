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

        if (error) {
          if (
            process.env.STAGING_PREVIEW === 'true' &&
            process.env.NODE_ENV !== 'production' &&
            !options.supabase &&
            (error.code === 'PGRST205' || error.code === '42P01' || error.message?.includes('schema cache') || error.message?.includes('does not exist'))
          ) {
            console.warn('[Lectures] Table public.lecture_categories not yet applied to database schema cache; serving staging preview catalogue.');
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
          return res.status(500).json({ error: error.message || 'Database error accessing lecture categories.', code: 'DATABASE_ERROR' });
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
        if (error) {
          if (
            process.env.STAGING_PREVIEW === 'true' &&
            process.env.NODE_ENV !== 'production' &&
            !options.supabase &&
            (error.code === 'PGRST205' || error.code === '42P01' || error.message?.includes('schema cache') || error.message?.includes('does not exist'))
          ) {
            console.warn('[Lectures] Table public.lectures not yet applied to database schema cache; serving staging preview lectures.');
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
                  id: `lec-${c.slug}-${l.lessonOrder || lIdx + 1}`,
                  categoryId: `cat-${c.slug}`,
                  categoryTitle: c.title,
                  categorySlug: c.slug,
                  title: l.title,
                  slug: l.slug || `${c.slug}-part-${l.lessonOrder || lIdx + 1}`,
                  lessonOrder: l.lessonOrder || lIdx + 1,
                  durationSeconds: l.durationSeconds || 0,
                  mediaType: l.mediaType || 'video_mp4',
                  mediaUrl: l.mediaUrl,
                  thumbnailUrl: l.thumbnailUrl || null,
                  notes: l.notes || '',
                  targetLevel: l.targetLevel || null,
                  status: 'active',
                });
              });
            });
            if (caller.role === 'student') {
              allLessons = allLessons.filter((l) => !l.targetLevel || l.targetLevel === caller.level);
            }
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
          return res.status(500).json({ error: error.message || 'Database error accessing lectures.', code: 'DATABASE_ERROR' });
        }

        let filtered = lectures || [];
        if (categorySlug) {
          filtered = filtered.filter((l) => l.category?.slug === categorySlug);
        }
        // Enforce audience access: students only see lectures open to all or matching their level
        if (caller.role === 'student') {
          filtered = filtered.filter((l) => !l.target_level || l.target_level === caller.level);
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

        if (error || !lecture) {
          if (
            process.env.STAGING_PREVIEW === 'true' &&
            process.env.NODE_ENV !== 'production' &&
            !options.supabase &&
            (error?.code === 'PGRST205' || error?.code === '42P01' || error?.message?.includes('schema cache') || error?.message?.includes('does not exist'))
          ) {
            console.warn('[Lectures] Table public.lectures not yet applied to database schema cache; resolving staging preview lecture details.');
            const manifest = loadDefaultManifest();
            const cats = manifest?.categories || [];
            let foundLesson = null;
            let foundCat = null;
            let siblings = [];
            for (const c of cats) {
              const lessons = c.lessons || [];
              for (const l of lessons) {
                const id = `lec-${c.slug}-${l.lessonOrder}`;
                if (id === lectureId || l.slug === lectureId) {
                  foundLesson = l;
                  foundCat = c;
                  siblings = lessons;
                  break;
                }
              }
              if (foundLesson) break;
            }
            if (!foundLesson) {
              return res.status(404).json({ error: 'Lecture not found.', code: 'LECTURE_NOT_FOUND' });
            }
            const currentIndex = siblings.findIndex((s) => s === foundLesson);
            const prev = currentIndex > 0 ? siblings[currentIndex - 1] : null;
            const next = currentIndex < siblings.length - 1 ? siblings[currentIndex + 1] : null;
            return res.status(200).json({
              ok: true,
              lecture: {
                id: `lec-${foundCat.slug}-${foundLesson.lessonOrder}`,
                categoryId: `cat-${foundCat.slug}`,
                categoryTitle: foundCat.title,
                categorySlug: foundCat.slug,
                title: foundLesson.title,
                slug: foundLesson.slug,
                lessonOrder: foundLesson.lessonOrder,
                totalLessons: siblings.length,
                durationSeconds: foundLesson.durationSeconds || 0,
                mediaType: foundLesson.mediaType || 'video_mp4',
                mediaUrl: foundLesson.mediaUrl,
                notes: foundLesson.notes || '',
                targetLevel: foundLesson.targetLevel || null,
                previousLectureId: prev ? `lec-${foundCat.slug}-${prev.lessonOrder}` : null,
                previousLectureTitle: prev ? prev.title : null,
                nextLectureId: next ? `lec-${foundCat.slug}-${next.lessonOrder}` : null,
                nextLectureTitle: next ? next.title : null,
              },
            });
          }
          return res.status(404).json({ error: 'Lecture not found.', code: 'LECTURE_NOT_FOUND' });
        }

        // 1. Publication enforcement: only admin can view non-active drafts
        if (caller.role !== 'admin' && lecture.status !== 'active') {
          return res.status(403).json({ error: 'This lecture has not been published.', code: 'LECTURE_UNPUBLISHED' });
        }

        // 2. Audience access enforcement: students can only access open or matching level lectures
        if (caller.role === 'student' && lecture.target_level && lecture.target_level !== caller.level) {
          return res.status(403).json({
            error: `This lecture is restricted to ${lecture.target_level} students.`,
            code: 'AUDIENCE_RESTRICTED',
            requiredLevel: lecture.target_level,
          });
        }

        // Fetch sibling lectures in same category to resolve next/previous navigation
        const { data: siblings } = await supabase
          .from('lectures')
          .select('id, title, lesson_order, target_level')
          .eq('category_id', lecture.category_id)
          .eq('status', 'active')
          .order('lesson_order', { ascending: true });

        // Filter sibling queue to only include lessons accessible to caller
        let accessibleSiblings = siblings || [];
        if (caller.role === 'student') {
          accessibleSiblings = accessibleSiblings.filter((s) => !s.target_level || s.target_level === caller.level);
        }

        const currentIndex = accessibleSiblings.findIndex((s) => s.id === lecture.id);
        const previousLecture = currentIndex > 0 ? accessibleSiblings[currentIndex - 1] : null;
        const nextLecture = currentIndex >= 0 && currentIndex < accessibleSiblings.length - 1 ? accessibleSiblings[currentIndex + 1] : null;

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
            totalLessons: accessibleSiblings.length,
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

      // 5. Admin Publish Classroom Import (Atomic Publishing)
      case 'publish_import': {
        if (caller.role !== 'admin') {
          return res.status(403).json({ error: 'Only administrators can publish Classroom imports.', code: 'FORBIDDEN' });
        }

        const manifest = body.manifest || loadDefaultManifest();
        if (!manifest || !Array.isArray(manifest.categories) || manifest.categories.length === 0) {
          return res.status(400).json({ error: 'Invalid manifest data to publish.', code: 'INVALID_MANIFEST' });
        }

        // 1. Strict schema validation before attempting database mutations
        for (let i = 0; i < manifest.categories.length; i++) {
          const cat = manifest.categories[i];
          if (!cat.title || typeof cat.title !== 'string') {
            return res.status(400).json({
              error: `Validation error at category #${i + 1}: Title is required.`,
              code: 'INVALID_MANIFEST',
            });
          }
          const lessons = Array.isArray(cat.lessons) ? cat.lessons : [];
          for (let j = 0; j < lessons.length; j++) {
            const l = lessons[j];
            if (!l.title || typeof l.title !== 'string') {
              return res.status(400).json({
                error: `Validation error in category "${cat.title}" lesson #${j + 1}: Title is required.`,
                code: 'INVALID_MANIFEST',
              });
            }
            if (!l.mediaUrl || typeof l.mediaUrl !== 'string' || (!l.mediaUrl.startsWith('http://') && !l.mediaUrl.startsWith('https://'))) {
              return res.status(400).json({
                error: `Validation error in category "${cat.title}" lesson "${l.title}": Valid media URL (http/https) is required.`,
                code: 'INVALID_MANIFEST',
              });
            }
          }
        }

        // 2. Transactional database routine for atomic publication — no sequential write fallback
        if (typeof supabase.rpc !== 'function') {
          return res.status(500).json({
            error: 'Database RPC client unavailable for atomic catalogue publication.',
            code: 'DATABASE_ERROR',
          });
        }

        const { data: rpcData, error: rpcError } = await supabase.rpc('publish_classroom_catalogue', {
          p_manifest: manifest,
        });

        if (rpcError) {
          return res.status(500).json({
            error: `Failed to publish catalogue via atomic RPC: ${rpcError.message}`,
            code: 'DATABASE_ERROR',
          });
        }

        if (!rpcData?.ok) {
          return res.status(500).json({
            error: rpcData?.error || 'Catalogue publishing failed in transactional routine.',
            code: 'DATABASE_ERROR',
          });
        }

        return res.status(200).json({
          ok: true,
          message: 'Google Classroom lecture catalogue successfully imported and published!',
          importedCategories: rpcData.importedCategories,
          importedLectures: rpcData.importedLectures,
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
