const path = require('path');
const express = require('express');
const exphbs = require('express-handlebars');
// Carregar .env explicitamente da raiz do projeto para funcionar quando startado de src/
const dotenvPath = path.join(__dirname, '..', '.env');
require('dotenv').config({ path: dotenvPath });
// Validação mínima de variáveis obrigatórias
const requiredEnv = ['PORT','SESSION_SECRET','DB_NAME','DB_USER','DB_HOST','DB_PORT'];
const missing = requiredEnv.filter(k => !process.env[k] || String(process.env[k]).trim() === '');
if (missing.length) {
  throw new Error(`Variáveis de ambiente obrigatórias ausentes: ${missing.join(', ')}`);
}

const routes = require('./routes');
const { initDb, sequelize } = require('./models');
const session = require('express-session');
const SequelizeStore = require('connect-session-sequelize')(session.Store);

// Compressão gzip/brotli de respostas (CSS/HTML/JS/SVG podem ficar 60%+ menores)
// Muito importante para mobile 4G/3G onde banda é menor.
let compression;
try {
  compression = require('compression');
} catch (_) { compression = null; }
const fs = require('fs');
const crypto = require('crypto');

function computeAssetVersion(assetPath) {
  try {
    const absolute = assetPath.startsWith('/')
      ? path.join(__dirname, '..', assetPath)
      : assetPath;
    if (!fs.existsSync(absolute)) return Date.now().toString(36);
    const stat = fs.statSync(absolute);
    const raw = fs.readFileSync(absolute);
    const hash = crypto.createHash('sha1');
    hash.update(raw);
    const hex = hash.digest('hex').slice(0, 10);
    return `${stat.mtime.getTime().toString(36)}-${hex}`;
  } catch (e) {
    return Date.now().toString(36);
  }
}
const isDev = String(process.env.NODE_ENV || 'development').toLowerCase().startsWith('dev');
const _assetCache = new Map();
function assetVersion(assetPath) {
  if (isDev) {
    return computeAssetVersion(assetPath);
  }
  if (_assetCache.has(assetPath)) return _assetCache.get(assetPath);
  const v = computeAssetVersion(assetPath);
  _assetCache.set(assetPath, v);
  return v;
}
function assetUrl(assetPath) {
  if (!assetPath) return '';
  const clean = String(assetPath).trim();
  if (!clean || clean.startsWith('http://') || clean.startsWith('https://') || clean.startsWith('//') || clean.startsWith('data:')) return clean;
  const sep = clean.includes('?') ? '&' : '?';
  const base = clean.startsWith('/') ? clean : `/${clean}`;
  const ver = assetVersion(clean.replace(/^\/+/, ''));
  return `${base}${sep}v=${ver}`;
}

// Initialize Express
const app = express();

if (compression) {
  app.use(compression({
    threshold: 1024,          // comprime só acima de 1KB (evita overhead)
    level: process.env.NODE_ENV === 'production' ? 9 : 6,
    brotli: { enabled: true, quality: 5, lgwin: 22 }, // brotli + rápido
    filter: (req, res) => {
      if (req.headers['x-no-compression']) return false;
      return compression.filter(req, res);
    }
  }));
}

// Static files com cache agressivo para recursos imutáveis (imagens, CSS, JS, fontes)
const oneYear = 60 * 60 * 24 * 365 * 1000;
const staticDir = path.join(__dirname, '..', 'public');
app.use('/public', express.static(staticDir, {
  maxAge: oneYear,
  immutable: true,
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath, stat) => {
    const ext = path.extname(filePath).toLowerCase();
    if (isDev) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      return;
    }
    if (['.webp', '.jpg', '.jpeg', '.png', '.gif', '.svg', '.mp4', '.webm', '.woff2', '.woff', '.ttf', '.otf'].includes(ext)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (['.css', '.js', '.json'].includes(ext)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
    }
  }
}));
// Fallback leve: 500KB por arquivo para compressão automática (se rodar sob proxy com gzip/brotli)
app.use('/public', (req, res, next) => {
  res.setHeader('Accept-Ranges', 'bytes');
  next();
});

