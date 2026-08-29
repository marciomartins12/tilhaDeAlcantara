const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const imgDir = path.join(__dirname, '..', '..', 'public', 'img');

async function run() {
  const f = 'rota.jpeg';
  const src = path.join(imgDir, f);
  const tmp = path.join(imgDir, f + '.tmp.' + Date.now() + '.jpg');
  const meta = await sharp(src).metadata();
  const curW = Number(meta.width) || 0;
  let s = sharp(src).rotate();
  if (curW > 1600) s = s.resize({ width: 1600, withoutEnlargement: true });

  const buf = await s.jpeg({ quality: 82, progressive: true, mozjpeg: true }).toBuffer();
  fs.writeFileSync(tmp, buf);
  // Tenta sobrescrever em 2 etapas para evitar lock de arquivo no Windows
  try {
    fs.rmSync(src, { force: true });
  } catch (_) {}
  try { fs.renameSync(tmp, src); } catch { fs.copyFileSync(tmp, src); fs.rmSync(tmp, { force: true }); }

  // WebP versão
  const bufW = await sharp(src).rotate()
    .resize({ width: 1600, withoutEnlargement: true })
    .webp({ quality: 82, effort: 6, preset: 'photo' }).toBuffer();
  fs.writeFileSync(path.join(imgDir, 'rota.webp'), bufW);
  const sz = fs.statSync(src).size;
  console.log('OK: rota.jpeg →', Math.round(sz/1024), 'KB');
  console.log('OK: rota.webp →', Math.round(bufW.length/1024), 'KB');
}
run().catch(e => { console.error(e); process.exit(1); });
