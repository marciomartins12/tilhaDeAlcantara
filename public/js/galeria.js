document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('media');
  const drop = document.getElementById('fileDrop');
  const preview = document.getElementById('mediaPreview');

  if (!input || !drop || !preview) return;

  const renderPreview = (file) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    preview.innerHTML = '';

    if (file.type && file.type.startsWith('image')) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = 'Pré-visualização da imagem selecionada';
      img.className = 'file-preview__thumb';
      preview.appendChild(img);
    } else if (file.type && file.type.startsWith('video')) {
      const video = document.createElement('video');
      video.src = url;
      video.className = 'file-preview__thumb';
      video.controls = true;
      video.muted = true;
      preview.appendChild(video);
    } else {
      const p = document.createElement('p');
      p.textContent = 'Tipo de arquivo não suportado para preview.';
      preview.appendChild(p);
    }
  };

  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    renderPreview(file);
  });

  // Drag & Drop na dropzone
  const prevent = (e) => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter', 'dragover'].forEach(evt => {
    drop.addEventListener(evt, (e) => {
      prevent(e);
      drop.classList.add('file-drop--dragover');
    });
  });
  ['dragleave', 'drop'].forEach(evt => {
    drop.addEventListener(evt, (e) => {
      prevent(e);
      drop.classList.remove('file-drop--dragover');
    });
  });
  drop.addEventListener('drop', (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files[0]) {
      // Atribui ao input para enviar no formulário
      input.files = files;
      renderPreview(files[0]);
    }
  });
});