// Cache bust middleware: se NODE_ENV = dev → forçar NO-STORE em HTML 
app.use((req, res, next) => {
  res.setHeader('Vary', 'Accept-Encoding, User-Agent');
  if (isDev) {
    const isHtml = !req.path.includes('.') || req.path.endsWith('.html') || req.path.endsWith('.htm');
    if (isHtml || req.path === '/' || req.path.startsWith('/inscricao') || req.path.startsWith('/admin') || req.path.startsWith('/home')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, post-check=0, pre-check=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
  next();
});

// Handlebars setup
app.engine(
  'handlebars',
  exphbs.engine({
    defaultLayout: 'main',
    layoutsDir: path.join(__dirname, '..', 'views', 'layouts'),
    partialsDir: path.join(__dirname, '..', 'views', 'partials'),
    helpers: {
      eq: (a, b) => a === b,
      formatDateBR: (val) => {
        if (!val) return '';
        const s = String(val).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
          const [y, m, d] = s.split('-');
          return `${d}/${m}/${y}`;
        }
        if (typeof val.toISOString === 'function') {
          const y = val.getFullYear();
          const m = String(val.getMonth() + 1).padStart(2, '0');
          const d = String(val.getDate()).padStart(2, '0');
          return `${d}/${m}/${y}`;
        }
        return s;
      },
      isImage: (type, filePath, mimeType, originalName) => {
        const t = (type || '').toString().toLowerCase();
        if (t === 'image') return true;
        if (mimeType && mimeType.startsWith('image/')) return true;
        const extPath = (filePath || '').split('.').pop()?.toLowerCase() || '';
        const extName = (originalName || '').split('.').pop()?.toLowerCase() || '';
        const ext = extPath || extName;
        return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg', 'bmp', 'tif', 'tiff', 'jfif'].includes(ext);
      },
      isVideo: (type, filePath, mimeType, originalName) => {
        const t = (type || '').toString().toLowerCase();
        if (t === 'video') return true;
        if (mimeType && mimeType.startsWith('video/')) return true;
        const extPath = (filePath || '').split('.').pop()?.toLowerCase() || '';
        const extName = (originalName || '').split('.').pop()?.toLowerCase() || '';
        const ext = extPath || extName;
        return ['mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv', '3gp', 'wmv', 'mpeg', 'mpg', 'ogv'].includes(ext);
      },
      mediaUrl: (filePath, id) => {
        if (filePath) {
          const safePath = filePath.replace(/\\\\/g, '/');
          return `/public/${safePath}`;
        }
        return `/media/gallery/${id}`;
      },
      asset: (assetPath) => {
        try { return assetUrl(assetPath); } catch (_) { return assetPath || ''; }
      },
    },
  })
);
app.set('view engine', 'handlebars');
app.set('views', path.join(__dirname, '..', 'views'));

// Body parsing
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.json({ limit: '20mb' }));
// Trust proxy e cookies configuráveis por ambiente
const trustProxy = String(process.env.TRUST_PROXY || '').toLowerCase();
if (trustProxy === '1' || trustProxy === 'true') app.set('trust proxy', 1);
// Session (deve vir antes de qualquer uso de req.session)
// Auto-detecção: Secure=true SOMENTE se NODE_ENV for production E variável explícita SESSION_COOKIE_SECURE='true'
const envSecureRaw = String(process.env.SESSION_COOKIE_SECURE || '').toLowerCase();
const forceSecure = envSecureRaw === 'true' || envSecureRaw === '1';
const isProd = String(process.env.NODE_ENV || '').toLowerCase().startsWith('prod');
const cookieSecure = isProd && forceSecure;
// Mesmo se SESSION_COOKIE_SAMESITE='true' (bool) é inválido. Deve ser 'lax|strict|none'.
const sameSiteRaw = String(process.env.SESSION_COOKIE_SAMESITE || '').trim();
let cookieSameSite;
if (/^(lax|strict|none)$/i.test(sameSiteRaw)) {
  cookieSameSite = sameSiteRaw.toLowerCase();
} else if (sameSiteRaw === '' || sameSiteRaw === 'true' || sameSiteRaw === 'false') {
  cookieSameSite = cookieSecure ? 'none' : 'lax';
} else {
  cookieSameSite = cookieSecure ? 'none' : 'lax';
}
console.log('[Sessão] cookie.secure =', cookieSecure, '| cookie.sameSite =', cookieSameSite, '| NODE_ENV =', process.env.NODE_ENV);
// Store de sessão persistente via Sequelize
const sessionStore = new SequelizeStore({ db: sequelize, checkExpirationInterval: 15 * 60 * 1000, expiration: 24 * 60 * 60 * 1000, disableTouch: true });
// Sincroniza tabela de sessões, se necessário
try { sessionStore.sync(); } catch (_) {}
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    secure: cookieSecure,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    ...(cookieSameSite ? { sameSite: cookieSameSite } : {}),
  },
  rolling: false,
}));

