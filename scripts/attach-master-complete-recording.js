import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envLocal = dotenv.parse(fs.readFileSync(path.resolve(__dirname, '../.env.staging.local')));

const accountsData = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../work/private/phase18-staging-accounts.json'), 'utf8')
);
const adminAcc = accountsData.accounts.find((a) => a.login === 'STG-ADM');

const LIVE_CLASS_ID = '70407538-598c-41fd-9081-c300e92c4567';
const WEBINAR_ID = 'cmvl53hcc0bycs60yjljyys4z';
const PRESERVED_STORAGE_PATH = `storage://recordings/webinars/${WEBINAR_ID}/master-complete.mp4`;

async function getJwt(email, password) {
  const res = await fetch(`${envLocal.STAGING_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'apikey': envLocal.STAGING_SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.msg || 'Auth failed');
  return data.access_token;
}

async function main() {
  console.log('Attaching preserved complete recording to staging live class...');
  console.log('Signing in as Admin:', adminAcc.email);
  const adminToken = await getJwt(adminAcc.email, adminAcc.password);

  // Call attach_recording via API
  const attachRes = await fetch('http://localhost:3000/api/live-class', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      action: 'attach_recording',
      classId: LIVE_CLASS_ID,
      title: 'Disposable Class Recording (Preserved 13:02 Master)',
      recordingUrl: PRESERVED_STORAGE_PATH,
      durationSeconds: 782,
    }),
  });

  const attachJson = await attachRes.json();
  console.log('Attach Response Status:', attachRes.status);
  console.log('Attach Response Body:  ', JSON.stringify(attachJson));
  if (!attachRes.ok || (!attachJson.success && !attachJson.ok)) {
    throw new Error(`Failed to attach recording: ${JSON.stringify(attachJson)}`);
  }

  // Call get_recording_playback to verify dynamic signed URL resolution
  const playRes = await fetch('http://localhost:3000/api/live-class', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      action: 'get_recording_playback',
      recordingId: attachJson.recording.id,
    }),
  });

  const playJson = await playRes.json();
  const resolvedUrl = playJson.recording?.playbackUrl || playJson.playbackUrl;
  console.log('\nPlayback Response Status:', playRes.status);
  console.log('Playback Data:          ', JSON.stringify({
    ok: playJson.ok,
    title: playJson.recording?.title,
    durationSeconds: playJson.recording?.durationSeconds,
    resolvedFrom: resolvedUrl ? resolvedUrl.split('?')[0] : null,
    hasToken: Boolean(resolvedUrl && resolvedUrl.includes('token=')),
  }));

  if (!resolvedUrl) {
    throw new Error(`Failed to resolve playback URL: ${JSON.stringify(playJson)}`);
  }

  console.log('\n✓ Successfully attached and resolved complete master recording:');
  console.log('  Recording URL:   ', PRESERVED_STORAGE_PATH);
  console.log('  Signed Endpoint: ', resolvedUrl.slice(0, 85) + '...[TOKEN REDACTED]');
}

main().catch((err) => {
  console.error('❌ Attachment failed:', err);
  process.exit(1);
});
