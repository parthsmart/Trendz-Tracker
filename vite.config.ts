import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(() => {
  // Enforce required build variables when deploying on Vercel
  if (process.env.VERCEL) {
    const url = process.env.VITE_SUPABASE_URL || '';
    const anonKey = process.env.VITE_SUPABASE_ANON_KEY || '';

    const isInvalidUrl = !url ||
      url.includes('YOUR_') ||
      url.includes('your-project-ref') ||
      !url.startsWith('https://');

    const isInvalidKey = !anonKey ||
      anonKey.includes('YOUR_') ||
      anonKey.length < 20;

    if (isInvalidUrl || isInvalidKey) {
      throw new Error(
        `\n[Vercel Build Error] Missing or invalid Supabase build environment variables.\n` +
        `Both VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be provided in Vercel project settings.\n` +
        `Received: VITE_SUPABASE_URL=${url ? '[PROVIDED]' : '[EMPTY]'}, VITE_SUPABASE_ANON_KEY=${anonKey ? '[PROVIDED]' : '[EMPTY]'}\n`
      );
    }
  }

  return {
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          student: path.resolve(__dirname, 'pages/student.html'),
          roundScores: path.resolve(__dirname, 'pages/round-scores.html'),
          basics: path.resolve(__dirname, 'pages/basics.html'),
          admin: path.resolve(__dirname, 'pages/admin.html'),
          students: path.resolve(__dirname, 'pages/students.html'),
          categories: path.resolve(__dirname, 'pages/categories.html'),
          rounds: path.resolve(__dirname, 'pages/rounds.html'),
          todos: path.resolve(__dirname, 'pages/todos.html'),
          resources: path.resolve(__dirname, 'pages/resources.html'),
          studentDetail: path.resolve(__dirname, 'pages/student-detail.html'),
          review: path.resolve(__dirname, 'pages/review.html'),
          attendance: path.resolve(__dirname, 'pages/attendance.html'),
        },
      },
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true as const,
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
