(function(){
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  function init() {
  const composer = document.getElementById('card-composer');
  const canvas = document.getElementById('card-canvas');
  const downloadBtn = document.getElementById('download-card');
  if (!composer || !canvas) return;
  // Obter ID de forma resiliente: atributo data-id ou URL
  let regId = (composer.getAttribute('data-id') || '').trim();
  if (!regId) {
    const m = (window.location.pathname || '').match(/\/inscricao\/card\/(\d+)/);
    if (m) regId = m[1];
  }
  if (!regId) {
    console.error('ID da inscrição não encontrado na página.');
    const msg = document.createElement('p');
    msg.style.marginTop = '12px';
    msg.style.color = '#ffd9d9';
    msg.textContent = 'ID da inscrição não encontrado. Abra a página correta do seu card.';
    composer.appendChild(msg);
    return;
  }
  const paramsGlobal = new URLSearchParams(window.location.search);
  let name = (paramsGlobal.get('name') ?? composer.getAttribute('data-name') ?? '').trim();
  let group = (paramsGlobal.get('group') ?? composer.getAttribute('data-group') ?? '').trim();
  let city = (paramsGlobal.get('city') ?? composer.getAttribute('data-city') ?? '').trim();
  let type = (paramsGlobal.get('type') ?? composer.getAttribute('data-type') ?? '').trim();

  const ctx = canvas.getContext('2d');

  // Permitir calibração do círculo via atributos opcionais (valores em proporção 0..1)
  function readRatio(attrName, fallback) {
    const raw = (composer.getAttribute(attrName) || '').trim();
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }
  // Permitir ajustar via atributos ou query (?circle-cx=, ?circle-cy=, ?circle-r=)
  const circleCxRatio = readNumberPref('data-circle-cx', 0.52);
  const circleCyRatio = readNumberPref('data-circle-cy', 0.50);
  const circleRadiusRatio = readNumberPref('data-circle-r', 0.31);
  // Overscan (pode vir via atributo ou query string ?overscan=1.0)
  function readNumberPref(nameAttr, fallback) {
    const rawAttr = (composer.getAttribute(nameAttr) || '').trim();
    const params = new URLSearchParams(window.location.search);
    const rawParam = params.get(nameAttr.replace('data-', '')) || '';
    const raw = rawParam || rawAttr;
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }
  const overscanPref = readNumberPref('data-overscan', 1.0);

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  async function ensureData() {
    if (name && (group || city)) return; // já temos dados
    try {
      const res = await fetch(`/inscricao/card-data/${regId}`, { headers: { 'Accept': 'application/json' } });
      if (res.ok) {
        const data = await res.json();
        name = name || (data.name || '');
        group = group || (data.group || '');
        city = city || (data.city || '');
        type = type || (data.type || '');
      }
    } catch (e) {
      // silencioso
    }
  }

  async function compose() {
    try {
      await ensureData();
      const bg = await loadImage('/public/img/moldeCard.webp').catch(() => loadImage('/public/img/moldeCard.png'));
      // Carrega somente do endpoint binário (BLOB no banco)
      let avatarImg;
      const avatarPathAttr = (composer.getAttribute('data-avatar-path') || '').trim();
      try {
        const avatarRes = await fetch(`/inscricao/avatar-data/${regId}`);
        if (avatarRes.ok) {
          const avatarBlob = await avatarRes.blob();
          const avatarUrl = URL.createObjectURL(avatarBlob);
          avatarImg = await loadImage(avatarUrl);
          // não revogar aqui; revogamos após desenhar
          avatarImg.__blobUrl = avatarUrl;
        }
      } catch (_) {
        // Se falhar, seguimos sem avatar
      }

      // Fallback: se não veio do banco, tentar caminho em disco público
      if (!avatarImg && avatarPathAttr) {
        try {
          const src = avatarPathAttr.startsWith('/public/') ? avatarPathAttr : `/public/${avatarPathAttr.replace(/^\/*/, '')}`;
          avatarImg = await loadImage(src);
        } catch (_) {
          // mantém sem avatar
        }
      }

      // Dimensiona canvas ao tamanho do molde
      canvas.width = bg.width;
      canvas.height = bg.height;
      // Exibir responsivamente dentro do card
      canvas.style.width = '100%';
      canvas.style.height = 'auto';
      canvas.style.display = 'block';

      // Fundo (molde)
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bg, 0, 0, canvas.width, canvas.height);

      // Avatar dentro do círculo (calibrável)
      const cx = canvas.width * circleCxRatio;
      const cy = canvas.height * circleCyRatio;
      const radius = canvas.width * circleRadiusRatio;
      const diameter = radius * 2;

      if (avatarImg) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        // cover fit
        // Overscan configurável (padrão 1.0 para evitar zoom)
        const overscan = overscanPref;
        const scale = Math.max(diameter / avatarImg.width, diameter / avatarImg.height) * overscan;
        const drawW = avatarImg.width * scale;
        const drawH = avatarImg.height * scale;
        ctx.drawImage(avatarImg, cx - drawW / 2, cy - drawH / 2, drawW, drawH);
        ctx.restore();
        // Liberar URL de blob após uso
        try { if (avatarImg.__blobUrl) URL.revokeObjectURL(avatarImg.__blobUrl); } catch (_) {}
      } else {
        // Sem avatar: desenhar apenas um anel dourado para manter composição
        ctx.save();
        ctx.lineWidth = Math.max(4, Math.round(canvas.width * 0.01));
        ctx.strokeStyle = '#e4b73f';
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
      }

      // Garantir que a fonte Bebas Neue (com subset Cyrillic) esteja carregada antes de desenhar
      try {
        await Promise.all([
          document.fonts.load('normal 64px "Bebas Neue"'),
          document.fonts.load('bold 64px "Bebas Neue"'),
          document.fonts.load('normal 40px "Bebas Neue"')
        ]);
      } catch (_) {}

      // Textos (nome/grupo/cidade) usando Bebas Neue
      const centerX = canvas.width / 2 +120;
      const baseNameSize = Math.round(canvas.width * 0.06);
      let nameSize = baseNameSize;
      const groupSize = Math.round(canvas.width * 0.05);
      const citySize = Math.round(canvas.width * 0.05);
      const typeSize = Math.round(canvas.width * 0.05);

      // Posições ajustadas: mais para baixo e separação mínima
      const nameY = Math.round(canvas.height * 0.862);
      const groupY = Math.round(canvas.height * 0.908);
      const cityY = Math.round(canvas.height * 0.96);
      const typeY = Math.round(canvas.height * 0.968);

      ctx.textAlign = 'center';
      // sem borda/sombra conforme pedido
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;

      // Nome
      let nameText = (name || '').trim();
      const parts = nameText.split(/\s+/).filter(Boolean);
      const particles = new Set(['de', 'do', 'da', 'dos', 'das', 'e']);
      const chosenParts = (parts.length >= 3 && particles.has(String(parts[1] || '').toLowerCase()))
        ? parts.slice(0, 3)
        : parts.slice(0, 2);
      nameText = chosenParts.join(' ').toUpperCase();

      const fontStack = (sz) => `normal ${sz}px "Bebas Neue Cyrillic","Bebas Neue", Arial, sans-serif`;
      const fontFallback = (sz) => `normal ${sz}px Arial, sans-serif`;
      ctx.font = fontStack(nameSize);
      if (nameText) {
        const maxNameWidth = canvas.width * 0.78;
        const minNameSize = Math.max(8, Math.round(canvas.width * 0.038));
        const baseLimit = 17;
        const measureAt = (sz) => {
          ctx.font = fontStack(sz);
          let mw = ctx.measureText(nameText).width;
          if (!mw || mw <= 0) {
            ctx.font = fontFallback(sz);
            mw = ctx.measureText(nameText).width;
          }
          return mw;
        };

        // Até 17 caracteres mantém o tamanho original; acima disso diminui proporcionalmente.
        if (nameText.length > baseLimit) {
          const ratioChars = baseLimit / Math.max(baseLimit + 1, nameText.length);
          nameSize = Math.max(minNameSize, Math.floor(baseNameSize * ratioChars));
        }

        let w = measureAt(nameSize);

        // Garantir que caiba no espaço reservado
        if (w > maxNameWidth) {
          let low = minNameSize;
          let high = nameSize;
          let best = minNameSize;

          while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const mw = measureAt(mid);
            if (mw <= maxNameWidth) {
              best = mid;
              low = mid + 1;
            } else {
              high = mid - 1;
            }
          }

          nameSize = Math.max(minNameSize, best);
          measureAt(nameSize);
        }
        ctx.fillStyle = '#000000ff';
        const sizeDrop = Math.max(0, baseNameSize - nameSize);
        const nameYAdjusted = Math.round(nameY - Math.min(14, sizeDrop * 0.35));
        ctx.fillText(nameText, centerX, nameYAdjusted);
        // sem borda
      }

      // Grupo
      if (group) {
        const groupText = group.toUpperCase();
        ctx.font = `normal ${groupSize}px "Bebas Neue Cyrillic","Bebas Neue", Arial, sans-serif`;
        const wg = ctx.measureText(groupText).width;
        if (!wg || wg <= 0) ctx.font = `normal ${groupSize}px Arial, sans-serif`;
        ctx.fillStyle = '#000000ff'; // dourado
        ctx.fillText(groupText, centerX, groupY);
        // sem borda
      }

      // Cidade
      if (city) {
        const cityText = city.toUpperCase();
        ctx.font = `normal ${citySize}px "Bebas Neue Cyrillic","Bebas Neue", Arial, sans-serif`;
        const wc = ctx.measureText(cityText).width;
        if (!wc || wc <= 0) ctx.font = `normal ${citySize}px Arial, sans-serif`;
        ctx.fillStyle = '#000000ff';
        ctx.fillText(cityText, centerX, cityY);
        // sem borda
      }

      // Não exibir tipo (ATLETA/ACOMPANHANTE)

      if (avatarImg.__blobUrl) URL.revokeObjectURL(avatarImg.__blobUrl);
    } catch (err) {
      console.error('Falha ao compor card:', err);
      const msg = document.createElement('p');
      msg.style.marginTop = '12px';
      msg.style.color = '#0e5af0';
      msg.textContent = 'Não foi possível gerar a prévia do card. Foto não encontrada no banco.';
      composer.appendChild(msg);
    }
  }

  compose();

  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => {
      try {
        const dataUrl = canvas.toDataURL('image/png');
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = `/inscricao/card-download-canvas/${regId}`;
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'data';
        input.value = dataUrl;
        form.appendChild(input);
        document.body.appendChild(form);
        form.submit();
        document.body.removeChild(form);
      } catch (e) {
        console.error('Falha ao baixar card:', e);
      }
    });
  }
  }
})();
