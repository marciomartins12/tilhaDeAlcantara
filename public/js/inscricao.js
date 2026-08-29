document.addEventListener('DOMContentLoaded', () => {
  const openButtons = document.querySelectorAll('[data-modal-target]');
  const modals = document.querySelectorAll('.modal');

  function openModal(selector) {
    const modal = document.querySelector(selector);
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    modal.setAttribute('aria-modal', 'true');
    const closeBtn = modal.querySelector('[data-modal-close]');
    if (closeBtn) {
      requestAnimationFrame(() => {
        setTimeout(() => closeBtn.focus({ preventScroll: true }), 0);
      });
    }
  }

  function closeModal(modal) {
    modal.classList.remove('is-open');
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    modal.removeAttribute('aria-modal');
  }

  openButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-modal-target');
      if (target) openModal(target);
    });
  });

  modals.forEach(modal => {
    const closeBtn = modal.querySelector('[data-modal-close]');
    if (closeBtn) closeBtn.addEventListener('click', () => closeModal(modal));
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal(modal);
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal.is-open').forEach(m => closeModal(m));
    }
  });

  // Preview da imagem do avatar
  const avatarInput = document.getElementById('avatar');
  const preview = document.getElementById('avatar-preview');
  const previewImg = document.getElementById('avatar-preview-img');
  const fileNameEl = document.getElementById('avatar-file-name');
  const cropModalSelector = '#modal-avatar-crop';
  const cropImageEl = document.getElementById('avatar-crop-image');
  const cropApplyBtn = document.getElementById('avatar-crop-apply');
  let cropper = null;
  let selectedFile = null;
  // Limpa estado do crop e reabilita seleção do mesmo arquivo novamente
  function cleanupAvatarCrop() {
    try { if (cropper) cropper.destroy(); } catch (_) {}
    cropper = null;
    selectedFile = null;
    if (cropImageEl) cropImageEl.src = '';
    if (avatarInput) avatarInput.value = '';
    if (preview) {
      preview.hidden = true;
      if (previewImg) previewImg.src = '';
      if (fileNameEl) fileNameEl.textContent = '';
    }
  }
  if (avatarInput && preview && previewImg && fileNameEl) {
    // garantir que a prévia comece oculta
    preview.hidden = true;
    previewImg.src = '';
    fileNameEl.textContent = '';

    // tornar a área de dica clicável (fallback se o input não cobrir tudo)
    const dropArea = document.querySelector('#file-upload .file-upload__drop');
    if (dropArea) {
      dropArea.addEventListener('click', () => avatarInput.click());
    }

    avatarInput.addEventListener('change', () => {
      const file = avatarInput.files && avatarInput.files[0];
      if (!file) {
        preview.hidden = true;
        previewImg.src = '';
        fileNameEl.textContent = '';
        return;
      }
      if (!file.type.startsWith('image/')) {
        window.showPopup('Arquivo inválido', 'Selecione uma imagem válida (jpg, png, etc).', 'error');
        avatarInput.value = '';
        preview.hidden = true;
        return;
      }
      selectedFile = file;
      const reader = new FileReader();
      reader.onload = (ev) => {
        // Se existir Cropper, abrir modal de corte quadrado
        if (window.Cropper && cropImageEl) {
          cropImageEl.src = ev.target.result;
          // Abrir modal
          const target = cropModalSelector;
          const modal = document.querySelector(target);
          if (modal) {
            modal.classList.remove('hidden');
            modal.classList.add('is-open');
            modal.setAttribute('aria-hidden', 'false');
            modal.setAttribute('aria-modal', 'true');
          }
          // Instanciar cropper com aspecto 1:1
          if (cropper) {
            try { cropper.destroy(); } catch (_) {}
            cropper = null;
          }
          cropper = new Cropper(cropImageEl, {
            aspectRatio: 1,
            viewMode: 1,
            autoCropArea: 1,
            background: false,
            responsive: true,
          });
        } else {
          // Fallback: sem cropper, apenas prévia
          previewImg.src = ev.target.result;
          fileNameEl.textContent = file.name;
          preview.hidden = false;
        }
      };
      reader.readAsDataURL(file);
    });

    if (cropApplyBtn) {
      cropApplyBtn.addEventListener('click', () => {
        if (!cropper) return;
        const canvas = cropper.getCroppedCanvas({ width: 800, height: 800 });
        if (!canvas) return;
        canvas.toBlob((blob) => {
          if (!blob) return;
          const croppedFileName = (selectedFile && selectedFile.name ? selectedFile.name.replace(/\.[^.]+$/, '') : 'avatar') + '_cropped.png';
          const croppedFile = new File([blob], croppedFileName, { type: 'image/png' });
          const dt = new DataTransfer();
          dt.items.add(croppedFile);
          avatarInput.files = dt.files;

          // Atualiza prévia com o resultado do corte
          const url = URL.createObjectURL(croppedFile);
          previewImg.src = url;
          fileNameEl.textContent = croppedFile.name;
          preview.hidden = false;

          // Fechar modal e destruir cropper
          const modal = document.querySelector(cropModalSelector);
          if (modal) {
            modal.classList.remove('is-open');
            modal.classList.add('hidden');
            modal.setAttribute('aria-hidden', 'true');
            modal.removeAttribute('aria-modal');
          }
          try { cropper.destroy(); } catch (_) {}
          cropper = null;
        }, 'image/png');
      });
    }

    // Integra limpeza ao fechamento do modal de crop (botão fechar e clique fora)
    const avatarCropModal = document.getElementById('modal-avatar-crop');
    if (avatarCropModal) {
      const closeBtn = avatarCropModal.querySelector('[data-modal-close]');
      if (closeBtn) closeBtn.addEventListener('click', cleanupAvatarCrop);
      avatarCropModal.addEventListener('click', (e) => {
        if (e.target === avatarCropModal) cleanupAvatarCrop();
      });
    }
  }

  // Pagamento: copiar PIX e confirmar
  const copyPixBtn = document.getElementById('copy-pix');
  const pixCodeInput = document.getElementById('pix-code');
  if (copyPixBtn && pixCodeInput) {
    copyPixBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pixCodeInput.value);
        copyPixBtn.textContent = 'Copiado!';
        setTimeout(() => (copyPixBtn.textContent = 'Copiar'), 1500);
      } catch (e) {
        window.showPopup('Falha ao copiar', 'Não foi possível copiar. Copie manualmente.', 'error');
      }
    });
  }

  // Polling de status para redirecionar automaticamente quando pago
  const pagamentoSection = document.getElementById('pagamento');
  if (pagamentoSection) {
    const regId = pagamentoSection.getAttribute('data-reg-id');
    const modal = document.getElementById('payment-confirm-modal');
    const modalYes = document.getElementById('modal-confirm-yes');
    const modalNo = document.getElementById('modal-confirm-no');
    const modalClose = modal ? modal.querySelector('[data-modal-close]') : null;
    const showModal = () => { if (modal) { modal.classList.add('is-open'); modal.classList.remove('hidden'); modal.setAttribute('aria-hidden', 'false'); modal.setAttribute('aria-modal', 'true'); } };
    const hideModal = () => { if (modal) { modal.classList.remove('is-open'); modal.classList.add('hidden'); modal.setAttribute('aria-hidden', 'true'); modal.removeAttribute('aria-modal'); } };
    let pollingTimer = null;
    const poll = async () => {
      try {
        if (!regId) return;
        const res = await fetch(`/inscricao/status/${regId}?refresh=1`, { headers: { 'Accept': 'application/json' } });
        if (!res.ok) return;
        const data = await res.json();
        if (data && data.status === 'paid') {
          clearInterval(pollingTimer);
          // Atualizar indicador de status na página
          const statusEl = document.querySelector('#pagamento .status');
          if (statusEl) {
            const msgEl = statusEl.querySelector('span');
            const spinnerEl = statusEl.querySelector('.status__spinner');
            if (spinnerEl) spinnerEl.style.display = 'none';
            if (msgEl) msgEl.textContent = 'Pagamento confirmado!';
          }
          // Mostrar modal de confirmação para baixar o card agora
          showModal();
          if (modalYes) {
            modalYes.onclick = () => {
              hideModal();
              // Levar apenas para a página de baixar o card (sem imprimir automático)
              window.location.href = `/inscricao/card/${regId}`;
            };
          }
          if (modalNo) {
            modalNo.onclick = () => {
              hideModal();
              // Permanecer na página; usuário pode baixar depois pelo menu
            };
          }
          if (modalClose) {
            modalClose.onclick = hideModal;
          }
        }
      } catch (_) {
        // silencioso
      }
    };
    // iniciar após breve atraso e repetir a cada 5s
    setTimeout(() => {
      poll();
      pollingTimer = setInterval(poll, 5000);
    }, 1500);
  }

  // Validações de CPF e Telefone no cliente
  const cpfInput = document.getElementById('cpf');
  const phoneInput = document.getElementById('phone');

  function onlyDigits(str) { return String(str || '').replace(/\D/g, ''); }
  function isValidCPF(raw) {
    const cpf = onlyDigits(raw);
    if (!cpf || cpf.length !== 11) return false;
    if (/^(\d)\1{10}$/.test(cpf)) return false;
    let sum = 0; for (let i = 0; i < 9; i++) sum += parseInt(cpf[i], 10) * (10 - i);
    let first = (sum * 10) % 11; if (first === 10) first = 0; if (first !== parseInt(cpf[9], 10)) return false;
    sum = 0; for (let i = 0; i < 10; i++) sum += parseInt(cpf[i], 10) * (11 - i);
    let second = (sum * 10) % 11; if (second === 10) second = 0; if (second !== parseInt(cpf[10], 10)) return false;
    return true;
  }
  function isValidPhone(raw) {
    const phone = onlyDigits(raw);
    return phone.length >= 10 && phone.length <= 11;
  }

  if (cpfInput) {
    cpfInput.addEventListener('input', () => {
      const digits = onlyDigits(cpfInput.value).slice(0, 11);
      cpfInput.value = digits;
      cpfInput.setCustomValidity('');
    });
    cpfInput.addEventListener('blur', () => {
      if (cpfInput.value && !isValidCPF(cpfInput.value)) {
        cpfInput.setCustomValidity('CPF inválido. Verifique e tente novamente.');
        cpfInput.reportValidity();
      } else {
        cpfInput.setCustomValidity('');
      }
    });
  }

  if (phoneInput) {
    phoneInput.addEventListener('input', () => {
      const digits = onlyDigits(phoneInput.value).slice(0, 11);
      phoneInput.value = digits;
      phoneInput.setCustomValidity('');
    });
    phoneInput.addEventListener('blur', () => {
      if (phoneInput.value && !isValidPhone(phoneInput.value)) {
        phoneInput.setCustomValidity('Telefone inválido. Use apenas números com DDD.');
        phoneInput.reportValidity();
      } else {
        phoneInput.setCustomValidity('');
      }
    });
  }

  // ========= Data de Nascimento: máscara DD/MM/AAAA + validação + idade =========
  const birthDateInput = document.getElementById('birthDate');
  const birthDateAgeEl = document.getElementById('birthDate-age');
  const birthDateErrorEl = document.getElementById('birthDate-error');
  if (birthDateInput) {
    function formatDateBR(raw) {
      const digits = onlyDigits(raw).slice(0, 8);
      const parts = [];
      if (digits.length > 0) parts.push(digits.substring(0, 2));
      if (digits.length > 2) parts.push(digits.substring(2, 4));
      if (digits.length > 4) parts.push(digits.substring(4, 8));
      return parts.join('/');
    }

    function isValidDateBR(raw) {
      const digits = onlyDigits(raw);
      if (digits.length !== 8) return null;
      const d = parseInt(digits.substring(0, 2), 10);
      const m = parseInt(digits.substring(2, 4), 10);
      const y = parseInt(digits.substring(4, 8), 10);
      if (!y || !m || !d || m < 1 || m > 12) return null;
      const dmy = new Date(y, m - 1, d);
      const invalid = dmy.getFullYear() !== y || dmy.getMonth() !== m - 1 || dmy.getDate() !== d;
      if (invalid) return null;
      // Data não pode ser no futuro
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (dmy.getTime() > today.getTime()) return null;
      // Idade mínima = 5 anos (criança muito nova não participa) e máxima razoável 122 anos
      const age = calcAge(dmy);
      if (age < 5 || age > 122) return null;
      return { d, m, y, date: dmy, age };
    }

    function calcAge(birth) {
      const today = new Date();
      let years = today.getFullYear() - birth.getFullYear();
      const months = today.getMonth() - birth.getMonth();
      if (months < 0 || (months === 0 && today.getDate() < birth.getDate())) years -= 1;
      return years;
    }

    function updateBirthDateUI() {
      const valid = isValidDateBR(birthDateInput.value);
      const parent = birthDateAgeEl && birthDateAgeEl.parentElement;
      if (!valid) {
        if (birthDateAgeEl) birthDateAgeEl.textContent = 'Idade: —';
        parent && parent.classList.remove('is-valid', 'is-invalid');
        if (birthDateErrorEl) birthDateErrorEl.classList.add('hidden');
        birthDateInput.setCustomValidity('');
        return;
      }
      birthDateAgeEl.textContent = `Idade: ${valid.age} ano${valid.age === 1 ? '' : 's'}`;
      parent && parent.classList.add('is-valid');
      parent && parent.classList.remove('is-invalid');
      birthDateInput.setCustomValidity('');
    }

    birthDateInput.addEventListener('input', () => {
      const caret = birthDateInput.selectionStart;
      const before = birthDateInput.value;
      birthDateInput.value = formatDateBR(birthDateInput.value);
      // Move cursor p/ final (mantém UX de digitação simples)
      try { birthDateInput.setSelectionRange(birthDateInput.value.length, birthDateInput.value.length); } catch (_) { }
      updateBirthDateUI();
    });

    birthDateInput.addEventListener('paste', (e) => {
      const cd = e.clipboardData || window.clipboardData;
      if (cd && typeof cd.getData === 'function') {
        e.preventDefault();
        const txt = cd.getData('text');
        birthDateInput.value = formatDateBR(txt);
        updateBirthDateUI();
      }
    });

    birthDateInput.addEventListener('blur', () => {
      const digits = onlyDigits(birthDateInput.value);
      if (!digits) {
        // Campo vazio: ok (não obrigatório por enquanto)
        if (birthDateAgeEl) birthDateAgeEl.textContent = 'Idade: —';
        const parent = birthDateAgeEl && birthDateAgeEl.parentElement;
        parent && parent.classList.remove('is-valid', 'is-invalid');
        if (birthDateErrorEl) birthDateErrorEl.classList.add('hidden');
        birthDateInput.setCustomValidity('');
        return;
      }
      const valid = isValidDateBR(birthDateInput.value);
      const parent = birthDateAgeEl && birthDateAgeEl.parentElement;
      if (!valid) {
        const msg = 'Data de nascimento inválida. Use DD/MM/AAAA.';
        birthDateInput.setCustomValidity(msg);
        if (birthDateErrorEl) {
          birthDateErrorEl.textContent = msg;
          birthDateErrorEl.classList.remove('hidden');
        }
        if (birthDateAgeEl) birthDateAgeEl.textContent = 'Idade: inválida';
        parent && parent.classList.add('is-invalid');
        parent && parent.classList.remove('is-valid');
        birthDateInput.reportValidity();
      } else {
        updateBirthDateUI();
      }
    });

    // Atualiza UI inicial caso o navegador restaure o campo
    updateBirthDateUI();
  }
});