// Logar o store de sessão ativo para diagnosticar ambiente de produção
try {
  // SequelizeStore.name geralmente é 'SequelizeStore'
  // Isso ajuda a confirmar se não estamos caindo no MemoryStore
  const storeName = sessionStore?.constructor?.name || 'unknown';
  console.log('Session store ativo:', storeName);
} catch (_) {}

// Active nav para header + caminho atual para lógica de menu
app.use((req, res, next) => {
  res.locals.activeNav = req.path.startsWith('/admin')
    ? 'admin'
    : req.path.startsWith('/inscricao')
      ? 'inscricao'
      : 'home';
  res.locals.currentPath = req.path;
  next();
});

// Expor admin no template (agora após sessão)
app.use((req, res, next) => {
  res.locals.admin = req.session?.admin || null;
  const flash = req.session?.flash || null;
  res.locals.flash = flash;
  if (flash && req.session) req.session.flash = null;
  next();
});

// Locals
app.use((req, res, next) => {
  const defaultWaGroup = 'https://chat.whatsapp.com/Fqszt7Xtrcj0ragXsl9h1K?s=cl&p=i&mlu=4&amv=0';
  const whatsappGroupUrl = String(process.env.WHATSAPP_GROUP_URL || defaultWaGroup).trim();
  res.locals.whatsappGroupUrl = whatsappGroupUrl;
  res.locals.year = new Date().getFullYear();
  res.locals.footer = {
    brandTitle: process.env.SITE_TITLE,
    tagline: process.env.FOOTER_TAGLINE,
    contactEmail: process.env.CONTACT_EMAIL,
    contactPhone: process.env.CONTACT_PHONE,
    contactPhones: String(process.env.CONTACT_PHONES || process.env.CONTACT_PHONE || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    contactPhonesMeta: String(process.env.CONTACT_PHONES || process.env.CONTACT_PHONE || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => {
        const digits = s.replace(/\D/g, '');
        const wa = digits.startsWith('55') ? digits : ('55' + digits);
        return { display: s, wa };
      }),
    whatsappText: process.env.WHATSAPP_TEXT,
    whatsappTextEncoded: encodeURIComponent(process.env.WHATSAPP_TEXT ),
    whatsappGroupUrl,
    socialFacebook: process.env.SOCIAL_FACEBOOK,
    socialInstagram: process.env.SOCIAL_INSTAGRAM,
    socialTwitter: process.env.SOCIAL_TWITTER,
  };
  next();
});

app.use('/', routes);

app.use((req, res) => {
  res.status(404).render('not_found', { pageTitle: 'Página não encontrada' });
});
const PORT = Number(process.env.PORT);

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
  });
});
