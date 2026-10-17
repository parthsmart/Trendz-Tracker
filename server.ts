/**
 * Trendz Tracker - Local Development & Full-Stack Server
 * Serves static HTML/CSS/JS and executes /api serverless handlers locally.
 */

import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import createStudentHandler from './api/create-student.js';
import resetPasswordHandler from './api/reset-password.js';
import supabaseProxyHandler from './api/supabase-proxy.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

// Public config endpoint (never exposes secret keys)
app.get('/api/config', (req, res) => {
  const rawUrl = process.env.SUPABASE_URL || 'https://ctwjujnqxkhononxykdc.supabase.co';
  const cleanUrl = rawUrl.trim().replace(/\/rest\/v1\/?$/i, '').replace(/\/+$/, '');
  const anonKey = (process.env.SUPABASE_ANON_KEY || 'sb_publishable_jKPhD4j4mfiAlKu7ljyLbQ_iqJnvcyw').trim();
  res.json({
    supabaseUrl: cleanUrl,
    supabaseAnonKey: anonKey,
  });
});

// Mount the serverless API routes locally
app.post('/api/create-student', (req, res) => {
  return createStudentHandler(req, res);
});

app.post('/api/reset-password', (req, res) => {
  return resetPasswordHandler(req, res);
});

app.all('/api/supabase-proxy', (req, res) => {
  return supabaseProxyHandler(req, res);
});

async function startServer() {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // Serve static files in production
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Trendz Tracker running on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
