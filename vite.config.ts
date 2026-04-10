// @ts-nocheck
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const workspaceRoot = fileURLToPath(new URL('.', import.meta.url));
const publicDemoDirectory = path.resolve(workspaceRoot, 'public', 'demo');

function sanitizeOutputFileName(fileName: unknown) {
  const baseName =
    typeof fileName === 'string' && fileName.trim().length > 0
      ? path.basename(fileName.trim())
      : 'generated-output.gcode';
  const safeName = baseName.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return safeName.toLowerCase().endsWith('.gcode') ? safeName : `${safeName}.gcode`;
}

function saveGeneratedGcodePlugin() {
  return {
    name: 'save-generated-gcode',
    configureServer(server: import('vite').ViteDevServer) {
      server.middlewares.use('/api/save-generated-gcode', async (req, res, next) => {
        if (req.method !== 'POST') {
          next();
          return;
        }

        try {
          const chunks: Buffer[] = [];

          for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }

          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            fileName?: unknown;
            content?: unknown;
          };

          if (typeof payload.content !== 'string') {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Missing G-code content.' }));
            return;
          }

          const outputFileName = sanitizeOutputFileName(payload.fileName);
          const outputPath = path.resolve(publicDemoDirectory, outputFileName);

          if (path.dirname(outputPath) !== publicDemoDirectory) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Invalid output path.' }));
            return;
          }

          await fs.mkdir(publicDemoDirectory, { recursive: true });
          await fs.writeFile(outputPath, payload.content, 'utf8');

          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              savedPath: `/demo/${outputFileName}`
            })
          );
        } catch (error) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              error:
                error instanceof Error ? error.message : 'Failed to save generated G-code.'
            })
          );
        }
      });
    }
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), saveGeneratedGcodePlugin()],
  test: {
    environment: 'node'
  }
});
