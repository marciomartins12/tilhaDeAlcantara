document.addEventListener('DOMContentLoaded', () => {
  const menuBtn = document.querySelector('.menu');
  const mobileMenu = document.getElementById('mobile-menu');

  if (!menuBtn || !mobileMenu) return;

  const open = () => {
    mobileMenu.classList.add('mobile-menu--open');
    mobileMenu.setAttribute('aria-hidden', 'false');
    menuBtn.setAttribute('aria-expanded', 'true');
    document.body.classList.add('no-scroll');
  };

  const close = () => {
    mobileMenu.classList.remove('mobile-menu--open');
    mobileMenu.setAttribute('aria-hidden', 'true');
    menuBtn.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('no-scroll');
  };

  menuBtn.addEventListener('click', () => {
    const isOpen = mobileMenu.classList.contains('mobile-menu--open');
    if (isOpen) {
      close();
    } else {
      open();
    }
  });

  // Fecha ao clicar em qualquer link do menu
  mobileMenu.addEventListener('click', (e) => {
    const link = e.target.closest('a.mobile-menu__link');
    if (link) close();
  });

  // Fecha com tecla ESC
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  // Link "Início": rola ao topo e atualiza a página
  const inicioLinks = document.querySelectorAll('a[href="#inicio"]');
  inicioLinks.forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      // fecha menu móvel se estiver aberto
      close();
      // rola suave para o topo
      window.scrollTo({ top: 0, behavior: 'smooth' });
      // recarrega após a rolagem iniciar
      setTimeout(() => {
        window.location.reload();
      }, 350);
    });
  });

  // === Toast global ===
  (function() {
    const root = document.getElementById('toast-root');
    function iconFor(type) {
      switch (type) {
        case 'error': return '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 10 10A10.011 10.011 0 0 0 12 2Zm1 15h-2v-2h2Zm0-4h-2V7h2Z"/></svg>';
        case 'success': return '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 10 10A10.011 10.011 0 0 0 12 2Zm-1 15-4-4 1.414-1.414L11 13.172l4.586-4.586L17 10l-6 7Z"/></svg>';
        default: return '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 10 10A10.011 10.011 0 0 0 12 2Zm1 15h-2v-2h2Zm0-4h-2V7h2Z"/></svg>';
      }
    }
    window.showToast = function(message, type = 'info', timeout = 3500) {
      if (!root) return alert(message); // fallback extremo
      const div = document.createElement('div');
      div.className = `toast toast--${type}`;
      div.innerHTML = `<span class="toast__icon">${iconFor(type)}</span><span class="toast__message">${message}</span>`;
      root.appendChild(div);
      setTimeout(() => {
        div.style.opacity = '0';
        div.style.transform = 'translateY(8px)';
        setTimeout(() => div.remove(), 220);
      }, timeout);
    };
  })();

  // === Confirmação global em formulários ===
  (function() {
    const modal = document.getElementById('global-confirm-modal');
    const msgEl = document.getElementById('global-confirm-message');
    const okBtn = document.getElementById('global-confirm-ok');
    const cancelBtn = document.getElementById('global-confirm-cancel');
    let pendingForm = null;
    function openConfirm(message) {
      if (!modal) return true; // fallback
      msgEl.textContent = message || 'Confirmar ação?';
      modal.classList.add('is-open');
      modal.classList.remove('hidden');
      modal.setAttribute('aria-hidden', 'false');
      modal.setAttribute('aria-modal', 'true');
    }
    function closeConfirm() {
      if (!modal) return;
      modal.classList.remove('is-open');
      modal.classList.add('hidden');
      modal.setAttribute('aria-hidden', 'true');
      modal.removeAttribute('aria-modal');
    }
    document.addEventListener('submit', (e) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement)) return;
      const message = form.getAttribute('data-confirm');
      if (!message) return; // sem confirmação
      e.preventDefault();
      pendingForm = form;
      openConfirm(message);
    });
    okBtn?.addEventListener('click', () => {
      closeConfirm();
      if (pendingForm) {
        const form = pendingForm;
        pendingForm = null;
        form.submit();
      }
    });
    cancelBtn?.addEventListener('click', () => {
      pendingForm = null;
      closeConfirm();
    });
  })();

  // === Pop-up global de aviso (showPopup) ===
  (function() {
    const modal = document.getElementById('global-info-modal');
    const titleEl = document.getElementById('global-info-title');
    const msgEl = document.getElementById('global-info-message');
    const okBtn = document.getElementById('global-info-ok');
    const closeBtn = document.getElementById('global-info-close');

    function openInfo(title, message) {
      if (!modal) return alert(message || title || ''); // fallback extremo
      if (titleEl) titleEl.textContent = title || 'Aviso';
      if (msgEl) msgEl.textContent = message || '';
      modal.classList.remove('hidden');
      modal.classList.add('is-open');
      modal.setAttribute('aria-hidden', 'false');
      modal.setAttribute('aria-modal', 'true');
      if (okBtn) {
        requestAnimationFrame(() => {
          setTimeout(() => okBtn.focus({ preventScroll: true }), 0);
        });
      }
    }
    function closeInfo() {
      if (!modal) return;
      modal.classList.add('hidden');
      modal.classList.remove('is-open');
      modal.setAttribute('aria-hidden', 'true');
      modal.removeAttribute('aria-modal');
    }

    window.showPopup = function(title, message, type = 'info') {
      // type reservado para futura customização visual
      openInfo(title, message);
    };

    okBtn?.addEventListener('click', closeInfo);
    closeBtn?.addEventListener('click', closeInfo);
    // Fecha ao clicar fora do diálogo
    modal?.addEventListener('click', (e) => {
      if (e.target === modal) closeInfo();
    });
    // Fecha com ESC
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeInfo();
    });
  })();
});