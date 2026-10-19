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
import weeklyReportHandler from './api/weekly-report.js';
import { getSupabaseServerConfig } from './api/_configHelper.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '10mb' }));

// Public config endpoint (never exposes secret keys, returns 500 if missing)
app.get('/api/config', (req, res) => {
  try {
    const { url, anonKey } = getSupabaseServerConfig();
    res.json({
      supabaseUrl: url,
      supabaseAnonKey: anonKey,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
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

app.all('/api/weekly-report', (req, res) => {
  return weeklyReportHandler(req, res);
});

async function startServer() {
  const isProduction = process.env.NODE_ENV === 'production';
  const distPath = path.join(__dirname, 'dist');

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, host: '0.0.0.0', port: PORT },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // Serve static files in production strictly rooted inside dist
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      if (req.path.endsWith('.html')) {
        return res.sendFile(req.path, { root: distPath });
      }
      res.sendFile('index.html', { root: distPath });
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
