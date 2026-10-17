import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(() => {
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
          categories: path.resolve(__dirname, 'pages/categories.html'),
          rounds: path.resolve(__dirname, 'pages/rounds.html'),
          todos: path.resolve(__dirname, 'pages/todos.html'),
          resources: path.resolve(__dirname, 'pages/resources.html'),
        },
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
