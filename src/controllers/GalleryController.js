const path = require('path');
const fs = require('fs');
const multer = require('multer');
const GalleryItem = require('../models/GalleryItem');

// Upload grande: usar storage em disco temporário e depois salvar no DB
const tempDir = path.join(__dirname, '..', '..', 'public', 'uploads', 'gallery');
try { if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true }); } catch (_) {}
const maxMb = Number(process.env.UPLOAD_MAX_MB);
if (!Number.isFinite(maxMb) || maxMb <= 0) {
  throw new Error('Variável de ambiente UPLOAD_MAX_MB ausente ou inválida');
}
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, tempDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `gallery_${Date.now()}${ext || ''}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype && (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/'));
    if (ok) return cb(null, true);
    cb(new Error('Arquivo deve ser imagem ou vídeo'));
  },
  limits: { fileSize: maxMb * 1024 * 1024 },
});

function isAdmin(req) {
  return !!req.session?.admin && (req.session.admin.role === 'ADMIN' || req.session.admin.role === 'DESIGN');
}

// Página pública
async function publicPage(req, res) {
  const items = await GalleryItem.findAll({
    order: [['createdAt', 'DESC']],
  });
  const normalized = items
    .map(i => classifyItem(toViewItem(i)))
    // Evita tentar carregar mídias inexistentes (sem BLOB e sem caminho em disco)
    .filter(i => !!(i?.hasData || (i?.filePath && String(i.filePath).trim() !== '')));
  try {
    console.log('Galeria pública: itens normalizados (até 10)', normalized.map(x => ({ id: x.id, type: x.type, mime: x.mimeType, name: x.originalName, filePath: x.filePath })).slice(0, 10));
  } catch (_) {}
  res.render('galeria', { items: normalized, activeNav: 'galeria' });
}
// Admin: listar e gerenciar
async function adminList(req, res) {
  if (!isAdmin(req)) return res.redirect('/admin');
  const message = req.session?.flash || null;
  if (req.session) req.session.flash = null;
  const items = await GalleryItem.findAll({ order: [['createdAt', 'DESC']] });
  const normalized = items.map(i => classifyItem(toViewItem(i)));
  try {
    console.log('Admin galeria: itens normalizados (até 20)', normalized.map(x => ({ id: x.id, type: x.type, mime: x.mimeType, name: x.originalName, filePath: x.filePath })).slice(0, 20));
  } catch (_) {}
  res.render('admin_gallery', { items: normalized, message, layout: 'main' });
}

// Admin: criar novo item com upload (capturando erros do Multer)
const adminCreate = async (req, res) => {
  if (!isAdmin(req)) return res.redirect('/admin');
  const runUpload = upload.single('media');
  runUpload(req, res, async (err) => {
    try {
      if (err) {
        const isSize = err.code === 'LIMIT_FILE_SIZE';
        const message = isSize
          ? `Arquivo excede o limite de ${maxMb}MB.`
          : (err.message || 'Erro no upload. Verifique tipo e tamanho do arquivo.');
        req.session.flash = { type: 'error', message };
        return res.redirect('/admin/galeria');
      }
      if (!req.file) {
        req.session.flash = { type: 'error', message: 'Selecione uma imagem ou vídeo.' };
        return res.redirect('/admin/galeria');
      }

      const { title, description } = req.body;
      const mime = req.file.mimetype || '';
      const ext = path.extname(req.file.originalname || '').toLowerCase() || path.extname(req.file.filename || '').toLowerCase();
      let type = null;
      if (mime.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.svg', '.bmp', '.tif', '.tiff', '.jfif'].includes(ext)) type = 'image';
      else if (mime.startsWith('video/') || ['.mp4', '.webm', '.mov', '.m4v', '.avi', '.mkv', '.3gp', '.wmv', '.mpeg', '.mpg', '.ogv'].includes(ext)) type = 'video';

      if (!type) {
        req.session.flash = { type: 'error', message: 'Arquivo inválido. Use imagem ou vídeo.' };
        return res.redirect('/admin/galeria');
      }

      // Ler arquivo do disco em buffer e salvar no DB
      const filePathAbs = req.file.path;
      const fileBuffer = await fs.promises.readFile(filePathAbs);
      const created = await GalleryItem.create({
        title: title || null,
        description: description || null,
        type,
        filePath: null,
        mimeType: req.file.mimetype,
        originalName: req.file.originalname || req.file.filename,
        data: fileBuffer,
        isPublished: true,
      });
      // Remover arquivo temporário após salvar no banco
      try { await fs.promises.unlink(filePathAbs); } catch (_) {}
      console.log('Galeria: item criado', { id: created.id, type: created.type, filePath: created.filePath });
      req.session.flash = { type: 'success', message: 'Item adicionado à galeria.' };
      return res.redirect('/admin/galeria');
    } catch (e) {
      console.error('Falha ao criar item da galeria:', e);
      req.session.flash = { type: 'error', message: 'Erro ao adicionar item.' };
      return res.redirect('/admin/galeria');
    }
  });
};

// Admin: publicar/despublicar
async function adminPublish(req, res) {
  try {
    if (!isAdmin(req)) return res.redirect('/admin');
    const { id } = req.params;
    const item = await GalleryItem.findByPk(id);
    if (!item) return res.status(404).send('Item não encontrado');
    item.isPublished = true;
    await item.save();
    return res.redirect('/admin/galeria');
  } catch (err) {
    console.error('Erro ao publicar item:', err);
    return res.redirect('/admin/galeria');
  }
}

async function adminUnpublish(req, res) {
  try {
    if (!isAdmin(req)) return res.redirect('/admin');
    const { id } = req.params;
    const item = await GalleryItem.findByPk(id);
    if (!item) return res.status(404).send('Item não encontrado');
    item.isPublished = false;
    await item.save();
    return res.redirect('/admin/galeria');
  } catch (err) {
    console.error('Erro ao despublicar item:', err);
    return res.redirect('/admin/galeria');
  }
}

// Admin: excluir
async function adminDelete(req, res) {
  try {
    if (!isAdmin(req)) return res.redirect('/admin');
    const { id } = req.params;
    const item = await GalleryItem.findByPk(id);
    if (!item) return res.status(404).send('Item não encontrado');
    if (item.filePath) {
      const absPath = path.join(__dirname, '..', '..', 'public', item.filePath);
      try { if (fs.existsSync(absPath)) fs.unlinkSync(absPath); } catch (e) { console.warn('Falha ao apagar arquivo da galeria:', e.message); }
    }
    await item.destroy();
    return res.redirect('/admin/galeria');
  } catch (err) {
    console.error('Erro ao excluir item:', err);
    return res.redirect('/admin/galeria');
  }
}

// Servir mídia salva no DB
async function getMedia(req, res) {
  try {
    const { id } = req.params;
    const item = await GalleryItem.findByPk(id);
    if (!item) return res.status(404).send('Mídia não encontrada');
    // Determinar mime com fallback pelo ext
    const name = item.originalName || '';
    const pathExt = (item.filePath || '').split('.').pop()?.toLowerCase() || '';
    const nameExt = (name || '').split('.').pop()?.toLowerCase() || '';
    const ext = (pathExt || nameExt || '').toLowerCase();
    let mime = item.mimeType || '';
    if (!mime || mime === 'application/octet-stream') {
      if (['png','jpg','jpeg','gif','webp','heic','svg','bmp','tif','tiff','jfif'].includes(ext)) mime = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      else if (['mp4','webm','mov','m4v','avi','mkv','3gp','wmv','mpeg','mpg','ogv'].includes(ext)) mime = ext === 'mpg' || ext === 'mpeg' ? 'video/mpeg' : `video/${ext}`;
    }
    if (!mime) mime = (item.type === 'image' ? 'image/jpeg' : 'video/mp4');
    const isVideo = (item.type === 'video') || (mime.startsWith('video/'));

    // === ETag baseada no conteúdo + data de atualização (garante invalidar quando trocar a foto) ===
    const tsUpdated = item.updatedAt ? new Date(item.updatedAt).getTime().toString(36) : '0';
    const sizeBytes = item.data ? item.data.length : (item.filePath ? 'f' : '0');
    const etag = `W/"${id}-${tsUpdated}-${sizeBytes}-${mime.length}"`;
    // Se navegador já tem essa versão → 304 Not Modified (sem reenviar arquivo)
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch === etag) {
      res.statusCode = 304;
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      return res.end();
    }

    // Se não há BLOB, tentar servir do disco (itens antigos)
    if (!item.data && item.filePath) {
      const rel = (item.filePath || '').replace(/\\/g, '/');
      const abs = path.join(__dirname, '..', '..', 'public', rel);
      if (!fs.existsSync(abs)) return res.status(404).send('Arquivo não encontrado');
      const stat = fs.statSync(abs);
      const size = stat.size;
      const lastModMs = stat.mtimeMs.toString(36);
      const fileEtag = `W/"${id}-f-${lastModMs}-${size}"`;
      const fileInm = req.headers['if-none-match'];
      if (fileInm && fileInm === fileEtag) {
        res.statusCode = 304;
        res.setHeader('ETag', fileEtag);
        res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
        return res.end();
      }
      if (req.headers.range) {
        const range = req.headers.range;
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : size - 1;
        if (isNaN(start) || isNaN(end) || start >= size || end >= size) {
          res.status(416).setHeader('Content-Range', `bytes */${size}`);
          return res.end();
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', end - start + 1);
        res.setHeader('Content-Type', mime);
        res.setHeader('ETag', fileEtag);
        res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate, stale-while-revalidate=60');
        const stream = fs.createReadStream(abs, { start, end });
        return stream.pipe(res);
      }
      res.status(200);
      res.setHeader('Content-Type', mime);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('ETag', fileEtag);
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate, stale-while-revalidate=60');
      res.setHeader('Content-Length', size);
      const stream = fs.createReadStream(abs);
      return stream.pipe(res);
    }

    if (!item.data) return res.status(404).send('Mídia não disponível');

    // Suporte a Range para BLOB de vídeo
    if (isVideo && req.headers.range) {
      const range = req.headers.range;
      const size = item.data.length;
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : size - 1;
      if (isNaN(start) || isNaN(end) || start >= size || end >= size) {
        res.status(416).setHeader('Content-Range', `bytes */${size}`);
        return res.end();
      }
      const chunk = item.data.slice(start, end + 1);
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', chunk.length);
      res.setHeader('Content-Type', mime);
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate, stale-while-revalidate=60');
      return res.end(chunk);
    }

    // Sem Range: envia inteiro (imagem ou vídeo)
    res.status(200);
    res.setHeader('Content-Type', mime);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate, stale-while-revalidate=60');
    res.setHeader('Content-Length', item.data.length);
    return res.end(item.data);
  } catch (err) {
    console.error('Erro ao servir mídia da galeria:', err);
    return res.status(500).send('Falha ao servir mídia');
  }
}

module.exports = { publicPage, adminList, adminCreate, adminPublish, adminUnpublish, adminDelete, getMedia };
// Classificação robusta na renderização (corrige tipo inconsistentes)
function classifyItem(item) {
  try {
    const mime = item.mimeType || '';
    const name = item.originalName || '';
    const pathExt = (item.filePath || '').split('.').pop()?.toLowerCase() || '';
    const nameExt = (name || '').split('.').pop()?.toLowerCase() || '';
    const ext = pathExt || nameExt;
    const current = (item.type || '').toString().toLowerCase();
    if (mime.startsWith('image/') || ['png','jpg','jpeg','gif','webp','heic','svg','bmp','tif','tiff','jfif'].includes(ext) || current === 'image') {
      item.type = 'image';
    } else if (mime.startsWith('video/') || ['mp4','webm','mov','m4v','avi','mkv','3gp','wmv','mpeg','mpg','ogv'].includes(ext) || current === 'video') {
      item.type = 'video';
    }
  } catch (e) {}
  return item;
}

// Converte instancia Sequelize em objeto “plain” seguro para template (sem BLOB `data`)
// Inclui `cacheKey` (timestamp de updatedAt) para cache busting automático na URL
function toViewItem(instance) {
  try {
    const hasData = !!instance?.data;
    const plain = instance?.get ? instance.get({ plain: true }) : instance;
    const { id, title, description, type, filePath, mimeType, originalName, createdAt, updatedAt } = plain || {};
    // Cache key = timestamp da última atualização em base36 (curto e único)
    let cacheKey = '0';
    if (updatedAt) {
      try { cacheKey = new Date(updatedAt).getTime().toString(36); } catch (_) { cacheKey = '0'; }
    }
    return { id, title, description, type, filePath, mimeType, originalName, createdAt, updatedAt, hasData, cacheKey };
  } catch (_) {
    return instance;
  }
}
