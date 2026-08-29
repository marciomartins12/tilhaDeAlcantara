const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');
const { Sequelize } = require('sequelize');
const { sequelize } = require('../models');
const Registration = require('../models/Registration');
const { createPixPayment, getPaymentById } = require('../services/mercadoPago');

const MAX_PAIDORDER_RETRIES = 5;

async function assignPaidOrderIfNeeded(regOrId, overrides) {
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_PAIDORDER_RETRIES; attempt++) {
    const tx = await sequelize.transaction({ isolationLevel: Sequelize.Transaction.ISOLATION_LEVELS.REPEATABLE_READ });
    try {
      const regId = typeof regOrId === 'object' ? (regOrId.id ?? regOrId.get?.('id')) : Number(regOrId);
      if (!Number.isFinite(regId)) throw new Error('ID de inscrição inválido para assignPaidOrderIfNeeded');

      const locked = await Registration.findByPk(regId, { transaction: tx, lock: tx.LOCK.UPDATE });
      if (!locked) { await tx.rollback(); return null; }
      if (locked.type !== 'ATLETA') { await tx.rollback(); return locked; }
      if (locked.paidOrder && Number(locked.paidOrder) > 0) { await tx.rollback(); return locked; }

      const [[row]] = await sequelize.query(
        "SELECT COALESCE(MAX(paidOrder), 0) + 1 AS nextOrder FROM registrations WHERE type = 'ATLETA' FOR UPDATE",
        { transaction: tx }
      );
      const nextOrder = Number(row?.nextOrder || 1);
      locked.paidOrder = nextOrder;

      if (!locked.paymentConfirmedAt) {
        locked.paymentConfirmedAt = (overrides && overrides.paymentConfirmedAt) || new Date();
      }
      if (!locked.paymentConfirmedBy) {
        locked.paymentConfirmedBy = (overrides && overrides.paymentConfirmedBy) || 'Mercado Pago';
      }

      await locked.save({ transaction: tx });
      await tx.commit();
      return locked;
    } catch (e) {
      try { await tx.rollback(); } catch (_) {}
      const isConflict =
        e instanceof Sequelize.UniqueConstraintError ||
        e instanceof Sequelize.DeadlockError ||
        (e.name === 'SequelizeDatabaseError' && /deadlock|lock wait timeout/i.test(e.message)) ||
        (e.name === 'SequelizeUniqueConstraintError');

      if (isConflict && attempt < MAX_PAIDORDER_RETRIES) {
        lastErr = e;
        const delayMs = 50 * attempt + Math.floor(Math.random() * 80);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      console.warn(`Falha ao atribuir paidOrder (tentativa ${attempt}/${MAX_PAIDORDER_RETRIES}):`, e.message);
      lastErr = e;
      break;
    }
  }
  if (lastErr) console.warn('assignPaidOrderIfNeeded falhou após', MAX_PAIDORDER_RETRIES, 'tentativas:', lastErr.message);
  return null;
}

// Leitura robusta dos preços a partir do .env com nomes alternativos
// Aceita: PRICE_ATLETA | PRECO_ATLETA | VALOR_ATLETA
//         PRICE_ACOMPANHANTE | PRECO_ACOMPANHANTE | VALOR_ACOMPANHANTE
function readEnvPrice(keys, fallback) {
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      // Aceitar formatos brasileiros com vírgula (ex: "49,90")
      const sanitized = String(v).trim().replace(',', '.');
      const num = Number(sanitized);
      if (!Number.isNaN(num)) return num;
    }
  }
  return undefined;
}

const PRICES = {
  ATLETA: readEnvPrice(['PRICE_ATLETA', 'PRECO_ATLETA', 'VALOR_ATLETA']),
  ACOMPANHANTE: readEnvPrice(['PRICE_ACOMPANHANTE', 'PRECO_ACOMPANHANTE', 'VALOR_ACOMPANHANTE']),
};

function calcAmount(type) {
  const v = PRICES[type];
  if (typeof v !== 'number') throw new Error('Preço de inscrição não configurado no .env');
  return v;
}

async function hasReachedAthleteLimit() {
  const limit = Number(process.env.ATHLETE_LIMIT || process.env.MEDAL_CUTOFF || 300);
  const count = await Registration.count({ where: { type: 'ATLETA', paymentStatus: 'paid' } });
  return count >= limit;
}

