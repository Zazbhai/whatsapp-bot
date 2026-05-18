const path = require('path');
const fs = require('fs');
const express = require('express');
// Load environment variables manually from .env (bulletproof, zero native dependency install risks)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const delimiterIndex = trimmed.indexOf('=');
    if (delimiterIndex === -1) return;
    const key = trimmed.slice(0, delimiterIndex).trim();
    const val = trimmed.slice(delimiterIndex + 1).trim().replace(/(^"|"$|^'|'$)/g, '');
    if (key) {
      process.env[key] = val;
    }
  });
}

const app = express();
const PORT = process.env.APK_PORT || 3005;
const dataDir = path.join(__dirname, 'data');

// Middleware to enable CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Simple Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'APK download server' });
});

// Direct download route for flipkart.apk with high performance zero-copy file streaming
app.get('/download/flipkart.apk', (req, res) => {
  const slug = req.query.instance || 'primary';
  const rawPath = path.join(dataDir, `latest_apk_${slug}.apk`);

  if (!fs.existsSync(rawPath)) {
    return res.status(404).send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>404 Not Found</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 32px; max-width: 450px; text-align: center; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.3); }
            h1 { color: #f43f5e; margin-top: 0; font-size: 1.75rem; }
            p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>APK Not Found</h1>
            <p>No application package has been cached for instance "<strong>${slug}</strong>" yet.</p>
            <p>Please upload an APK file (.apk) to an authorized WhatsApp group or dashboard session first.</p>
          </div>
        </body>
      </html>
    `);
  }

  try {
    const stat = fs.statSync(rawPath);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="flipkart.apk"');

    // Ultra high performance zero-copy memory pipe
    const readStream = fs.createReadStream(rawPath);
    readStream.on('error', (streamErr) => {
      console.error(`[APK SERVER] Error streaming file: ${streamErr.message}`);
      if (!res.headersSent) {
        res.status(500).send('Internal server error during download');
      }
    });
    readStream.pipe(res);
    
    console.log(`[APK SERVER] Successfully streamed flipkart.apk to user for instance "${slug}"`);
  } catch (err) {
    console.error(`[APK SERVER] Download route crash: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).send('Server error');
    }
  }
});

// Secondary legacy/compatibility endpoints
app.get('/download/apk', (req, res) => {
  const slug = req.query.instance || 'primary';
  res.redirect(`/download/flipkart.apk?instance=${slug}`);
});

app.get('/download/apk/:instance', (req, res) => {
  const slug = req.params.instance;
  res.redirect(`/download/flipkart.apk?instance=${slug}`);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[APK SERVER] Standalone high-performance APK download microservice running on port ${PORT}`);
  console.log(`[APK SERVER] Direct link: http://localhost:${PORT}/download/flipkart.apk`);
});
