const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');

// Load environment variables manually if executed standalone
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const delimiterIndex = trimmed.indexOf('=');
    if (delimiterIndex === -1) return;
    const key = trimmed.slice(0, delimiterIndex).trim();
    const val = trimmed.slice(delimiterIndex + 1).trim().replace(/(^"|"$|^'|'$)/g, '');
    if (key && process.env[key] === undefined) {
      process.env[key] = val;
    }
  });
}

const DEFAULT_LISTING = {
  appName: 'iStore',
  developer: 'iStore',
  category: 'Shopping',
  shortDescription: 'Bring the iStore shopping experience to you.',
  description: "Bring the iStore shopping experience to you. Shop the biggest range of Apple products and widest range of specially curated accessories and Smart products, making the most of iStore's delivery and store pick up options for your ultimate convenience.\n\nApp features:\n• Free delivery and in-store Pick up across South Africa\n• Fast delivery and in-store Pick up from 1 hour from placing your order\n• Choose delivery days that suit you\n• Pre-order the latest products before they are available in-store\n• Build a wish list with Save for later\n• Manage your orders from your profile\n• More coming soon\n\nWhy iStore?\niStore is an Apple Premium Partner, which launched its first store in 2005. With a wealth of Apple product experience, iStore offers best in class retail experience both online and in-store.",
  rating: 4.1,
  reviews: '277',
  downloads: '1L+',
  ageRating: '3+',
  icon: '/istore/logo.jpg',
  screenshots: [
    '/istore/1.jpg',
    '/istore/2.jpg',
    '/istore/3.jpg',
    '/istore/4.jpg',
    '/istore/5.jpg',
    '/istore/6.jpg',
    '/istore/7.jpg'
  ],
  publicUrl: '',
  downloadCount: 100000
};

/**
 * Resolves APK file or base64 buffer from memory cache or disk storage.
 */
function getApkFromMemoryOrDisk({ slug = 'primary', latestApkCache = {}, dataDir }) {
  // 1. Check in-memory cache for requested slug
  if (latestApkCache && latestApkCache[slug] && latestApkCache[slug].data) {
    return {
      buffer: Buffer.from(latestApkCache[slug].data, 'base64'),
      filename: latestApkCache[slug].filename || 'istore.apk',
      version: latestApkCache[slug].version,
      notes: latestApkCache[slug].notes,
      uploadedAt: latestApkCache[slug].uploadedAt,
      uploadedBy: latestApkCache[slug].uploadedBy
    };
  }

  // 2. Check disk for specific slug
  if (dataDir && fs.existsSync(dataDir)) {
    const rawPath = path.join(dataDir, `latest_apk_${slug}.apk`);
    if (fs.existsSync(rawPath)) {
      return { path: rawPath, filename: 'istore.apk' };
    }
    const jsonPath = path.join(dataDir, `latest_apk_${slug}.json`);
    if (fs.existsSync(jsonPath)) {
      try {
        const content = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        if (content && content.data && typeof content.data === 'string' && content.data.length > 0) {
          const buf = Buffer.from(content.data, 'base64');
          if (buf.length >= 78) {
            return {
              buffer: buf,
              filename: content.filename || 'istore.apk',
              version: content.version,
              notes: content.notes,
              uploadedAt: content.uploadedAt,
              uploadedBy: content.uploadedBy
            };
          }
        }
      } catch {}
    }

    // 3. Fallback: check any slug in latestApkCache
    if (latestApkCache) {
      for (const k of Object.keys(latestApkCache)) {
        if (latestApkCache[k] && latestApkCache[k].data) {
          return {
            buffer: Buffer.from(latestApkCache[k].data, 'base64'),
            filename: latestApkCache[k].filename || 'istore.apk',
            version: latestApkCache[k].version,
            notes: latestApkCache[k].notes,
            uploadedAt: latestApkCache[k].uploadedAt,
            uploadedBy: latestApkCache[k].uploadedBy
          };
        }
      }
    }

    // 4. Fallback: check any latest_apk_*.apk or latest_apk_*.json on disk
    try {
      const files = fs.readdirSync(dataDir);
      const apk = files.find((f) => f.startsWith('latest_apk_') && f.endsWith('.apk'));
      if (apk) {
        return { path: path.join(dataDir, apk), filename: 'istore.apk' };
      }
      const json = files.find((f) => f.startsWith('latest_apk_') && f.endsWith('.json'));
      if (json) {
        const content = JSON.parse(fs.readFileSync(path.join(dataDir, json), 'utf8'));
        if (content && content.data && typeof content.data === 'string' && content.data.length > 0) {
          const buf = Buffer.from(content.data, 'base64');
          if (buf.length >= 78) {
            return {
              buffer: buf,
              filename: content.filename || 'istore.apk',
              version: content.version,
              notes: content.notes,
              uploadedAt: content.uploadedAt,
              uploadedBy: content.uploadedBy
            };
          }
        }
      }
    } catch {}
  }

  return null;
}