// Utilidades de validação
function onlyDigits(str) {
  return String(str || '').replace(/\D/g, '');
}

function isValidCPF(raw) {
  const cpf = onlyDigits(raw);
  if (!cpf || cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false; // todos os dígitos iguais
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(cpf.charAt(i), 10) * (10 - i);
  let first = (sum * 10) % 11; if (first === 10) first = 0;
  if (first !== parseInt(cpf.charAt(9), 10)) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(cpf.charAt(i), 10) * (11 - i);
  let second = (sum * 10) % 11; if (second === 10) second = 0;
  if (second !== parseInt(cpf.charAt(10), 10)) return false;
  return true;
}

function isValidPhone(raw) {
  const phone = onlyDigits(raw);
  // Brasil: 10 ou 11 dígitos (com DDD). Evitar letras já com onlyDigits
  return phone.length >= 10 && phone.length <= 11;
}

/**
 * Valida e normaliza data de nascimento.
 * Input pode ser: "DD/MM/AAAA", "DD-MM-AAAA", "YYYY-MM-DD" ou só números.
 * Retorna { dateISO: 'YYYY-MM-DD', age, dateObj } ou null se inválida.
 * Regras: não futuro, idade 5-122 anos, mês válido, dia do mês válido (inclui ano bissexto).
 */
function parseBirthDate(raw) {
  const str = String(raw || '').trim();
  if (!str) return null;
  // Se vier no formato ISO do banco
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [y, m, d] = str.split('-').map(Number);
    return validateYMD(y, m, d);
  }
  const digits = onlyDigits(str);
  if (digits.length !== 8) return null;
  // BR: DDMMAAAA
  const d = parseInt(digits.substring(0, 2), 10);
  const m = parseInt(digits.substring(2, 4), 10);
  const y = parseInt(digits.substring(4, 8), 10);
  return validateYMD(y, m, d);
}

function validateYMD(y, m, d) {
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dateObj = new Date(y, m - 1, d);
  const invalid =
    dateObj.getFullYear() !== y ||
    dateObj.getMonth() !== m - 1 ||
    dateObj.getDate() !== d;
  if (invalid) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (dateObj.getTime() > today.getTime()) return null;
  let age = today.getFullYear() - dateObj.getFullYear();
  const mo = today.getMonth() - dateObj.getMonth();
  if (mo < 0 || (mo === 0 && today.getDate() < dateObj.getDate())) age -= 1;
  if (age < 5 || age > 122) return null;
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return { dateISO: `${y}-${mm}-${dd}`, age, dateObj, y, m, d };
}

// Multer em memória para avatar da página do card (não salvar em disco)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) return cb(null, true);
    cb(new Error('Arquivo deve ser uma imagem'));
  },
});

// Multer em memória para avatar enviado no formulário principal (sem id ainda)
const uploadInline = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // limitar a 8MB no formulário principal
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) return cb(null, true);
    cb(new Error('Arquivo deve ser uma imagem'));
  },
});

async function formPage(req, res) {
  res.render('inscricao', { prices: PRICES, activeNav: 'inscricao' });
}

