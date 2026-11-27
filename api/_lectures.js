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

import { getAdminClient, getCallerClient } from './_supabaseAdmin.js';
import { normalizeProfileRole } from '../js/roles.js';
import { hasSupabaseAdminConfig } from './_configHelper.js';
import { JMCWC_GROUPS } from './_jmcwcMath.js';

const PRIVATE_LECTURES_BUCKET = process.env.PRIVATE_LECTURES_BUCKET || 'lectures';

function isPlaceholderVideo(url) {
  return typeof url === 'string' &&
    /\/file\/d\/1[A-Z0-9]+(?:_[A-Z0-9]+)+\/(?:preview|view)(?:[?#]|$)/.test(url);
}

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

  const { data: rawProfile, error: profError } = await supabase
    .from('profiles')
    .select('id, full_name, role, level, active')
    .eq('id', user.id)
    .single();
  const profile = normalizeProfileRole(rawProfile);

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

  const useCallerClient = !options.supabase && !hasSupabaseAdminConfig();
  const supabase = options.supabase || (useCallerClient ? getCallerClient(callerToken) : getAdminClient());

  try {
    const caller = await authenticateCaller(supabase, req);
    const body = req.body || {};
    const action = body.action || 'list_categories';
    let assignmentLookup;
    const getAudienceFilter = async (lessons) => {
      if (caller.role !== 'student') return () => true;
      if (lessons.some((lesson) => lesson.requires_jmcwc_assignment)) {
        assignmentLookup ??= (async () => {
          const { data, error } = useCallerClient
            ? await supabase.rpc('has_jmcwc_lecture_assignment')
            : await supabase.from('jmcwc_assignments')
              .select('group_key').eq('student_id', caller.id).maybeSingle();
          if (error) {
            throw Object.assign(new Error('Could not verify your JMCWC assignment.'), {
              statusCode: 503, code: 'JMCWC_ASSIGNMENT_UNAVAILABLE',
            });
          }
          return useCallerClient ? data === true : JMCWC_GROUPS.includes(data?.group_key);
        })();
      }
      const assigned = assignmentLookup ? await assignmentLookup : false;
      return (lesson) => (!lesson.target_level || lesson.target_level === caller.level) &&
        (!lesson.requires_jmcwc_assignment || assigned);
    };

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
            lectures (id, status, target_level, requires_jmcwc_assignment)
          `)
          .order('sort_order', { ascending: true });

        if (error) {
          return res.status(500).json({ error: error.message || 'Database error accessing lecture categories.', code: 'DATABASE_ERROR' });
        }

        const visibleCategories = (categories || []).filter((cat) => caller.role === 'admin' || cat.active);
        const inAudience = await getAudienceFilter(visibleCategories.flatMap(
          (cat) => (cat.lectures || []).filter((lesson) => lesson.status === 'active')
        ));
        const formatted = visibleCategories.map((cat) => {
          const activeLessons = (cat.lectures || []).filter(
            (l) => caller.role === 'admin' || (
              l.status === 'active' &&
              inAudience(l)
            )
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
        }).filter((cat) => caller.role === 'admin' || cat.lessonCount > 0);

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
            requires_jmcwc_assignment,
            status,
            category:lecture_categories!category_id (id, title, slug, active)
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
          return res.status(500).json({ error: error.message || 'Database error accessing lectures.', code: 'DATABASE_ERROR' });
        }

        let filtered = (lectures || []).filter(
          (lecture) => caller.role === 'admin' || lecture.category?.active !== false
        );
        if (categorySlug) {
          filtered = filtered.filter((l) => l.category?.slug === categorySlug);
        }
        const inAudience = await getAudienceFilter(filtered);
        filtered = filtered.filter(inAudience);
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
            requiresJmcwcAssignment: l.requires_jmcwc_assignment === true,
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
            requires_jmcwc_assignment,
            status,
            category:lecture_categories!category_id (id, title, slug, active)
          `)
          .eq('id', lectureId)
          .single();

        if (error || !lecture) {
          return res.status(404).json({ error: 'Lecture not found.', code: 'LECTURE_NOT_FOUND' });
        }

        // 1. Publication enforcement: only admin can view non-active drafts
        if (caller.role !== 'admin' && (lecture.status !== 'active' || lecture.category?.active === false)) {
          return res.status(403).json({ error: 'This lecture has not been published.', code: 'LECTURE_UNPUBLISHED' });
        }

        const inAudience = await getAudienceFilter([lecture]);
        if (!inAudience(lecture)) {
          return res.status(403).json({
            error: lecture.requires_jmcwc_assignment
              ? 'This lecture requires a JMCWC group assignment and any listed level restriction.'
              : `This lecture is restricted to ${lecture.target_level} students.`,
            code: 'AUDIENCE_RESTRICTED',
            requiredLevel: lecture.target_level,
          });
        }

        // Fetch sibling lectures in same category to resolve next/previous navigation
        const { data: siblings } = await supabase
          .from('lectures')
          .select('id, title, lesson_order, target_level, requires_jmcwc_assignment')
          .eq('category_id', lecture.category_id)
          .eq('status', 'active')
          .order('lesson_order', { ascending: true });

        // Filter sibling queue to only include lessons accessible to caller
        const siblingAudience = await getAudienceFilter(siblings || []);
        const accessibleSiblings = (siblings || []).filter(siblingAudience);

        const currentIndex = accessibleSiblings.findIndex((s) => s.id === lecture.id);
        const previousLecture = currentIndex > 0 ? accessibleSiblings[currentIndex - 1] : null;
        const nextLecture = currentIndex >= 0 && currentIndex < accessibleSiblings.length - 1 ? accessibleSiblings[currentIndex + 1] : null;

        // Resolve private Supabase Storage signed URLs if stored as a private storage reference
        let mediaUrl = lecture.media_url;
        if (typeof mediaUrl === 'string' && (mediaUrl.startsWith('storage://') || mediaUrl.startsWith('private://'))) {
          const rawPath = mediaUrl.replace(/^(storage|private):\/\//, '');
          const slashIdx = rawPath.indexOf('/');
          if (slashIdx === -1) {
            return res.status(400).json({
              error: 'Invalid storage reference. Format must be storage://<bucket>/<path>.',
              code: 'INVALID_STORAGE_URI',
            });
          }
          const bucket = rawPath.slice(0, slashIdx);
          const objectPath = rawPath.slice(slashIdx + 1);

          // Restrict strictly to the configured private lectures bucket
          if (bucket !== PRIVATE_LECTURES_BUCKET) {
            return res.status(403).json({
              error: `Access denied. Private lecture playback is strictly restricted to the configured "${PRIVATE_LECTURES_BUCKET}" bucket.`,
              code: 'BUCKET_RESTRICTED',
            });
          }

          if (!supabase.storage) {
            return res.status(500).json({
              error: 'Storage service is unavailable for generating signed playback URLs.',
              code: 'STORAGE_UNAVAILABLE',
            });
          }

          const { data: signedData, error: signErr } = await supabase.storage
            .from(bucket)
            .createSignedUrl(objectPath, 3600);

          if (signErr || !signedData?.signedUrl) {
            return res.status(502).json({
              error: `Failed to generate signed playback URL for private lecture: ${signErr?.message || 'Storage signing returned empty URL.'}`,
              code: 'STORAGE_SIGNING_FAILED',
            });
          }

          mediaUrl = signedData.signedUrl;
        }

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
            mediaUrl,
            notes: lecture.notes,
            targetLevel: lecture.target_level,
            requiresJmcwcAssignment: lecture.requires_jmcwc_assignment === true,
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

        const manifest = body.manifest;
        if (!Array.isArray(manifest?.categories) || !manifest.categories.length ||
            manifest.categories.some((cat) => typeof cat?.title !== 'string' || !cat.title.trim())) {
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
          for (const lesson of lessons) {
            if (!lesson?.mediaUrl || isPlaceholderVideo(lesson.mediaUrl)) {
              warnings.push(`"${lesson?.title || 'Untitled lesson'}" needs a verified video reference.`);
            }
          }

          return {
            title: cat.title,
            slug: cat.slug || cat.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
            description: cat.description || '',
            sortOrder: cat.sortOrder || idx + 1,
            lessonCount: lessons.length,
            lessons: lessons.filter(Boolean).map((l, lIdx) => ({
              title: l.title,
              slug: l.slug || `${cat.slug}-part-${lIdx + 1}`,
              lessonOrder: l.lessonOrder || lIdx + 1,
              durationSeconds: l.durationSeconds || 0,
              mediaType: l.mediaType || (typeof l.mediaUrl === 'string' && (l.mediaUrl.startsWith('storage://') || l.mediaUrl.startsWith('private://')) ? 'video_mp4' : 'drive_embed'),
              mediaUrl: l.mediaUrl,
              requiresJmcwcAssignment: l.requiresJmcwcAssignment === true,
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

        const manifest = body.manifest;
        if (!manifest || !Array.isArray(manifest.categories) || manifest.categories.length === 0) {
          return res.status(400).json({ error: 'Invalid manifest data to publish.', code: 'INVALID_MANIFEST' });
        }

        // 1. Strict schema validation before attempting database mutations
        for (let i = 0; i < manifest.categories.length; i++) {
          const cat = manifest.categories[i];
          if (typeof cat?.title !== 'string' || !cat.title.trim()) {
            return res.status(400).json({
              error: `Validation error at category #${i + 1}: Title is required.`,
              code: 'INVALID_MANIFEST',
            });
          }
          const lessons = Array.isArray(cat.lessons) ? cat.lessons : [];
          for (let j = 0; j < lessons.length; j++) {
            const l = lessons[j];
            if (typeof l?.title !== 'string' || !l.title.trim()) {
              return res.status(400).json({
                error: `Validation error in category "${cat.title}" lesson #${j + 1}: Title is required.`,
                code: 'INVALID_MANIFEST',
              });
            }

            if ('requiresJmcwcAssignment' in l && typeof l.requiresJmcwcAssignment !== 'boolean') {
              return res.status(400).json({
                error: `"${l.title}" must use a boolean JMCWC assignment requirement.`,
                code: 'INVALID_MANIFEST',
              });
            }
            if (!l.mediaUrl || typeof l.mediaUrl !== 'string' || isPlaceholderVideo(l.mediaUrl)) {
              return res.status(400).json({
                error: `"${l.title}" needs a verified video reference.`,
                code: 'INVALID_MANIFEST',
              });
            }

            const isHttp = l.mediaUrl.startsWith('http://') || l.mediaUrl.startsWith('https://');
            const isStorage = l.mediaUrl.startsWith('storage://') || l.mediaUrl.startsWith('private://');

            if (!isHttp && !isStorage) {
              return res.status(400).json({
                error: `Validation error in category "${cat.title}" lesson "${l.title}": Valid media URL (http/https or storage://${PRIVATE_LECTURES_BUCKET}/...) is required.`,
                code: 'INVALID_MANIFEST',
              });
            }

            if (isStorage) {
              const rawPath = l.mediaUrl.replace(/^(storage|private):\/\//, '');
              const slashIdx = rawPath.indexOf('/');
              const bucket = slashIdx !== -1 ? rawPath.slice(0, slashIdx) : rawPath;
              const objectPath = slashIdx !== -1 ? rawPath.slice(slashIdx + 1) : '';

              if (slashIdx === -1 || !objectPath.trim()) {
                return res.status(400).json({
                  error: `Validation error in category "${cat.title}" lesson "${l.title}": Invalid storage reference format. Expected storage://<bucket>/<path>.`,
                  code: 'INVALID_STORAGE_URI',
                });
              }

              if (bucket !== PRIVATE_LECTURES_BUCKET) {
                return res.status(400).json({
                  error: `Validation error in category "${cat.title}" lesson "${l.title}": Private lecture storage references must point to the configured "${PRIVATE_LECTURES_BUCKET}" bucket. Bucket "${bucket}" is rejected.`,
                  code: 'BUCKET_RESTRICTED',
                });
              }
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