/**
 * Returns formatted APK metadata for store JSON API.
 */
function resolveApkInfo(apk) {
  if (!apk) return null;
  let sizeMB = '0.0';
  if (apk.buffer) {
    sizeMB = (apk.buffer.length / 1024 / 1024).toFixed(1);
  } else if (apk.path && fs.existsSync(apk.path)) {
    try {
      sizeMB = (fs.statSync(apk.path).size / 1024 / 1024).toFixed(1);
    } catch {}
  }
  return {
    version: apk.version || 'Latest',
    notes: apk.notes || '',
    uploadedAt: apk.uploadedAt || (apk.path && fs.existsSync(apk.path) ? fs.statSync(apk.path).mtime.toLocaleString() : new Date().toLocaleString()),
    uploadedBy: apk.uploadedBy || 'Server',
    size: `${sizeMB} MB`
  };
}

/**
 * Resolves media path (defaults retain relative URLs, custom files use store-media route).
 */
function resolveMediaUrl(slug, f) {
  if (!f) return '';
  if (f.startsWith('/') || f.startsWith('http://') || f.startsWith('https://')) return f;
  return `/store-media/${encodeURIComponent(slug)}/${encodeURIComponent(f)}`;
}

/**
 * Creates the dedicated Express application that strictly serves the Play Store page.
 */