async function submit(req, res) {
  try {
    const { type, name, realName, cpf, birthDate, group, city, phone, terms, healthConsent } = req.body;
    const termsAccepted = !!terms;
    const healthAccepted = !!healthConsent;
    if (!type || !name || !cpf || !termsAccepted || !healthAccepted) {
      req.session.flash = { type: 'error', message: 'Preencha os campos obrigatórios e aceite os termos (responsabilidade e saúde).' };
      return res.redirect('/inscricao');
    }

    // Validações
    const cpfDigits = onlyDigits(cpf);
    if (!isValidCPF(cpfDigits)) {
      req.session.flash = { type: 'error', message: 'CPF inválido. Verifique e tente novamente.' };
      return res.redirect('/inscricao');
    }
    if (phone && !isValidPhone(phone)) {
      req.session.flash = { type: 'error', message: 'Telefone inválido. Use apenas números com DDD.' };
      return res.redirect('/inscricao');
    }
    const parsedBirth = birthDate ? parseBirthDate(birthDate) : null;
    if (birthDate && !parsedBirth) {
      req.session.flash = { type: 'error', message: 'Data de nascimento inválida. Use DD/MM/AAAA.' };
      return res.redirect('/inscricao');
    }
    const cleanRealName = realName && typeof realName === 'string' ? realName.trim() : null;

    const existing = await Registration.findOne({ where: { cpf: cpfDigits } });
    if (existing) {
      // Atualiza a inscrição existente com os dados NOVOS mais recentes (evita perda de correção de nome/cidade etc)
      // Apenas atualiza campos textuais/opcionais; NÃO sobrescreve amount, paymentStatus, paidOrder
      let dirty = false;
      const assignIfChanged = (field, newValue) => {
        const prev = existing[field];
        const normPrev = (prev === undefined || prev === null) ? null : (typeof prev === 'string' ? prev.trim() : prev);
        const normNew = (newValue === undefined || newValue === null) ? null : (typeof newValue === 'string' ? newValue.trim() : newValue);
        if (normPrev !== normNew && normNew !== null && normNew !== '') {
          existing[field] = newValue;
          dirty = true;
        }
      };
      if (type) assignIfChanged('type', type);
      if (name) assignIfChanged('name', name);
      assignIfChanged('realName', cleanRealName);
      assignIfChanged('group', group);
      assignIfChanged('city', city);
      assignIfChanged('phone', phone ? onlyDigits(phone) : null);
      if (parsedBirth) assignIfChanged('birthDate', parsedBirth.dateISO);
      if (dirty) await existing.save();

      if (existing.paymentStatus === 'pending') {
        if (existing.type === 'ATLETA' && await hasReachedAthleteLimit()) {
          return res.render('inscricao_encerrada', { layout: 'main', activeNav: 'inscricao', limitAtletas: true });
        }
        req.session.flash = { type: 'info', message: (dirty ? 'Seus dados foram atualizados. Prossiga com o pagamento abaixo.' : 'Você já iniciou uma inscrição com este CPF. Prossiga com o pagamento abaixo.') };
        return res.redirect(`/inscricao/pagamento/${existing.id}`);
      }
      req.session.flash = { type: 'info', message: dirty ? 'Dados atualizados. Sua inscrição já está paga; veja seu cartão abaixo.' : 'Você já possui uma inscrição paga com este CPF.' };
      return res.redirect(`/inscricao/card/${existing.id}`);
    }

    if (type === 'ATLETA' && await hasReachedAthleteLimit()) {
      return res.render('inscricao_encerrada', { layout: 'main', activeNav: 'inscricao', limitAtletas: true });
    }

    const amount = calcAmount(type);
    const reg = await Registration.create({
      type,
      name,
      realName: cleanRealName || null,
      cpf: cpfDigits,
      birthDate: parsedBirth ? parsedBirth.dateISO : null,
      group,
      city,
      phone: onlyDigits(phone),
      termsAccepted,
      amount,
      paymentStatus: 'pending',
    });
    req.session.flash = { type: 'info', message: 'Dados enviados para o banco de dados. Faça o pagamento para confirmar sua inscrição.' };
    return res.redirect(`/inscricao/pagamento/${reg.id}`);
  } catch (err) {
    console.error('Erro ao submeter inscrição:', err);
    req.session.flash = { type: 'error', message: 'Erro ao processar inscrição.' };
    return res.redirect('/inscricao');
  }
}

