/**
 * Phase 18 — Staging Isolation & Configuration Tests
 * (tests/phase18_staging_isolation.test.js)
 *
 * Verifies:
 * 1. validateStagingIsolation rejects missing frontend/backend URLs.
 * 2. validateStagingIsolation rejects mismatched frontend/backend URLs.
 * 3. validateStagingIsolation rejects live Mumbai production project (kgzivhavpsvitwrscrrj).
 * 4. validateStagingIsolation approves valid isolated staging project.
 * 5. /api/config returns only supabaseUrl and supabaseAnonKey, NEVER exposing serviceRoleKey.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  validateStagingIsolation,
  PRODUCTION_PROJECT_REF,
  APPROVED_STAGING_PROJECT_REF,
  getSupabaseServerConfig,
} from '../api/_configHelper.js';

describe('Phase 18 — Staging Isolation Verification', () => {
  it('1. Rejects missing frontend or backend URL', () => {
    assert.throws(
      () => validateStagingIsolation({ VITE_SUPABASE_URL: '' }),
      /Both VITE_SUPABASE_URL and SUPABASE_URL must be configured/
    );
    assert.throws(
      () => validateStagingIsolation({ VITE_SUPABASE_URL: 'https://staging.supabase.co', SUPABASE_URL: '' }),
      /Both VITE_SUPABASE_URL and SUPABASE_URL must be configured/
    );
  });

  it('2. Rejects mismatched frontend and backend URLs', () => {
    assert.throws(
      () =>
        validateStagingIsolation({
          VITE_SUPABASE_URL: 'https://frontend-staging.supabase.co',
          SUPABASE_URL: 'https://backend-staging.supabase.co',
        }),
      /Frontend URL .* and Backend URL .* do not match/
    );
  });

  it('3. Rejects live Mumbai production project kgzivhavpsvitwrscrrj', () => {
    assert.throws(
      () =>
        validateStagingIsolation({
          VITE_SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
          SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
        }),
      /FATAL: Staging preview cannot connect to live Mumbai production project/
    );
  });

  it('4. Approves dedicated staging project xhgzbbkvwojwfbexvcmh', () => {
    const res = validateStagingIsolation({
      VITE_SUPABASE_URL: `https://${APPROVED_STAGING_PROJECT_REF}.supabase.co`,
      SUPABASE_URL: `https://${APPROVED_STAGING_PROJECT_REF}.supabase.co`,
    });
    assert.equal(res.isIsolated, true);
    assert.equal(res.url, `https://${APPROVED_STAGING_PROJECT_REF}.supabase.co`);
  });

  it('5. getSupabaseServerConfig never exposes service-role key', () => {
    const config = getSupabaseServerConfig({
      VITE_SUPABASE_URL: `https://${APPROVED_STAGING_PROJECT_REF}.supabase.co`,
      VITE_SUPABASE_ANON_KEY: 'test-anon-key',
      SUPABASE_URL: `https://${APPROVED_STAGING_PROJECT_REF}.supabase.co`,
      SUPABASE_ANON_KEY: 'test-anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'super-secret-service-role-key',
    });

    assert.equal(config.url, `https://${APPROVED_STAGING_PROJECT_REF}.supabase.co`);
    assert.equal(config.anonKey, 'test-anon-key');
    assert.equal('serviceRoleKey' in config, false);
    assert.equal(Object.keys(config).sort().join(','), 'anonKey,url');
  });
});