function createStoreApp({
  loadInstances,
  saveInstances,
  latestApkCache = {},
  dataDir = path.join(__dirname, 'data'),
  rootDir = __dirname
} = {}) {
  const app = express();

  // Helper to read instances safely
  const getInstancesList = () => {
    if (typeof loadInstances === 'function') {
      try { return loadInstances() || []; } catch { return []; }
    }
    const instPath = path.join(dataDir, 'instances.json');
    if (fs.existsSync(instPath)) {
      try { return JSON.parse(fs.readFileSync(instPath, 'utf8')) || []; } catch { return []; }
    }
    return [];
  };

  // Helper to find instance by slug or fallback to first
  const findInstance = (slug) => {
    const list = getInstancesList();
    if (!Array.isArray(list) || list.length === 0) return null;
    if (slug) {
      const match = list.find((i) => i.slug && i.slug.toLowerCase() === slug.toLowerCase());
      if (match) return match;
    }
    return list.find((i) => i.slug === 'primary') || list[0] || null;
  };

  // Helper to record download count
  const incrementDownloadCount = (slug) => {
    try {
      const list = getInstancesList();
      const inst = list.find((i) => i.slug && i.slug.toLowerCase() === slug.toLowerCase()) || list[0];
      if (inst) {
        if (!inst.storeListing) inst.storeListing = Object.assign({}, DEFAULT_LISTING);
        inst.storeListing.downloadCount = (inst.storeListing.downloadCount || 0) + 1;
        if (typeof saveInstances === 'function') {
          saveInstances(list);
        } else {
          const instPath = path.join(dataDir, 'instances.json');
          fs.writeFileSync(instPath, JSON.stringify(list, null, 2), 'utf8');
        }
      }
    } catch (err) {
      console.error('[STORE] Failed to increment download count:', err.message);
    }
  };

  // Security headers
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-XSS-Protection': '1; mode=block'
    });
    next();
  });

  // Request logger
  app.use((req, res, next) => {
    console.log(`[PLAYSTORE] ${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
  });

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({ status: 'healthy', service: 'playstore', timestamp: new Date().toISOString() });
  });

  // Serve static store images (/istore/*.jpg) strictly - never exposes dashboard assets
  app.use('/istore', express.static(path.join(rootDir, 'public', 'istore'), { index: false }));

  // Serve custom store media uploaded via dashboard
  app.get('/store-media/:slug/:file', (req, res) => {
    const file = path.basename(req.params.file);
    const mediaPath = path.join(dataDir, 'store_media', req.params.slug.toLowerCase(), file);
    if (!fs.existsSync(mediaPath)) return res.status(404).end();
    res.sendFile(mediaPath);
  });

  // Dynamic store listing metadata API for front-end store.html
  app.get(['/api/public/store', '/api/public/store/:slug'], (req, res) => {
    const slug = (req.params.slug || 'primary').toLowerCase();
    const inst = findInstance(slug);
    const listing = Object.assign({}, DEFAULT_LISTING, (inst && inst.storeListing) || {});
    const activeSlug = (inst && inst.slug) || slug;
    const apk = getApkFromMemoryOrDisk({ slug: activeSlug, latestApkCache, dataDir });

    res.json({
      appName: listing.appName || DEFAULT_LISTING.appName,
      developer: listing.developer || DEFAULT_LISTING.developer,
      category: listing.category || DEFAULT_LISTING.category,
      shortDescription: listing.shortDescription || DEFAULT_LISTING.shortDescription,
      description: listing.description || DEFAULT_LISTING.description,
      rating: listing.rating !== undefined ? listing.rating : DEFAULT_LISTING.rating,
      reviews: listing.reviews || DEFAULT_LISTING.reviews,
      downloads: listing.downloads || DEFAULT_LISTING.downloads,
      ageRating: listing.ageRating || DEFAULT_LISTING.ageRating,
      icon: resolveMediaUrl(activeSlug, listing.icon || DEFAULT_LISTING.icon),
      screenshots: (listing.screenshots && listing.screenshots.length ? listing.screenshots : DEFAULT_LISTING.screenshots).map((s) => resolveMediaUrl(activeSlug, s)),
      apk: resolveApkInfo(apk),
      downloadUrl: `/app/${encodeURIComponent(activeSlug)}/download`
    });
  });

  // APK file download endpoints
  app.get(['/app/:slug/download', '/download', '/apk', '/get-apk', '/app.apk', '/istore.apk'], (req, res) => {
    const slug = (req.params.slug || 'primary').toLowerCase();
    const apk = getApkFromMemoryOrDisk({ slug, latestApkCache, dataDir });

    if (!apk) {
      return res.status(404).send('No APK package available yet. Please upload an APK first.');
    }

    incrementDownloadCount(slug);

    if (apk.buffer) {
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', `attachment; filename="${apk.filename || 'istore.apk'}"`);
      res.setHeader('Content-Length', apk.buffer.length);
      return res.send(apk.buffer);
    }

    if (apk.path && fs.existsSync(apk.path)) {
      return res.download(apk.path, apk.filename || 'istore.apk', (err) => {
        if (err && !res.headersSent) res.status(500).send('Error downloading APK package');
      });
    }

    res.status(404).send('APK file not found on disk.');
  });

  // All other GET routes unconditionally serve the Google Play Store page
  app.get('*', (req, res) => {
    const storeHtmlPath = path.join(rootDir, 'public', 'store.html');
    if (fs.existsSync(storeHtmlPath)) {
      return res.sendFile(storeHtmlPath);
    }
    res.status(404).send('Play Store page template (public/store.html) not found.');
  });

  return app;
}

/**
 * Starts the standalone HTTP server on the designated Play Store port.
 */
function startStoreServer({
  port = Number(process.env.STORE_PORT || process.env.PLAYSTORE_PORT || 3002),
  loadInstances,
  saveInstances,
  latestApkCache = {},
  dataDir = path.join(__dirname, 'data'),
  rootDir = __dirname
} = {}) {
  const app = createStoreApp({ loadInstances, saveInstances, latestApkCache, dataDir, rootDir });
  const server = http.createServer(app);
  let closeTimer = null;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`\n⚠️  [WARN] Play Store Portal: Port ${port} is already in use.`);
      console.warn(`   Configure STORE_PORT in .env to choose a different port.\n`);
    } else {
      console.error('[SYSTEM] Play Store Portal server error:', err.message);
    }
  });

  server.listen(port, () => {
    console.log(`📱 Dedicated Play Store Portal: http://localhost:${port} -> Shows Play Store page only`);
  });

  const shutdown = () => {
    if (closeTimer) return;
    closeTimer = setTimeout(() => {
      console.error('[STORE] Force-closing server after shutdown timeout.');
      server.close();
    }, 5000).unref();
    server.close((err) => {
      if (!err) console.log('[STORE] Server closed.');
      else console.error('[STORE] Error closing server:', err.message);
    });
  };

  if (!process._storeServerShutdown) {
    process._storeServerShutdown = true;
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }

  return {
    app,
    server,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
    })
  };
}

if (require.main === module) {
  const port = Number(process.env.STORE_PORT || process.env.PLAYSTORE_PORT || 3002);
  startStoreServer({ port });
}

module.exports = {
  DEFAULT_LISTING,
  getApkFromMemoryOrDisk,
  resolveApkInfo,
  resolveMediaUrl,
  createStoreApp,
  startStoreServer
};