const submitWithUpload = [uploadInline.single('avatar'), async (req, res) => {
  try {
    const { type, name, realName, cpf, birthDate, group, city, phone, terms, healthConsent } = req.body;
    if (!req.file) {
      req.session.flash = { type: 'error', message: 'Envie uma foto para concluir a inscrição.' };
      return res.redirect('/inscricao');
    }
    const termsAccepted = !!terms;
    const healthAccepted = !!healthConsent;
    if (!type || !name || !cpf || !termsAccepted || !healthAccepted) {
      req.session.flash = { type: 'error', message: 'Preencha os campos obrigatórios e aceite os termos (responsabilidade e saúde).' };
      return res.redirect('/inscricao');
    }

    // Validações
    const cpfDigits = onlyDigits(cpf);
    if (!isValidCPF(cpfDigits)) {
      req.session.flash = { type: 'error', message: 'CPF inválido. Verifique e tente novamente.' };
      return res.redirect('/inscricao');
    }
    if (phone && !isValidPhone(phone)) {
      req.session.flash = { type: 'error', message: 'Telefone inválido. Use apenas números com DDD.' };
      return res.redirect('/inscricao');
    }
    const parsedBirth = birthDate ? parseBirthDate(birthDate) : null;
    if (birthDate && !parsedBirth) {
      req.session.flash = { type: 'error', message: 'Data de nascimento inválida. Use DD/MM/AAAA.' };
      return res.redirect('/inscricao');
    }
    const cleanRealName = realName && typeof realName === 'string' ? realName.trim() : null;

    const existing = await Registration.findOne({ where: { cpf: cpfDigits } });
    if (existing) {
      // Mesmo fluxo: atualiza campos textuais/opcionais; NÃO apaga avatar existente se já existia um
      let dirty = false;
      const assignIfChanged = (field, newValue) => {
        const prev = existing[field];
        const normPrev = (prev === undefined || prev === null) ? null : (typeof prev === 'string' ? prev.trim() : prev);
        const normNew = (newValue === undefined || newValue === null) ? null : (typeof newValue === 'string' ? newValue.trim() : newValue);
        if (normPrev !== normNew && normNew !== null && normNew !== '') {
          existing[field] = newValue;
          dirty = true;
        }
      };
      if (type) assignIfChanged('type', type);
      if (name) assignIfChanged('name', name);
      assignIfChanged('realName', cleanRealName);
      assignIfChanged('group', group);
      assignIfChanged('city', city);
      assignIfChanged('phone', phone ? onlyDigits(phone) : null);
      if (parsedBirth) assignIfChanged('birthDate', parsedBirth.dateISO);
      if (!existing.avatarData || !existing.avatarPath || String(existing.avatarData || '').length < 100) {
        try {
          existing.avatarData = req.file.buffer;
          existing.avatarPath = `uploads/avatar-reg-${existing.id}.${(req.file.mimetype || '').split('/').pop() || 'jpg'}`;
          dirty = true;
        } catch (_) {}
      }
      if (dirty) await existing.save();

      if (existing.paymentStatus === 'pending') {
        if (existing.type === 'ATLETA' && await hasReachedAthleteLimit()) {
          return res.render('inscricao_encerrada', { layout: 'main', activeNav: 'inscricao', limitAtletas: true });
        }
        req.session.flash = { type: 'info', message: (dirty ? 'Dados atualizados (inclusive foto). Prossiga com o pagamento.' : 'Você já iniciou uma inscrição com este CPF. Prossiga com o pagamento abaixo.') };
        return res.redirect(`/inscricao/pagamento/${existing.id}`);
      }
      req.session.flash = { type: 'info', message: dirty ? 'Dados atualizados. Sua inscrição já está paga; veja seu cartão abaixo.' : 'Você já possui uma inscrição paga com este CPF.' };
      return res.redirect(`/inscricao/card/${existing.id}`);
    }

    if (type === 'ATLETA' && await hasReachedAthleteLimit()) {
      return res.render('inscricao_encerrada', { layout: 'main', activeNav: 'inscricao', limitAtletas: true });
    }

    const amount = calcAmount(type);
    const reg = await Registration.create({
      type,
      name,
      realName: cleanRealName || null,
      cpf: cpfDigits,
      birthDate: parsedBirth ? parsedBirth.dateISO : null,
      group,
      city,
      phone: onlyDigits(phone),
      termsAccepted,
      amount,
      paymentStatus: 'pending',
    });

    if (req.file && req.file.buffer) {
      // Comprimir/normalizar imagem para reduzir tamanho e evitar max_allowed_packet
      let processed = req.file.buffer;
      try {
        processed = await sharp(req.file.buffer)
          .rotate()
          .resize({ width: 1024, height: 1024, fit: 'cover' })
          .toFormat('webp', { quality: 82 })
          .toBuffer();
      } catch (_) {}

      try {
        reg.avatarData = processed;
        reg.avatarPath = null; // preferir BLOB quando possível
        await reg.save();
      } catch (e) {
        console.error('Falha ao salvar avatar em BLOB:', e);
        // Fallback: salvar em disco e referenciar por caminho público
        try {
          const filename = `avatar_${reg.id}.webp`;
          const filePath = path.join(uploadDir, filename);
          fs.writeFileSync(filePath, processed);
          reg.avatarPath = path.join('uploads', 'avatars', filename).replace(/\\/g, '/');
          reg.avatarData = null;
          await reg.save();
        } catch (e2) {
          console.error('Falha ao salvar avatar no disco:', e2);
        }
      }
    }
    req.session.flash = { type: 'info', message: 'Dados enviados para o banco de dados. Faça o pagamento para confirmar sua inscrição.' };
    return res.redirect(`/inscricao/pagamento/${reg.id}`);
  } catch (err) {
    console.error('Erro ao submeter inscrição (com upload):', err);
    req.session.flash = { type: 'error', message: 'Erro ao processar inscrição.' };
    return res.redirect('/inscricao');
  }
}];

