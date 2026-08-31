const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const imgDir = path.join(__dirname, '..', '..', 'public', 'img');

const targets = [
  { file: 'fundoMato.png',               quality: 70, maxWidth: 1600, force: true },
  { file: 'peixefundo.png',               quality: 75, maxWidth: 1400, force: true },
  { file: 'moldeCard.png',                quality: 75, maxWidth: 1000, force: true },
  { file: 'logo.png',                     quality: 78, maxWidth: 600,  force: true },
  { file: 'modeloPraExibir NoCardDeBaixar.png', quality: 70, maxWidth: 900, force: true },
  { file: 'rota.png',                     quality: 75, maxWidth: 1400, force: true },
];

function toKB(bytes) { return Math.round(bytes / 1024) + ' KB'; }
function toMB(bytes) { return (bytes / 1024 / 1024).toFixed(2) + ' MB'; }

async function run() {
  const files = fs.readdirSync(imgDir).filter(f => /\.(png|jpe?g)$/i.test(f));
  console.log('Pasta de imagens:', imgDir);
  console.log('Arquivos encontrados:', files.join(', '), '\n');

  let totalBefore = 0;
  let totalAfter = 0;

  for (const f of files) {
    const src = path.join(imgDir, f);
    const stats = fs.statSync(src);
    const ext = path.extname(f).toLowerCase();
    const base = path.basename(f, ext);

    const target = targets.find(t => t.file === f) || { quality: 78, maxWidth: 1600, toFormat: ext === '.jpeg' || ext === '.jpg' ? 'jpeg' : undefined };

    // Passo 1: Converter/copiar imagem original OTIMIZADA mantendo o formato (para fallback)
    const origSize = stats.size;
    totalBefore += origSize;

    let s = sharp(src).rotate();
    const meta = await s.metadata().catch(() => ({}));
    const curW = Number(meta.width) || 0;
    const maxW = Number(target.maxWidth) || 0;
    if (maxW && curW > maxW) s = s.resize({ width: maxW, withoutEnlargement: true });

    const bufOrig = await (target.toFormat === 'jpeg' || ext === '.jpeg' || ext === '.jpg'
      ? s.jpeg({ quality: target.quality || 82, progressive: true, mozjpeg: true }).toBuffer()
      : s.png({ quality: target.quality || 80, compressionLevel: 9, palette: true, effort: 10 }).toBuffer());
    if (bufOrig.length < origSize) {
      fs.writeFileSync(src, bufOrig);
      console.log(`✓ [ORIGINAL] ${f} — ${toKB(origSize)} → ${toKB(bufOrig.length)}  (${((1-bufOrig.length/origSize)*100).toFixed(0)}% menor)`);
    } else {
      console.log(`○ [ORIGINAL] ${f} — manteve ${toKB(origSize)} (já estava bom)`);
    }
    const writtenOrig = fs.statSync(src).size;
    totalAfter += writtenOrig;

    // Passo 2: Gerar versão WebP OTIMIZADA (se ainda não existir, ou target.force)
    const webpFile = path.join(imgDir, `${base}.webp`);
    const needsWebp = target.force || !fs.existsSync(webpFile);
    if (needsWebp) {
      let w = sharp(src).rotate();
      if (maxW && curW > maxW) w = w.resize({ width: maxW, withoutEnlargement: true });
      const bufWebp = await w.webp({ quality: target.quality || 76, effort: 6, preset: 'photo' }).toBuffer();
      fs.writeFileSync(webpFile, bufWebp);
      const ratio = ((1 - bufWebp.length / writtenOrig) * 100).toFixed(0);
      console.log(`  └─ [WEBP]     ${base}.webp — ${toKB(bufWebp.length)}  (-${ratio}% vs PNG/JPG atual)`);
    } else {
      const sz = fs.statSync(webpFile).size;
      console.log(`  └─ [WEBP]     ${base}.webp — já existe (${toKB(sz)})`);
    }
  }

  console.log('\n══════════════════════════════════════════');
  console.log('ANTES (todas as imagens originais):', toMB(totalBefore));
  console.log('DEPOIS (originais comprimidas):     ', toMB(totalAfter));
  const savings = totalBefore - totalAfter;
  if (savings > 0) {
    console.log('Economia (só originais):            ', toKB(savings), `(${(savings/totalBefore*100).toFixed(0)}% menor)`);
  }
  console.log('══════════════════════════════════════════');
  console.log('✓ WebP gerado para cada PNG/JPG. Atualize o .css para usar .webp primeiro (fallback .png automatico via media-url).');
}

run().catch(e => { console.error('Erro na otimização:', e); process.exit(1); });
