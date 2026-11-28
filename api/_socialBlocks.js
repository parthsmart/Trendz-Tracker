/**
 * Student blocks for the duel routes (underscore file: not a Vercel function).
 *
 * A block (public.student_blocks, see the social migration) works both ways
 * and is silent: the blocked student only ever sees "not available". If the
 * table does not exist yet (code deployed before the migration), nothing is
 * blocked, so duels keep working.
 */

/** Ids of students who blocked, or were blocked by, studentId. */
export async function blockedIdsFor(db, studentId) {
  if (!studentId) return new Set();
  try {
    const { data, error } = await db
      .from('student_blocks')
      .select('blocker_id, blocked_id')
      .or(`blocker_id.eq.${studentId},blocked_id.eq.${studentId}`);
    if (error || !Array.isArray(data)) return new Set();
    return new Set(data.map((r) => (r.blocker_id === studentId ? r.blocked_id : r.blocker_id)));
  } catch {
    return new Set();
  }
}

export async function isBlockedPair(db, a, b) {
  if (!a || !b) return false;
  return (await blockedIdsFor(db, a)).has(b);
}