async function paymentPage(req, res) {
  try {
    const { id } = req.params;
    const reg = await Registration.findByPk(id);
    if (!reg) return res.status(404).send('Inscrição não encontrada');
    if (reg.type === 'ATLETA' && reg.paymentStatus !== 'paid' && await hasReachedAthleteLimit()) {
      return res.render('inscricao_encerrada', { layout: 'main', activeNav: 'inscricao', limitAtletas: true });
    }
    if (reg.paymentStatus === 'paid') return res.redirect(`/inscricao/card/${reg.id}`);

    // Garantir que amount esteja preenchido (registros antigos podem não ter)
    if (!reg.amount && reg.type) {
      try {
        reg.amount = calcAmount(reg.type);
        await reg.save();
      } catch (e) {
        console.warn('Falha ao ajustar amount da inscrição:', e.message);
      }
    }

    // Carregar/criar pagamento PIX
    if (!reg.mpPaymentId) {
      try {
        const payment = await createPixPayment({ amount: reg.amount, description: `Inscrição ${reg.type}`, cpf: reg.cpf, email: null });
        console.log('Pagamento PIX criado:', { id: payment?.id, status: payment?.status });
        const tx = payment.point_of_interaction?.transaction_data || {};
        reg.mpPaymentId = payment?.id ? String(payment.id) : reg.mpPaymentId;
        reg.mpQrCode = tx.qr_code || null;
        reg.mpQrCodeBase64 = tx.qr_code_base64 || null;
        reg.mpTicketUrl = tx.ticket_url || null;
        await reg.save();
      } catch (e) {
        console.warn('Falha ao criar pagamento PIX:', e.message);
        try {
          console.warn('Detalhes do erro (create):', { status: e?.status, cause: e?.cause, error: e?.error });
        } catch (_) {}
        req.session.flash = { type: 'error', message: 'Pagamento PIX indisponível no momento. Verifique MP_ACCESS_TOKEN (teste/produção) e habilite PIX.' };
      }
    } else {
      try {
        const payment = await getPaymentById(reg.mpPaymentId);
        const status = String(payment?.status || '').toLowerCase();
        const tx = payment?.point_of_interaction?.transaction_data || {};
        if (['expired', 'cancelled', 'rejected', 'refunded', 'charged_back'].includes(status)) {
          const newPayment = await createPixPayment({ amount: reg.amount, description: `Inscrição ${reg.type}`, cpf: reg.cpf, email: null });
          const ntx = newPayment?.point_of_interaction?.transaction_data || {};
          reg.mpPaymentId = newPayment?.id ? String(newPayment.id) : reg.mpPaymentId;
          reg.mpQrCode = ntx.qr_code || null;
          reg.mpQrCodeBase64 = ntx.qr_code_base64 || null;
          reg.mpTicketUrl = ntx.ticket_url || null;
          await reg.save();
        } else {
          reg.mpQrCode = tx.qr_code || reg.mpQrCode || null;
          reg.mpQrCodeBase64 = tx.qr_code_base64 || reg.mpQrCodeBase64 || null;
          reg.mpTicketUrl = tx.ticket_url || reg.mpTicketUrl || null;
          await reg.save();
        }
      } catch (e) {
        try {
          console.warn('Falha ao carregar/criar pagamento PIX:', e.message);
          console.warn('Detalhes:', { status: e?.status, cause: e?.cause, error: e?.error });
        } catch (_) {}
      }
    }

    const viewReg = reg?.get ? reg.get({ plain: true }) : reg;
    const displayAmount = viewReg?.amount != null ? Number(viewReg.amount).toFixed(2).replace('.', ',') : '';
    const greetingNameRaw = String(viewReg.realName || viewReg.name || '').trim();
    const cardNameRaw = String(viewReg.name || '').trim();
    const greetingName = greetingNameRaw;
    const showCardNameSub = !!viewReg.realName && (greetingNameRaw !== cardNameRaw);
    const cardNameSub = cardNameRaw;
    res.render('inscricao_pagamento', { reg: viewReg, displayAmount, activeNav: 'inscricao', greetingName, showCardNameSub, cardNameSub });
  } catch (err) {
    console.error('Erro ao exibir pagamento:', err);
    res.status(500).send('Erro interno');
  }
}

