document.addEventListener('DOMContentLoaded', () => {
  const modal = document.getElementById('modal-image-view');
  const modalImg = modal ? modal.querySelector('.modal__image') : null;

  // Botões para abrir imagem completa em pop-up
  const openButtons = document.querySelectorAll('.js-open-full-image');
  openButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      if (!modal || !modalImg) return;
      let src = btn.getAttribute('data-image-src');
      const alt = btn.getAttribute('data-image-alt') || '';
      if (!src) {
        const item = btn.closest('.gallery-item');
        const img = item ? item.querySelector('img.gallery-item__thumb') : null;
        if (img) src = img.getAttribute('src') || img.currentSrc || '';
      }
      if (src) modalImg.src = src;
      modalImg.alt = alt;
    });
  });

  // Clicar na imagem também abre o modal e preenche o src/alt
  const thumbs = document.querySelectorAll('img.gallery-item__thumb[data-modal-target="#modal-image-view"]');
  thumbs.forEach(img => {
    img.addEventListener('click', () => {
      if (!modal || !modalImg) return;
      const src = img.getAttribute('src') || img.currentSrc || '';
      const alt = img.getAttribute('alt') || '';
      if (src) modalImg.src = src;
      modalImg.alt = alt;
    });
  });
});