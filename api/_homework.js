/**
 * Trendz Tracker — Server-Authoritative Homework Validation Helper (api/_homework.js)
 *
 * Validates homework assignments for practice endpoints (Basics, Elements, Memoriad, Flash):
 * - Confirms assignment exists and matches the requested activity_type and category/drill/module
 * - Validates that caller is an active authorized recipient
 * - Freezes assigned settings (duration, workload, etc.) to prevent client spoofing
 * - Returns authoritative HTTP error codes (400, 401, 403, 404, 500)
 */

export async function resolveAndValidateHomework(
  adminSupabase,
  homeworkId,
  student,
  expectedActivityType = null,
  expectedKeyOrCat = null
) {
  if (homeworkId === null || homeworkId === undefined) {
    return { ok: true, homework: null };
  }

  if (typeof homeworkId !== 'string' || !homeworkId.trim()) {
    return {
      ok: false,
      statusCode: 400,
      error: 'Invalid homework ID: must be a non-empty string.',
    };
  }

  const cleanId = homeworkId.trim();
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(cleanId)) {
    return {
      ok: false,
      statusCode: 400,
      error: 'Invalid homework ID format.',
    };
  }

  if (!student || !student.id) {
    return {
      ok: false,
      statusCode: 401,
      error: 'Student authentication required to validate assigned homework.',
    };
  }

  try {
    const { data: hw, error: dbErr } = await adminSupabase
      .from('homework_assignments')
      .select('*')
      .eq('id', cleanId)
      .maybeSingle();

    if (dbErr) {
      return {
        ok: false,
        statusCode: 500,
        error: 'Database error looking up assigned homework.',
      };
    }

    if (!hw) {
      return {
        ok: false,
        statusCode: 404,
        error: 'Assigned homework not found.',
      };
    }

    // Normalize activity_type for elements / element
    const normHwAct = hw.activity_type === 'elements' ? 'element' : hw.activity_type;
    const normExpAct = expectedActivityType === 'elements' ? 'element' : expectedActivityType;

    if (normExpAct && normHwAct !== normExpAct) {
      return {
        ok: false,
        statusCode: 400,
        error: `Homework activity type mismatch (expected ${hw.activity_type}, requested ${expectedActivityType}).`,
      };
    }

    // Specific workload / key checks
    if (normExpAct === 'basics' && hw.category_id && expectedKeyOrCat) {
      if (hw.category_id !== expectedKeyOrCat) {
        return {
          ok: false,
          statusCode: 400,
          error: 'Practice session category does not match assigned homework category.',
        };
      }
    } else if (normExpAct === 'element' && hw.settings?.drill && expectedKeyOrCat) {
      if (hw.settings.drill !== expectedKeyOrCat) {
        return {
          ok: false,
          statusCode: 400,
          error: 'Elements drill type does not match assigned homework.',
        };
      }
    } else if (normExpAct === 'memoriad' && hw.settings?.module && expectedKeyOrCat) {
      if (hw.settings.module !== expectedKeyOrCat) {
        return {
          ok: false,
          statusCode: 400,
          error: 'Memoriad module does not match assigned homework.',
        };
      }
    }

    // Recipient validation via authoritative RPC: strictly fail closed without authorization-broadening fallback
    let isRecipient = false;
    try {
      const { data: rpcVal, error: rpcErr } = await adminSupabase.rpc(
        'is_student_homework_recipient',
        {
          p_assignment_id: cleanId,
          p_student_id: student.id,
        }
      );
      if (rpcErr) {
        return {
          ok: false,
          statusCode: 500,
          error: 'Database error validating homework recipient.',
        };
      }
      if (typeof rpcVal !== 'boolean') {
        return {
          ok: false,
          statusCode: 500,
          error: 'Malformed response validating homework recipient.',
        };
      }
      isRecipient = rpcVal;
    } catch (rpcCatchErr) {
      return {
        ok: false,
        statusCode: 500,
        error: rpcCatchErr?.message || 'Unexpected error validating homework recipient.',
      };
    }

    if (!isRecipient) {
      return {
        ok: false,
        statusCode: 403,
        error: 'Access denied: You are not an authorized recipient of this homework assignment.',
      };
    }

    return {
      ok: true,
      homework: hw,
    };
  } catch (err) {
    return {
      ok: false,
      statusCode: 500,
      error: err.message || 'Unexpected error validating assigned homework.',
    };
  }
}