async function webhook(req, res) {
  try {
    // Suportar diferentes formatos do webhook: query.id, body.data.id, body.id, body.resource
    let id = req.query?.id || req.body?.data?.id || req.body?.id || null;
    if (!id && req.body?.resource) {
      const m = String(req.body.resource).match(/\/payments\/(\d+)/);
      if (m) id = m[1];
    }
    if (!id) return res.status(400).send('ID ausente');
    const payment = await getPaymentById(id);
    if (String(payment?.status || '').toLowerCase() === 'approved') {
      const mpId = String(payment.id);
      let reg = await Registration.findOne({ where: { mpPaymentId: mpId } });
      if (!reg) {
        const cpfRaw = payment?.payer?.identification?.number || '';
        const cpfDigits = onlyDigits(String(cpfRaw));
        if (cpfDigits) {
          reg = await Registration.findOne({ where: { cpf: cpfDigits } });
          if (reg) {
            reg.mpPaymentId = mpId;
          }
        }
      }
      if (reg) {
        reg.paymentStatus = 'paid';
        await reg.save();
        await assignPaidOrderIfNeeded(reg);
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook erro:', err);
    res.sendStatus(500);
  }
}

// Endpoint de status para polling do front-end
async function paymentStatus(req, res) {
  try {
    const { id } = req.params;
    const reg = await Registration.findByPk(id);
    if (!reg) return res.status(404).json({ error: 'Inscrição não encontrada' });

    // Fallback: se ainda estiver pendente e houver mpPaymentId, consultar status no Mercado Pago
    if (reg.paymentStatus !== 'paid' && reg.mpPaymentId) {
      try {
        const payment = await getPaymentById(reg.mpPaymentId);
        if (payment?.status === 'approved') {
          reg.paymentStatus = 'paid';
          await reg.save();
          await assignPaidOrderIfNeeded(reg);
        }
      } catch (e) {
        // silencioso; manter pending 
      }
    }

    return res.json({ id: reg.id, status: reg.paymentStatus });
  } catch (err) {
    console.error('Erro ao obter status de pagamento:', err);
    return res.status(500).json({ error: 'Erro interno' });
  }
}
async function avatarPage(req, res) {
  try {
    const { id } = req.params;
    const reg = await Registration.findByPk(id);
    if (!reg) return res.status(404).send('Inscrição não encontrada');
    if (reg.paymentStatus !== 'paid') return res.redirect(`/inscricao/pagamento/${reg.id}`);
    return res.redirect(`/inscricao/card/${reg.id}`);
  } catch (err) {
    res.status(500).send('Erro interno');
  }
}

const uploadAvatar = [upload.single('avatar'), async (req, res) => {
  try {
    const { id } = req.params;
    const reg = await Registration.findByPk(id);
    if (!reg) return res.status(404).send('Inscrição não encontrada');
    if (reg.paymentStatus !== 'paid') return res.redirect(`/inscricao/pagamento/${reg.id}`);
    if (req.file && req.file.buffer) {
      let processed = req.file.buffer;
      try {
        processed = await sharp(processed)
          .rotate()
          .resize({ width: 1024, height: 1024, fit: 'cover' })
          .toFormat('webp', { quality: 82 })
          .toBuffer();
      } catch (_) {}
      reg.avatarData = processed;
      reg.avatarPath = null;
      await reg.save();
      req.session.flash = { type: 'success', message: 'Imagem atualizada com sucesso.' };
    } else {
      req.session.flash = { type: 'error', message: 'Selecione uma imagem válida.' };
    }
    return res.redirect(`/inscricao/card/${reg.id}`);
  } catch (err) {
    req.session.flash = { type: 'error', message: 'Falha ao enviar imagem.' };
    return res.redirect(`/inscricao/card/${req.params.id}`);
  }
}];

async function cardPage(req, res) {
  try {
    const { id } = req.params;
    const reg = await Registration.findByPk(id);
    if (!reg) return res.status(404).send('Inscrição não encontrada');
    if (reg.paymentStatus !== 'paid') return res.redirect(`/inscricao/pagamento/${reg.id}`);
  const medalCutoff = Number(process.env.MEDAL_CUTOFF || 300);
  // Apenas ATLETA recebe placa e pode ser elegível à medalha
  const viewReg = reg?.get ? reg.get({ plain: true }) : reg;
  const isAthlete = viewReg.type === 'ATLETA';
  const paidOrder = isAthlete && viewReg.paidOrder ? Number(viewReg.paidOrder) : null;
  const medalEligible = isAthlete && paidOrder != null && paidOrder <= medalCutoff;
  const paidOrderStr = paidOrder != null ? String(paidOrder).padStart(3, '0') : null;
  const cardInfo = {
    paidOrder,
    paidOrderStr,
    medalEligible,
    medalCutoff,
  };
    res.render('inscricao_card', { reg: viewReg, cardInfo, activeNav: 'inscricao' });
  } catch (err) {
    console.error('Erro card:', err);
    res.status(500).send('Erro interno');
  }
}

// Endpoint JSON com dados básicos do card
async function cardData(req, res) {
  try {
    const { id } = req.params;
    const reg = await Registration.findByPk(id);
    if (!reg) return res.status(404).json({ error: 'Inscrição não encontrada' });
    if (reg.paymentStatus !== 'paid') return res.status(403).json({ error: 'Pagamento não confirmado' });
    const payload = {
      id: reg.id,
      name: reg.name || '',
      group: reg.group || '',
      city: reg.city || '',
      type: reg.type || '',
    };
    return res.json(payload);
  } catch (err) {
    console.error('Erro ao obter cardData:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
}
async function composeCard(reg) {
  const bgPath = path.join(__dirname, '..', '..', 'public', 'img', 'moldeCard.png');
  const meta = await sharp(bgPath).metadata();
  const width = meta.width || 1080;
  const height = meta.height || 1080;
  const cx = Math.round(width * 0.5);
  const cy = Math.round(height * 0.51);
  const radius = Math.round(width * 0.2915);
  const diameter = radius * 2;
  let avatarBuf = null;
  try {
    if (reg.avatarData && reg.avatarData.length) {
      avatarBuf = Buffer.isBuffer(reg.avatarData) ? reg.avatarData : Buffer.from(reg.avatarData);
    } else if (reg.avatarPath) {
      const p = path.join(__dirname, '..', '..', 'public', reg.avatarPath);
      avatarBuf = fs.readFileSync(p);
    }
  } catch (_) {}
  const overlays = [];
  if (avatarBuf) {
    const resized = await sharp(avatarBuf).rotate().resize({ width: diameter, height: diameter, fit: 'cover' }).toBuffer();
    const maskSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${diameter}" height="${diameter}"><circle cx="${Math.round(diameter / 2)}" cy="${Math.round(diameter / 2)}" r="${Math.round(diameter / 2)}" fill="#fff"/></svg>`);
    const circled = await sharp(resized).composite([{ input: maskSvg, blend: 'dest-in' }]).png().toBuffer();
    overlays.push({ input: circled, left: cx - radius, top: cy - radius });
  }
  const centerX = Math.round(width / 2);
  const nameSize = Math.round(width * 0.080);
  const groupSize = Math.round(width * 0.055);
  const citySize = Math.round(width * 0.036);
  const nameY = Math.round(height * 0.806);
  const groupY = Math.round(height * 0.862);
  const cityY = Math.round(height * 0.895);
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let nameText = String(reg.name || '').trim();
  const parts = nameText.split(/\s+/).filter(Boolean);
  nameText = parts.slice(0, 2).join(' ').toUpperCase();
  const groupText = String(reg.group || '').toUpperCase();
  const cityText = String(reg.city || '').toUpperCase();
  const textSvg = Buffer.from(`
      <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
        <style>
          .t { fill:#0e5af0; font-family: \"Bebas Neue Cyrillic\",\"Bebas Neue\", Arial, sans-serif; font-weight: 400; text-anchor: middle; dominant-baseline: alphabetic; }
        </style>
        ${nameText ? `<text x="${centerX}" y="${nameY}" class="t" font-size="${nameSize}">${esc(nameText)}</text>` : ''}
        ${groupText ? `<text x="${centerX}" y="${groupY}" class="t" font-size="${groupSize}">${esc(groupText)}</text>` : ''}
        ${cityText ? `<text x="${centerX}" y="${cityY}" class="t" font-size="${citySize}">${esc(cityText)}</text>` : ''}
      </svg>
    `);
  overlays.push({ input: textSvg, top: 0, left: 0 });
  const out = await sharp(bgPath).composite(overlays).png().toBuffer();
  return out;
}
async function cardDownload(req, res) {
  try {
    const { id } = req.params;
    const reg = await Registration.findByPk(id);
    if (!reg) return res.status(404).send('Inscrição não encontrada');
    if (reg.paymentStatus !== 'paid') return res.redirect(`/inscricao/pagamento/${reg.id}`);
    const out = await composeCard(reg);
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="card_${reg.id}.png"`);
    return res.send(out);
  } catch (err) {
    console.error('Erro ao gerar download do card:', err);
    res.status(500).send('Erro ao gerar card');
  }
}
async function cardDownloadCanvas(req, res) {
  try {
    const { id } = req.params;
    const reg = await Registration.findByPk(id);
    if (!reg) return res.status(404).send('Inscrição não encontrada');
    if (reg.paymentStatus !== 'paid') return res.redirect(`/inscricao/pagamento/${reg.id}`);
    const dataUrl = req.body?.data || req.query?.data;
    if (!dataUrl || !String(dataUrl).startsWith('data:image/png;base64,')) return res.status(400).send('Imagem ausente');
    const base64 = String(dataUrl).split(',')[1] || '';
    const buf = Buffer.from(base64, 'base64');
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="card_${reg.id}.png"`);
    return res.send(buf);
  } catch (err) {
    res.status(500).send('Erro ao gerar card');
  }
}
// Endpoint para retornar a imagem do avatar a partir do banco (BLOB)
async function avatarData(req, res) {
  try {
    const { id } = req.params;
    const reg = await Registration.findByPk(id);
    if (!reg) return res.status(404).send('Inscrição não encontrada');
    // Preferir dado binário do banco; fallback para arquivo em disco
    if (reg.avatarData && reg.avatarData.length) {
      const buf = Buffer.isBuffer(reg.avatarData) ? reg.avatarData : Buffer.from(reg.avatarData);
      // Detectar tipo de imagem por assinatura
      let mime = 'application/octet-stream';
      if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
        mime = 'image/png';
      } else if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xD8) {
        mime = 'image/jpeg';
      } else if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
        mime = 'image/gif';
      } else if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        mime = 'image/webp';
      }
      res.set('Content-Type', mime);
      return res.send(buf);
    }
    if (reg.avatarPath) {
      const filePath = path.join(__dirname, '..', '..', 'public', reg.avatarPath);
      try {
        const buf = fs.readFileSync(filePath);
        res.set('Content-Type', 'image/png');
        return res.send(buf);
      } catch (e) {
        // continua para 404
      }
    }
    return res.status(404).send('Avatar não encontrado');
  } catch (err) {
    console.error('Erro ao obter avatarData:', err);
    res.status(500).send('Erro interno');
  }
}

// Consulta por CPF para decidir o fluxo (inscrição/pagamento/card)
async function lookupByCpf(req, res) {
  try {
    const raw = req.body?.cpf || req.query?.cpf;
    const cpfDigits = onlyDigits(raw);
    if (!cpfDigits) return res.status(400).json({ error: 'CPF ausente' });
    if (!isValidCPF(cpfDigits)) return res.status(400).json({ error: 'CPF inválido' });

    const reg = await Registration.findOne({ where: { cpf: cpfDigits } });
    if (!reg) return res.json({ found: false });
    return res.json({ found: true, id: reg.id, paymentStatus: reg.paymentStatus });
  } catch (err) {
    console.error('Erro na lookupByCpf:', err);
    return res.status(500).json({ error: 'Erro interno' });
  }
}

module.exports = { formPage, submit, submitWithUpload, paymentPage, webhook, paymentStatus, avatarPage, uploadAvatar, cardPage, avatarData, cardData, cardDownload, cardDownloadCanvas, lookupByCpf, composeCard, assignPaidOrderIfNeeded, parseBirthDate };
