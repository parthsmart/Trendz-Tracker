# Homework and Highest Records production rollout

The source SQL was exercised on dedicated staging as migration `20261121120135`. The release bundle reuses those feature definitions with a production prerequisite check and verifies that homework session links are accessible only to the server.

1. Confirm the target in Supabase before opening an editor or migration connection. Production is `kgzivhavpsvitwrscrrj`. Dedicated staging is `xhgzbbkvwojwfbexvcmh`. The database name `postgres` is shared, so it cannot verify the target.
2. Review the exact release commit and take a private recovery snapshot. Save the existing definitions, owners, and grants for `flash_start(jsonb)`, both expected Main Round creation signatures if present, `admin_send_student_message(uuid,text,text,boolean,text,text,uuid,text)`, and `format_leaderboard_name(text,text,text)` if present. Record the streak and Daily To-Do function hashes for comparison. Keep all database snapshots and Main Round answer payloads in private storage.
3. Run `node scripts/buildHomeworkReleaseSql.js` from the release checkout and review its output. It generates one transaction. The staging files keep their staging guards and cannot serve as the production package.
4. Once the production apply is approved, prepend the following statement to the generated SQL and submit the complete batch on the confirmed production connection. The statement is an operator confirmation. It does not identify the connected project on its own.

   ```sql
   SET app.target_environment = 'production_kgzivhavpsvitwrscrrj';
   ```

5. Verify the committed schema before promoting the app. Check that both Main Round signatures resolve, the homework binding routine and its link table are server-only, and `practice_highest_records(text,jsonb)` is available to signed-in accounts. Compare the streak and Daily To-Do function hashes to the pre-apply snapshot. Refresh the API schema cache if the new signature or tables are not visible yet.
6. After the app promotion, smoke-test an approved disposable account. Cover ordinary Main Round, homework creation and one-time credit, a Basics record, an Entered Today row, and a linked private message. Confirm the private backup endpoint includes homework links before relying on it for recovery.

## Backup and restore

The admin-only `private_jmcwc_backup` response includes `homework_bound_sessions`. Keep the file private. It contains Main Round data and the links needed to retry or award credit after restoring.

Restore profiles, assignments, and the referenced drill sessions or Main Round attempts before restoring the links. For a complete recovery, retain the database snapshot for drill sessions and the rest of the app data alongside the private Main Round export. Preserve each link's `id`, `assignment_id`, `student_id`, and `session_id`. Confirm that a restored Main Round homework attempt can retry against its original assignment.

## Rollback

If the SQL batch fails, its transaction rolls back. Inspect the prerequisite or permission error and recheck the schema before retrying.

If the app must be rolled back after the migration commits, switch back to the last known working app deployment and keep the new homework tables and rows. The six-argument Main Round function remains available. If the fault is in a replaced database routine, restore its captured definition, owner, and grants in a reviewed transaction. Preserve the stored homework links and data so a later release can resume them.
