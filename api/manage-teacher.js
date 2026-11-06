/**
 * Vercel Serverless Function: /api/manage-teacher
 * Unified administrative endpoint for teacher management:
 * - create / create_teacher: creates Auth user and initializes database profile/permissions/assignments atomically
 * - update_assignments: atomically validates, replaces assignments, and logs assign_students
 * - update_permissions: atomically updates permissions and logs update_permissions
 * - set_active: atomically toggles active state and logs activate/deactivate
 * - reset_password: administrative password reset with audit logging
 * - get_audit_log: returns activity logs for a teacher
 * - get_teacher_details: returns profile, permissions, and assigned students
 *
 * Verifies caller is an authenticated active administrator first.
 * Combined endpoint adhering to Vercel Hobby plan Serverless Function deployment limits (<= 12 functions).
 */

import { teacherEndpointHandler, createTeacherHandler } from './_teacherAdmin.js';

export default teacherEndpointHandler;
export { createTeacherHandler, teacherEndpointHandler as manageTeacherHandler };
