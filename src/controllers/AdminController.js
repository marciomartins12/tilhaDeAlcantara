const bcrypt = require('bcrypt');
const { sequelize } = require('../models');
const Registration = require('../models/Registration');
const AdminUser = require('../models/AdminUser');
const { composeCard, assignPaidOrderIfNeeded, parseBirthDate } = require('./RegistrationController');

function isAdmin(req) {
  return !!req.session?.admin && req.session.admin.role === 'ADMIN';
}
function isDesign(req) {
  return !!req.session?.admin && req.session.admin.role === 'DESIGN';
}

function resolveTz(rawTz) {
  if (!rawTz) return null;
  const tz = String(rawTz).trim();
  if (!tz) return null;
  // Offsets (ex: -03:00, UTC-3, GMT-3) não são IANA válidos; mapear mais comuns do Brasil ou fallback
  if (/^UTC|^GMT|^[+-]\d{1,2}/i.test(tz)) {
    if (/[-−]0?3:?00$/i.test(tz) || /GMT[-−]0?3/i.test(tz) || /UTC[-−]0?3/i.test(tz)) {
      return 'America/Sao_Paulo';
    }
    if (/[-−]0?4:?00$/i.test(tz)) {
      return 'America/Manaus';
    }
    if (/-0?2:?00$/i.test(tz)) {
      return 'America/Noronha';
    }
    return null;
  }
  // Validar IANA tentando construir um DateTimeFormat
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: tz });
    return tz;
  } catch (_) {
    return null;
  }
}

module.exports = {
  loginPage: (req, res) => {
    res.render('admin', { layout: 'main' });
  },
  login: async (req, res) => {
    const emailRaw = req.body?.email;
    const passwordRaw = req.body?.password;
    const email = typeof emailRaw === 'string' ? emailRaw.trim() : '';
    const password = typeof passwordRaw === 'string' ? passwordRaw : '';
    const step = { email: email || '(vazio)', bodyKeys: Object.keys(req.body || {}).join(','), sessionId: req.session?.id || 'NO_SESSION' };
    console.log('[Login] tentativa recebida:', JSON.stringify(step));
    if (!email || !password) {
      console.log('[Login] FALHOU: campos vazios');
      req.session.flash = { type: 'error', message: 'Informe e-mail e senha.' };
      return res.redirect('/admin');
    }
    try {
      const user = await AdminUser.findOne({ where: { email: email.toLowerCase() } });
      if (!user) {
        console.log('[Login] FALHOU: usuário não encontrado:', email);
        req.session.flash = { type: 'error', message: 'Credenciais inválidas.' };
        return res.redirect('/admin');
      }
      console.log('[Login] usuário encontrado:', user.email, '| role=', user.role, '| hashLen=', String(user.passwordHash || '').length);
      if (!user.passwordHash) {
        console.log('[Login] FALHOU: usuário sem passwordHash cadastrado');
        req.session.flash = { type: 'error', message: 'Credenciais inválidas.' };
        return res.redirect('/admin');
      }
      const ok = await bcrypt.compare(password, user.passwordHash);
      if (!ok) {
        console.log('[Login] FALHOU: senha incorreta para', email);
        req.session.flash = { type: 'error', message: 'Credenciais inválidas.' };
        return res.redirect('/admin');
      }
      req.session.admin = { id: user.id, email: user.email, name: user.name || user.email, role: String(user.role || 'ADMIN').toUpperCase() };
      console.log('[Login] SUCESSO. Sessão definida. Redirecionando... role=', req.session.admin.role);
      try { await new Promise(r => req.session.save(r)); } catch (_) {}
      if (req.session.admin.role === 'DESIGN') return res.redirect('/design/dashboard');
      return res.redirect('/admin/dashboard');
    } catch (err) {
      console.error('Erro de login:', err);
      req.session.flash = { type: 'error', message: 'Erro interno. Tente novamente.' };
      return res.redirect('/admin');
    }
  },
  dashboard: (req, res) => {
    if (!isAdmin(req)) {
      console.log('[Dashboard] Acesso NEGADO. req.session.admin =', req.session?.admin || 'NULO');
      req.session.flash = { type: 'error', message: 'Sessão inválida ou permissão insuficiente. Faça login novamente.' };
      return res.redirect('/admin');
    }
    console.log('[Dashboard] Acesso liberado para', req.session.admin.email, 'role=', req.session.admin.role);
    res.render('admin_dashboard', { layout: 'main', admin: req.session.admin });
  },
  registrationsList: async (req, res) => {
    try {
      if (!isAdmin(req)) return res.redirect('/admin');
      const { Op } = require('sequelize');
      const { name, cpf, city, group, status } = req.query || {};
      const where = {};
      if (name && String(name).trim()) {
        const needle = `%${String(name).trim()}%`;
        where[Op.or] = [{ name: { [Op.like]: needle } }, { realName: { [Op.like]: needle } }];
      }
      if (cpf && String(cpf).trim()) where.cpf = { [Op.like]: `%${String(cpf).trim()}%` };
      if (city && String(city).trim()) where.city = { [Op.like]: `%${String(city).trim()}%` };
      if (group && String(group).trim()) where.group = { [Op.like]: `%${String(group).trim()}%` };
      if (status && (status === 'paid' || status === 'pending')) where.paymentStatus = status;
      // Ordenar por número da placa (paidOrder) com nulos por último
      const regs = await Registration.findAll({
        where,
        order: [
          [sequelize.literal('ISNULL(paidOrder)'), 'ASC'],
          ['paidOrder', 'ASC'],
          ['createdAt', 'ASC']
        ]
      });
      const normalized = regs.map((r) => {
        const p = r?.get ? r.get({ plain: true }) : r;
        const createdAtStr = p.createdAt?.toLocaleString?.('pt-BR') || String(p.createdAt || '');
        const isPaid = p.paymentStatus === 'paid';
        const paidOrderRaw = p.type === 'ATLETA' ? (p.paidOrder || null) : null;
        const paidOrderStr = (() => {
          const po = p.type === 'ATLETA' ? Number(p.paidOrder) : NaN;
          if (!Number.isFinite(po)) return '';
          const capped = Math.min(po, 999);
          return String(capped).padStart(3, '0');
        })();
        const rawName = String(p.name || '').trim();
        const rawReal = String(p.realName || '').trim();
        const displayName = rawReal && rawReal !== rawName ? rawReal : (rawName || '');
        const displayNameSmall = rawReal && rawReal !== rawName ? rawName : '';
        return {
          id: p.id,
          name: p.name,
          realName: p.realName,
          displayName,
          displayNameSmall,
          cpf: p.cpf,
          type: p.type,
          city: p.city,
          group: p.group,
          phone: p.phone,
          amount: p.amount,
          paymentStatus: p.paymentStatus,
          paymentConfirmedBy: p.paymentConfirmedBy || '',
          paymentConfirmedAt: p.paymentConfirmedAt ? p.paymentConfirmedAt.toLocaleString?.('pt-BR') : '',
          createdAt: createdAtStr,
          isPaid,
          paidOrder: paidOrderRaw,
          paidOrderStr,
        };
      });
      const filters = { name, cpf, city, group, status, statusIsPending: status === 'pending', statusIsPaid: status === 'paid' };
      res.render('admin_registrations', { layout: 'main', regs: normalized, filters });
    } catch (e) {
      console.error('Erro ao listar inscrições:', e);
      req.session.flash = { type: 'error', message: 'Falha ao carregar inscrições.' };
      return res.redirect('/admin');
    }
  },
  registrationsConfirm: async (req, res) => {
    try {
      if (!isAdmin(req)) return res.redirect('/admin');
      const { id } = req.params;
      const reg = await Registration.findByPk(id);
      if (!reg) return res.status(404).send('Inscrição não encontrada');
      const confirmedAt = new Date();
      const confirmedBy = req.session.admin.name || req.session.admin.email;
      reg.paymentStatus = 'paid';
      reg.paymentConfirmedBy = confirmedBy;
      reg.paymentConfirmedAt = confirmedAt;
      await reg.save();
      await assignPaidOrderIfNeeded(reg.id, { paymentConfirmedAt: confirmedAt, paymentConfirmedBy: confirmedBy });
      req.session.flash = { type: 'success', message: 'Pagamento confirmado.' };
      return res.redirect('/admin/inscricoes');
    } catch (e) {
      console.error('Erro ao confirmar pagamento:', e);
      req.session.flash = { type: 'error', message: 'Falha ao confirmar pagamento.' };
      return res.redirect('/admin/inscricoes');
    }
  },
  profilePage: async (req, res) => {
    if (!req.session?.admin) return res.redirect('/admin');
    const admin = await AdminUser.findByPk(req.session.admin.id);
    if (!admin) return res.redirect('/admin');
    res.render('admin_profile', { layout: 'main', admin: { id: admin.id, email: admin.email, name: admin.name || '', role: (admin.role ? String(admin.role).toUpperCase() : (req.session?.admin?.role || 'ADMIN')) } });
  },
  profileUpdate: async (req, res) => {
    try {
      if (!req.session?.admin) return res.redirect('/admin');
      const admin = await AdminUser.findByPk(req.session.admin.id);
      if (!admin) return res.redirect('/admin');

      const { name, currentPassword, newPassword, confirmPassword } = req.body;

      // Atualizar nome se fornecido
      if (typeof name === 'string') {
        const trimmed = String(name).trim();
        admin.name = trimmed || admin.name;
      }

      // Troca de senha: validar campos se algum foi informado
      const wantsPasswordChange = !!(newPassword || confirmPassword || currentPassword);
      if (wantsPasswordChange) {
        if (!currentPassword || !newPassword || !confirmPassword) {
          req.session.flash = { type: 'error', message: 'Preencha todos os campos de senha.' };
          return res.redirect('/admin/perfil');
        }
        const ok = await bcrypt.compare(currentPassword, admin.passwordHash);
        if (!ok) {
          req.session.flash = { type: 'error', message: 'Senha atual inválida.' };
          return res.redirect('/admin/perfil');
        }
        if (String(newPassword) !== String(confirmPassword)) {
          req.session.flash = { type: 'error', message: 'Nova senha e confirmação não coincidem.' };
          return res.redirect('/admin/perfil');
        }
        if (String(newPassword).length < 6) {
          req.session.flash = { type: 'error', message: 'A nova senha deve ter pelo menos 6 caracteres.' };
          return res.redirect('/admin/perfil');
        }
        admin.passwordHash = await bcrypt.hash(String(newPassword), 10);
      }

      await admin.save();

      // Atualizar sessão para refletir nome
      req.session.admin = { id: admin.id, email: admin.email, name: admin.name || admin.email, role: String(admin.role || req.session.admin.role).toUpperCase() };

      req.session.flash = { type: 'success', message: wantsPasswordChange ? 'Perfil atualizado e senha alterada.' : 'Perfil atualizado.' };
      return res.redirect('/admin/perfil');
    } catch (e) {
      console.error('Erro ao atualizar perfil:', e);
      req.session.flash = { type: 'error', message: 'Falha ao atualizar perfil.' };
      return res.redirect('/admin/perfil');
    }
  },
  registrationsCancel: async (req, res) => {
    try {
      if (!isAdmin(req)) return res.redirect('/admin');
      const { id } = req.params;
      const { sequelize } = require('../models');
      const { Op } = require('sequelize');
      const medalCutoffRaw = process.env.MEDAL_CUTOFF;
      const medalCutoff = medalCutoffRaw ? Number(medalCutoffRaw) : undefined;
      const tx = await sequelize.transaction();

      try {
        const reg = await Registration.findByPk(id, { transaction: tx });
        if (!reg) {
          await tx.rollback();
          return res.status(404).send('Inscrição não encontrada');
        }

        const wasPaid = reg.paymentStatus === 'paid';
        const wasAthlete = reg.type === 'ATLETA';
        const vacatedOrder = wasPaid && wasAthlete && Number.isFinite(Number(reg.paidOrder)) ? Number(reg.paidOrder) : null;

        // Remover a inscrição
        await reg.destroy({ transaction: tx });

        // Compactar ordem das placas: todos os atletas pagos acima da placa vaga
        // devem ser deslocados -1 (ex: cancelar 001 => 002 vira 001, 003 vira 002, ...)
        let shiftedCount = 0;
        if (vacatedOrder != null) {
          const [affected] = await Registration.update(
            { paidOrder: sequelize.literal('paidOrder - 1') },
            { where: { paymentStatus: 'paid', type: 'ATLETA', paidOrder: { [Op.gt]: vacatedOrder } }, transaction: tx }
          );
          shiftedCount = affected || 0;
        }

        await tx.commit();

        const placaStr = vacatedOrder != null ? String(Math.min(vacatedOrder, 999)).padStart(3, '0') : null;
        if (vacatedOrder != null) {
          req.session.flash = { type: 'success', message: `Inscrição cancelada. Reorganizada numeração a partir da placa ${placaStr} (${shiftedCount} reajustes).` };
        } else {
          req.session.flash = { type: 'success', message: 'Inscrição cancelada e removida.' };
        }
        return res.redirect('/admin/inscricoes');
      } catch (err) {
        await tx.rollback();
        console.error('Erro ao cancelar inscrição (tx):', err);
        req.session.flash = { type: 'error', message: 'Falha ao cancelar inscrição.' };
        return res.redirect('/admin/inscricoes');
      }
    } catch (e) {
      console.error('Erro ao cancelar inscrição:', e);
      req.session.flash = { type: 'error', message: 'Falha ao cancelar inscrição.' };
      return res.redirect('/admin/inscricoes');
    }
  },
  registrationsEditPage: async (req, res) => {
    if (!isAdmin(req)) return res.redirect('/admin');
    const { id } = req.params;
    const reg = await Registration.findByPk(id);
    if (!reg) return res.status(404).send('Inscrição não encontrada');
    const viewReg = reg?.get ? reg.get({ plain: true }) : reg;
    const flags = { isATLETA: viewReg.type === 'ATLETA', isACOMPANHANTE: viewReg.type === 'ACOMPANHANTE' };
    res.render('inscricao_edit', { layout: 'main', reg: viewReg, flags });
  },
  registrationsEdit: async (req, res) => {
    try {
      if (!isAdmin(req)) return res.redirect('/admin');
      const { id } = req.params;
      const reg = await Registration.findByPk(id);
      if (!reg) return res.status(404).send('Inscrição não encontrada');
      const body = req.body || {};
      const raw = (k, fallback = null) => {
        const v = body[k];
        if (v === undefined || v === null) return fallback;
        if (typeof v === 'string') {
          const t = v.trim();
          return t === '' ? fallback : t;
        }
        return v;
      };
      const name = raw('name', reg.name);
      const realName = raw('realName', reg.realName);
      const cpf = raw('cpf', reg.cpf);
      const city = raw('city', reg.city);
      const group = raw('group', reg.group);
      const phone = raw('phone', reg.phone);
      const type = raw('type', reg.type);
      const amount = body.amount === undefined || body.amount === null || (typeof body.amount === 'string' && body.amount.trim() === '')
        ? reg.amount
        : Number(body.amount);
      const birthDateRaw = body.birthDate;

      reg.name = name;
      reg.realName = realName;
      reg.cpf = cpf;
      reg.city = city;
      reg.group = group;
      reg.phone = phone;
      reg.type = type;
      reg.amount = amount;

      if (birthDateRaw !== undefined && birthDateRaw !== null && String(birthDateRaw).trim() !== '') {
        const parsedBirth = parseBirthDate ? parseBirthDate(birthDateRaw) : null;
        if (!parsedBirth) {
          req.session.flash = { type: 'error', message: 'Data de nascimento inválida. Use DD/MM/AAAA.' };
          return res.redirect(`/admin/inscricoes/${id}/editar`);
        }
        reg.birthDate = parsedBirth.dateISO;
      } else if (birthDateRaw === '' || birthDateRaw === null) {
        reg.birthDate = null;
      }

      console.log('[Admin] Edit inscrição id=', id, 'body=', JSON.stringify({ name, realName, cpf, city, group, phone, type, amount, birthDateRaw, savedBirthDate: reg.birthDate }));
      await reg.save();
      await reg.reload();
      console.log('[Admin] Edit inscrição id=', id, 'SALVO. Dados atuais:', JSON.stringify({ name: reg.name, realName: reg.realName, cpf: reg.cpf, city: reg.city, group: reg.group, phone: reg.phone, type: reg.type, amount: reg.amount, birthDate: reg.birthDate }));
      req.session.flash = { type: 'success', message: 'Inscrição atualizada.' };
      return res.redirect('/admin/inscricoes');
    } catch (e) {
      console.error('Erro ao atualizar inscrição:', e);
      req.session.flash = { type: 'error', message: 'Falha ao atualizar inscrição. ' + (e.message || String(e)) };
      return res.redirect('/admin/inscricoes');
    }
  },
  registrationsExportWord: async (req, res) => {
    try {
      if (!isAdmin(req)) return res.redirect('/admin');
      const { Op } = require('sequelize');
      // Exportar somente ATLETA pagos (ACOMPANHANTE não recebe placa nem medalha)
      const regs = await Registration.findAll({ where: { paymentStatus: 'paid', type: 'ATLETA' }, order: [['paidOrder', 'ASC']] });
      const guests = await Registration.findAll({ where: { paymentStatus: 'paid', type: 'ACOMPANHANTE' }, order: [['name', 'ASC']] });
      // Mais velho e mais novo (por data de nascimento) — apenas atletas pagos com birthDate preenchido
      const oldestAthlete = await Registration.findOne({
        where: { paymentStatus: 'paid', type: 'ATLETA', birthDate: { [Op.ne]: null } },
        order: [['birthDate', 'ASC']]
      });
      const newestAthlete = await Registration.findOne({
        where: { paymentStatus: 'paid', type: 'ATLETA', birthDate: { [Op.ne]: null } },
        order: [['birthDate', 'DESC']]
      });
      const ageExtremes = [];
      const calcAge = (d) => {
        if (!d) return null;
        const bd = new Date(d);
        if (Number.isNaN(bd.getTime())) return null;
        const now = new Date();
        let a = now.getFullYear() - bd.getFullYear();
        const m = now.getMonth() - bd.getMonth();
        if (m < 0 || (m === 0 && now.getDate() < bd.getDate())) a--;
        return a;
      };
      const formatBrDate = (d) => {
        if (!d) return '';
        const bd = new Date(d);
        if (Number.isNaN(bd.getTime())) return '';
        const dd = String(bd.getDate()).padStart(2, '0');
        const mm = String(bd.getMonth() + 1).padStart(2, '0');
        const yy = bd.getFullYear();
        return `${dd}/${mm}/${yy}`;
      };
      if (oldestAthlete) ageExtremes.push({ label: 'Mais Velho', r: oldestAthlete });
      // Evitar duplicado se só houver 1 atleta
      if (newestAthlete && (!oldestAthlete || Number(newestAthlete.id) !== Number(oldestAthlete.id))) {
        ageExtremes.push({ label: 'Mais Novo', r: newestAthlete });
      }
      
      // Export simples para Word: sem imagens, somente tabela.
      // Helper para escapar HTML
      const esc = (s) => String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

      const nameCols = (r) => {
        const fullName = String(r.realName || '').trim() || String(r.name || '').trim();
        const cardName = String(r.name || '').trim();
        return { fullName, cardName };
      };

      const rows = regs.map((r) => {
        const po = Number(r.paidOrder);
        const placa = Number.isFinite(po) ? String(Math.min(po, 999)).padStart(3, '0') : '';
        const { fullName, cardName } = nameCols(r);
        return `
        <tr>
          <td>${placa}</td>
          <td>${esc(fullName)}</td>
          <td>${esc(cardName)}</td>
          <td>${esc(r.cpf)}</td>
          <td>${esc(r.city)}</td>
          <td>${esc(r.group)}</td>
          <td>${esc(r.phone)}</td>
        </tr>
      `; }).join('');

      let guestRows = '';
      if (guests.length > 0) {
        guestRows += `
          <tr>
            <td colspan="7" style="background-color:#f0f0f0;font-weight:bold;text-align:center;">ACOMPANHANTES PAGOS</td>
          </tr>
        `;
        guestRows += guests.map((r) => {
          const { fullName, cardName } = nameCols(r);
          return `
          <tr>
            <td>-</td>
            <td>${esc(fullName)}</td>
            <td>${esc(cardName)}</td>
            <td>${esc(r.cpf)}</td>
            <td>${esc(r.city)}</td>
            <td>${esc(r.group)}</td>
            <td>${esc(r.phone)}</td>
          </tr>
        `; }).join('');
      }

      // Nova tabela: atleta mais velho e mais novo
      let ageTableHtml = '';
      if (ageExtremes.length > 0) {
        const ageRows = ageExtremes.map(({ label, r }) => {
          const po = Number(r.paidOrder);
          const placa = Number.isFinite(po) ? String(Math.min(po, 999)).padStart(3, '0') : '';
          const { fullName, cardName } = nameCols(r);
          const age = calcAge(r.birthDate);
          const ageStr = age == null ? '—' : `${age} anos`;
          return `
            <tr>
              <td style="font-weight:bold;background-color:#fff5d7;text-align:center;">${esc(label)}</td>
              <td>${placa}</td>
              <td>${esc(fullName)}</td>
              <td>${esc(cardName)}</td>
              <td>${esc(formatBrDate(r.birthDate))}</td>
              <td style="text-align:center;">${esc(ageStr)}</td>
              <td>${esc(r.city)}</td>
            </tr>`;
        }).join('');
        ageTableHtml = `
          <br/>
          <h2>Mais Velho e Mais Novo (Atletas Pagos)</h2>
          <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%">
            <thead>
              <tr>
                <th>Classificação</th>
                <th>Placa</th>
                <th>Nome Completo</th>
                <th>Nome no Cartão</th>
                <th>Data de Nascimento</th>
                <th>Idade</th>
                <th>Cidade</th>
              </tr>
            </thead>
            <tbody>
              ${ageRows}
            </tbody>
          </table>
        `;
      }

      const now = new Date();
      const title = `Lista de Inscritos Pagos - ${now.toLocaleDateString('pt-BR')} ${now.toLocaleTimeString('pt-BR')}`;
      const html = `<html>
        <head>
          <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
          <title>${esc(title)}</title>
        </head>
        <body>
        <h1>Lista de inscritos pagos</h1>
          <p>Total Atletas: ${regs.length} | Total Acompanhantes: ${guests.length} | Exportado em ${esc(now.toLocaleString('pt-BR'))}</p>
          <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%">
            <thead>
              <tr>
                <th>Placa</th>
                <th>Nome Completo</th>
                <th>Nome no Cartão</th>
                <th>CPF</th>
                <th>Cidade</th>
                <th>Grupo</th>
                <th>Telefone</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
              ${guestRows}
            </tbody>
          </table>
          ${ageTableHtml}
        </body>
      </html>`;
      const bom = Buffer.from('\ufeff', 'utf8');
      const body = Buffer.from(html, 'utf8');
      const payload = Buffer.concat([bom, body]);
      res.set('X-No-Compression', '1');
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
      res.set('Pragma', 'no-cache');
      res.type('application/msword');
      res.attachment('inscritos-pagos.doc');
      return res.send(payload);
    } catch (e) {
      console.error('Erro ao exportar Word:', e);
      try {
        if (req.session) {
          req.session.flash = { type: 'error', message: 'Falha ao exportar lista. ' + (e.message || '') };
          await new Promise(r => req.session.save(r));
        }
      } catch (_) {}
      return res.redirect('/admin/inscricoes');
    }
  },
  registrationsExportDocx: async (req, res) => {
    try {
      if (!isAdmin(req)) return res.redirect('/admin');
      const { Op } = require('sequelize');
      const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, AlignmentType, HeadingLevel, WidthType, BorderStyle } = require('docx');
      // Exportar somente ATLETA pagos
      const regs = await Registration.findAll({ where: { paymentStatus: 'paid', type: 'ATLETA' }, order: [['paidOrder', 'ASC']] });
      const guests = await Registration.findAll({ where: { paymentStatus: 'paid', type: 'ACOMPANHANTE' }, order: [['name', 'ASC']] });
      // Mais velho e mais novo (por data de nascimento) — apenas atletas pagos com birthDate preenchido
      const oldestAthlete = await Registration.findOne({
        where: { paymentStatus: 'paid', type: 'ATLETA', birthDate: { [Op.ne]: null } },
        order: [['birthDate', 'ASC']]
      });
      const newestAthlete = await Registration.findOne({
        where: { paymentStatus: 'paid', type: 'ATLETA', birthDate: { [Op.ne]: null } },
        order: [['birthDate', 'DESC']]
      });
      const ageExtremes = [];
      const calcAge = (d) => {
        if (!d) return null;
        const bd = new Date(d);
        if (Number.isNaN(bd.getTime())) return null;
        const now = new Date();
        let a = now.getFullYear() - bd.getFullYear();
        const m = now.getMonth() - bd.getMonth();
        if (m < 0 || (m === 0 && now.getDate() < bd.getDate())) a--;
        return a;
      };
      const formatBrDate = (d) => {
        if (!d) return '';
        const bd = new Date(d);
        if (Number.isNaN(bd.getTime())) return '';
        const dd = String(bd.getDate()).padStart(2, '0');
        const mm = String(bd.getMonth() + 1).padStart(2, '0');
        const yy = bd.getFullYear();
        return `${dd}/${mm}/${yy}`;
      };
      if (oldestAthlete) ageExtremes.push({ label: 'Mais Velho', r: oldestAthlete });
      if (newestAthlete && (!oldestAthlete || Number(newestAthlete.id) !== Number(oldestAthlete.id))) {
        ageExtremes.push({ label: 'Mais Novo', r: newestAthlete });
      }
      
      const now = new Date();
      const tz = resolveTz(process.env.TIMEZONE);
      const dtOptions = tz ? { timeZone: tz, dateStyle: 'short', timeStyle: 'short' } : { dateStyle: 'short', timeStyle: 'short' };
      const exportedAt = new Intl.DateTimeFormat('pt-BR', dtOptions).format(now);
      const medalCutoffRaw = process.env.MEDAL_CUTOFF;
      const medalCutoff = medalCutoffRaw ? Number(medalCutoffRaw) : undefined;
      // Export DOCX sem imagens: título, informações e tabela ordenada por pagamento.

      const title = new Paragraph({
        heading: HeadingLevel.HEADING_1,
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: 'Lista de inscritos pagos', bold: true, size: 32 })]
      });

      const meta = new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            text: `Total Atletas: ${regs.length} | Total Acompanhantes: ${guests.length} | Exportado em ${exportedAt} — ${medalCutoff ? `Medalhas: placas 001 a ${String(medalCutoff).padStart(3, '0')}` : 'Medalhas: corte não definido'}`,
            color: '666666',
            size: 20
          })
        ]
      });

      const nameCols = (r) => {
        const fullName = String(r.realName || '').trim() || String(r.name || '').trim();
        const cardName = String(r.name || '').trim();
        return { fullName, cardName };
      };
      const placaText = (poRaw) => {
        const po = Number(poRaw);
        if (!Number.isFinite(po)) return '';
        const capped = Math.min(po, 999);
        return String(capped).padStart(3, '0');
      };
      const medalText = (poRaw) => {
        const po = Number(poRaw);
        if (!medalCutoff || !Number.isFinite(medalCutoff)) return '—';
        return Number.isFinite(po) && po <= medalCutoff ? 'Sim' : 'Não';
      };

      const headers = ['Placa', 'Nome Completo', 'Nome no Cartão', 'CPF', 'Cidade', 'Grupo', 'Telefone', 'Medalha'];
      const headerRow = new TableRow({
        children: headers.map((h) => new TableCell({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: h, bold: true })]
          })]
        }))
      });

      const dataRows = regs.map((r) => {
        const { fullName, cardName } = nameCols(r);
        return new TableRow({
          children: [
            new TableCell({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun(placaText(r.paidOrder))] })] }),
            new TableCell({ children: [new Paragraph({ children: [new TextRun(fullName)] })] }),
            new TableCell({ children: [new Paragraph({ children: [new TextRun(cardName)] })] }),
            new TableCell({ children: [new Paragraph({ children: [new TextRun(String(r.cpf || ''))] })] }),
            new TableCell({ children: [new Paragraph({ children: [new TextRun(String(r.city || ''))] })] }),
            new TableCell({ children: [new Paragraph({ children: [new TextRun(String(r.group || ''))] })] }),
            new TableCell({ children: [new Paragraph({ children: [new TextRun(String(r.phone || ''))] })] }),
            new TableCell({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun(medalText(r.paidOrder))] })] })
          ]
        });
      });

      const allRows = [headerRow, ...dataRows];

      if (guests.length > 0) {
        // Separador
        allRows.push(new TableRow({
          children: [
            new TableCell({
              children: [new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: 'ACOMPANHANTES PAGOS', bold: true })]
              })],
              columnSpan: 8,
              shading: { fill: 'F0F0F0' }
            })
          ]
        }));

        // Linhas de acompanhantes
        const guestRows = guests.map((r) => {
          const { fullName, cardName } = nameCols(r);
          return new TableRow({
            children: [
              new TableCell({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun('-')] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun(fullName)] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun(cardName)] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun(String(r.cpf || ''))] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun(String(r.city || ''))] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun(String(r.group || ''))] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun(String(r.phone || ''))] })] }),
              new TableCell({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun('Não')] })] })
            ]
          });
        });
        allRows.push(...guestRows);
      }

      const table = new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: allRows,
        borders: {
          top: { style: BorderStyle.SINGLE, size: 1, color: '333333' },
          bottom: { style: BorderStyle.SINGLE, size: 1, color: '333333' },
          left: { style: BorderStyle.SINGLE, size: 1, color: '333333' },
          right: { style: BorderStyle.SINGLE, size: 1, color: '333333' },
          insideVertical: { style: BorderStyle.SINGLE, size: 1, color: '999999' },
          insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: '999999' }
        }
      });

      // TABELA 2: Mais velho e mais novo
      let ageTable = null;
      let ageTitle = null;
      if (ageExtremes.length > 0) {
        ageTitle = new Paragraph({
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 360 },
          children: [new TextRun({ text: 'Mais Velho e Mais Novo (Atletas Pagos)', bold: true, size: 26 })]
        });
        const ageHeaders = ['Classificação', 'Placa', 'Nome Completo', 'Nome no Cartão', 'Data de Nascimento', 'Idade', 'Cidade'];
        const ageHeaderRow = new TableRow({
          children: ageHeaders.map((h) => new TableCell({
            children: [new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: h, bold: true })]
            })]
          }))
        });
        const ageDataRows = ageExtremes.map(({ label, r }) => {
          const { fullName, cardName } = nameCols(r);
          const age = calcAge(r.birthDate);
          const ageStr = age == null ? '—' : `${age} anos`;
          return new TableRow({
            children: [
              new TableCell({
                shading: { fill: 'FFF5D7' },
                children: [new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [new TextRun({ text: label, bold: true })]
                })]
              }),
              new TableCell({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun(placaText(r.paidOrder))] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun(fullName)] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun(cardName)] })] }),
              new TableCell({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun(formatBrDate(r.birthDate))] })] }),
              new TableCell({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun(ageStr)] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun(String(r.city || ''))] })] })
            ]
          });
        });
        ageTable = new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [ageHeaderRow, ...ageDataRows],
          borders: {
            top: { style: BorderStyle.SINGLE, size: 1, color: '333333' },
            bottom: { style: BorderStyle.SINGLE, size: 1, color: '333333' },
            left: { style: BorderStyle.SINGLE, size: 1, color: '333333' },
            right: { style: BorderStyle.SINGLE, size: 1, color: '333333' },
            insideVertical: { style: BorderStyle.SINGLE, size: 1, color: '999999' },
            insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: '999999' }
          }
        });
      }

      const children = [title];
      children.push(new Paragraph({ children: [] }));
      children.push(meta);
      children.push(new Paragraph({ children: [] }));
      children.push(table);
      if (ageTitle) {
        children.push(new Paragraph({ children: [] }));
        children.push(ageTitle);
        children.push(new Paragraph({ children: [] }));
      }
      if (ageTable) {
        children.push(ageTable);
      }

      const doc = new Document({ sections: [{ properties: {}, children }] });

      const raw = await Packer.toBuffer(doc);
      const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      res.set('X-No-Compression', '1');
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
      res.set('Pragma', 'no-cache');
      res.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.attachment('inscritos-pagos.docx');
      return res.send(buffer);
    } catch (e) {
      console.error('Erro ao exportar DOCX:', e);
      try {
        if (req.session) {
          req.session.flash = { type: 'error', message: 'Falha ao exportar lista. ' + (e.message || '') };
          await new Promise(r => req.session.save(r));
        }
      } catch (_) {}
      return res.redirect('/admin/inscricoes');
    }
  },
  registrationsFixGap: async (req, res) => {
    try {
      if (!isAdmin(req)) return res.redirect('/admin');
      const fromRaw = req.body?.from ?? req.query?.from ?? 22;
      const from = Number(fromRaw);
      if (!Number.isFinite(from) || from < 1) {
        req.session.flash = { type: 'error', message: 'Parâmetro inválido.' };
        return res.redirect('/admin/inscricoes');
      }
      const tx = await sequelize.transaction();
      try {
        const [affected] = await Registration.update(
          { paidOrder: sequelize.literal('paidOrder - 1') },
          { where: { paymentStatus: 'paid', type: 'ATLETA', paidOrder: { [require('sequelize').Op.gt]: from } }, transaction: tx }
        );
        await tx.commit();
        const placaStr = String(Math.min(from, 999)).padStart(3, '0');
        req.session.flash = { type: 'success', message: `Corrigido gap a partir da placa ${placaStr} (${affected || 0} reajustes).` };
        return res.redirect('/admin/inscricoes');
      } catch (err) {
        await tx.rollback();
        console.error('Erro ao corrigir gap de placas (tx):', err);
        req.session.flash = { type: 'error', message: 'Falha ao corrigir gap.' };
        return res.redirect('/admin/inscricoes');
      }
    } catch (e) {
      console.error('Erro ao corrigir gap de placas:', e);
      req.session.flash = { type: 'error', message: 'Falha ao corrigir gap.' };
      return res.redirect('/admin/inscricoes');
    }
  },
  kitListPage: async (req, res) => {
    try {
      if (!isAdmin(req)) return res.redirect('/admin');
      const { Op } = require('sequelize');
      const { name, cpf, plate, kit } = req.query || {};
      const where = { paymentStatus: 'paid', type: 'ATLETA' };
      if (name && String(name).trim()) {
        const needle = `%${String(name).trim()}%`;
        where[Op.and] = [
          ...(where[Op.and] || []),
          { [Op.or]: [{ name: { [Op.like]: needle } }, { realName: { [Op.like]: needle } }] }
        ];
      }
      if (cpf && String(cpf).trim()) {
        const needle = `%${String(cpf).trim()}%`;
        where[Op.and] = [...(where[Op.and] || []), { cpf: { [Op.like]: needle } }];
      }
      if (plate && String(plate).trim()) {
        const digits = String(plate).replace(/\D+/g, '');
        if (digits) {
          const n = Number(digits);
          if (Number.isFinite(n)) {
            where[Op.and] = [...(where[Op.and] || []), { paidOrder: n }];
          }
        }
      }
      const kitFilter = kit && ['received', 'pending'].includes(String(kit).toLowerCase()) ? String(kit).toLowerCase() : 'all';
      if (kitFilter === 'received') {
        where[Op.and] = [...(where[Op.and] || []), { kitReceivedAt: { [Op.ne]: null } }];
      } else if (kitFilter === 'pending') {
        where[Op.and] = [...(where[Op.and] || []), { kitReceivedAt: { [Op.is]: null } }];
      }
      const regs = await Registration.findAll({
        where,
        order: [
          [sequelize.literal('ISNULL(kitReceivedAt)'), 'DESC'],
          ['kitReceivedAt', 'ASC'],
          ['paidOrder', 'ASC']
        ]
      });
      const normalized = regs.map((r) => {
        const p = r?.get ? r.get({ plain: true }) : r;
        const rawName = String(p.name || '').trim();
        const rawReal = String(p.realName || '').trim();
        const displayName = rawReal && rawReal !== rawName ? rawReal : (rawName || '');
        const displayNameSmall = rawReal && rawReal !== rawName ? rawName : '';
        const po = Number(p.paidOrder);
        const plateStr = Number.isFinite(po) ? String(Math.min(po, 999)).padStart(3, '0') : '';
        const kitReceived = !!p.kitReceivedAt;
        const kitReceivedAtStr = p.kitReceivedAt ? new Date(p.kitReceivedAt).toLocaleString?.('pt-BR') || String(p.kitReceivedAt) : '';
        const kitReceivedBy = String(p.kitReceivedBy || '').trim();
        const kitReceivedSelf = p.kitReceivedSelf === true || p.kitReceivedSelf === 1 || p.kitReceivedSelf === '1';
        const kitDeliveredBy = String(p.kitDeliveredBy || '').trim();
        return {
          id: p.id,
          displayName, displayNameSmall, name: p.name, realName: p.realName,
          cpf: p.cpf, city: p.city, group: p.group, phone: p.phone,
          paidOrder: Number.isFinite(po) ? po : null, paidOrderStr: plateStr,
          kitReceived, kitReceivedAtStr, kitReceivedBy, kitReceivedSelf, kitDeliveredBy
        };
      });
      const total = regs.length;
      const receivedCount = normalized.filter((x) => x.kitReceived).length;
      const pendingCount = total - receivedCount;
      const filters = {
        name, cpf, plate,
        kit: kitFilter,
        kitIsAll: kitFilter === 'all',
        kitIsPending: kitFilter === 'pending',
        kitIsReceived: kitFilter === 'received'
      };
      const counters = { total, receivedCount, pendingCount, percent: total ? Math.round((receivedCount / total) * 1000) / 10 : 0 };
      res.render('admin_kits', { layout: 'main', regs: normalized, filters, counters });
    } catch (e) {
      console.error('Erro na página de kits:', e);
      req.session.flash = { type: 'error', message: 'Falha ao carregar recebimento de kits.' };
      return res.redirect('/admin/inscricoes');
    }
  },
  kitMarkReceivedSelf: async (req, res) => {
    try {
      if (!isAdmin(req)) return res.redirect('/admin');
      const { id } = req.params;
      const reg = await Registration.findByPk(id);
      if (!reg) return res.status(404).send('Inscrição não encontrada');
      if (reg.type !== 'ATLETA' || reg.paymentStatus !== 'paid') {
        req.session.flash = { type: 'error', message: 'Kit só pode ser entregue para atletas pagos.' };
        return res.redirect('/admin/kits');
      }
      const deliveredBy = req.session.admin.name || req.session.admin.email;
      reg.kitReceivedAt = new Date();
      reg.kitReceivedSelf = true;
      reg.kitReceivedBy = String(reg.realName || reg.name || '').trim();
      reg.kitDeliveredBy = deliveredBy;
      await reg.save();
      req.session.flash = { type: 'success', message: `Kit ${reg.paidOrder ? ('placa ' + String(Math.min(Number(reg.paidOrder),999)).padStart(3,'0') + ' — ' ): ''}marcado como RETIRADO (pelo próprio atleta).` };
      const qs = req.headers.referer && req.headers.referer.includes('?') ? req.headers.referer.split('?').pop() : '';
      return res.redirect('/admin/kits' + (qs ? `?${qs}` : ''));
    } catch (e) {
      console.error('Erro ao marcar kit recebido (self):', e);
      req.session.flash = { type: 'error', message: 'Falha ao marcar recebimento do kit.' };
      return res.redirect('/admin/kits');
    }
  },
  kitMarkReceivedThird: async (req, res) => {
    try {
      if (!isAdmin(req)) return res.redirect('/admin');
      const { id } = req.params;
      const reg = await Registration.findByPk(id);
      if (!reg) return res.status(404).send('Inscrição não encontrada');
      if (reg.type !== 'ATLETA' || reg.paymentStatus !== 'paid') {
        req.session.flash = { type: 'error', message: 'Kit só pode ser entregue para atletas pagos.' };
        return res.redirect('/admin/kits');
      }
      const thirdName = String(req.body?.receivedBy || req.body?.third || '').trim();
      if (!thirdName || thirdName.length < 3) {
        req.session.flash = { type: 'error', message: 'Nome da pessoa que retirou é obrigatório (mínimo 3 letras).' };
        return res.redirect(`/admin/kits`);
      }
      const deliveredBy = req.session.admin.name || req.session.admin.email;
      reg.kitReceivedAt = new Date();
      reg.kitReceivedSelf = false;
      reg.kitReceivedBy = thirdName;
      reg.kitDeliveredBy = deliveredBy;
      await reg.save();
      req.session.flash = { type: 'success', message: `Kit entregue a terceiro: ${thirdName} (por ${deliveredBy}).` };
      const qs = req.headers.referer && req.headers.referer.includes('?') ? req.headers.referer.split('?').pop() : '';
      return res.redirect('/admin/kits' + (qs ? `?${qs}` : ''));
    } catch (e) {
      console.error('Erro ao marcar kit recebido (terceiro):', e);
      req.session.flash = { type: 'error', message: 'Falha ao marcar recebimento do kit por terceiro.' };
      return res.redirect('/admin/kits');
    }
  },
  kitCancelReceived: async (req, res) => {
    try {
      if (!isAdmin(req)) return res.redirect('/admin');
      const { id } = req.params;
      const reg = await Registration.findByPk(id);
      if (!reg) return res.status(404).send('Inscrição não encontrada');
      reg.kitReceivedAt = null;
      reg.kitReceivedSelf = null;
      reg.kitReceivedBy = null;
      reg.kitDeliveredBy = null;
      await reg.save();
      req.session.flash = { type: 'info', message: 'Recebimento do kit cancelado (voltar para "não recebido").' };
      const qs = req.headers.referer && req.headers.referer.includes('?') ? req.headers.referer.split('?').pop() : '';
      return res.redirect('/admin/kits' + (qs ? `?${qs}` : ''));
    } catch (e) {
      console.error('Erro ao cancelar recebimento do kit:', e);
      req.session.flash = { type: 'error', message: 'Falha ao cancelar recebimento do kit.' };
      return res.redirect('/admin/kits');
    }
  },
  designPage: (req, res) => {
    if (!isDesign(req)) return res.redirect('/admin');
    res.render('design_download', { layout: 'main', pageTitle: 'Download de Cards' });
  },
  designDashboard: (req, res) => {
    if (!isDesign(req)) return res.redirect('/admin');
    res.render('design_dashboard', { layout: 'main', pageTitle: 'Dashboard Designer' });
  },
  designCardsData: async (req, res) => {
    try {
      if (!isDesign(req)) return res.status(403).json({ error: 'forbidden' });
      const fromRaw = req.query?.from;
      const toRaw = req.query?.to;
      const from = Number(fromRaw);
      const to = Number(toRaw);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < from) {
        return res.status(400).json({ error: 'invalid_params' });
      }
      const { Op } = require('sequelize');
      const regs = await Registration.findAll({
        where: { paymentStatus: 'paid', type: 'ATLETA', paidOrder: { [Op.between]: [from, to] } },
        order: [['paidOrder', 'ASC']]
      });
      const out = regs.map(r => ({ id: r.id, name: r.name, group: r.group, city: r.city, paidOrder: r.paidOrder }));
      return res.json({ items: out });
    } catch (e) {
      return res.status(500).json({ error: 'server_error' });
    }
  },
  designCardsStats: async (req, res) => {
    try {
      if (!isDesign(req)) return res.status(403).json({ error: 'forbidden' });
      const { fn, col } = require('sequelize');
      const rows = await Registration.findAll({
        where: { paymentStatus: 'paid', type: 'ATLETA' },
        attributes: [
          [fn('COUNT', col('*')), 'countPaid'],
          [fn('COUNT', col('paidOrder')), 'countWithOrder'],
          [fn('MIN', col('paidOrder')), 'minOrder'],
          [fn('MAX', col('paidOrder')), 'maxOrder'],
        ]
      });
      const r = rows && rows[0] && rows[0].get ? rows[0].get({ plain: true }) : (rows[0] || {});
      const countPaid = Number(r.countPaid || 0);
      const countWithOrder = Number(r.countWithOrder || 0);
      const minOrder = Number(r.minOrder || 1);
      const maxOrder = Number(r.maxOrder || 0);
      return res.json({ countPaid, countWithOrder, minOrder, maxOrder });
    } catch (e) {
      return res.status(500).json({ error: 'server_error' });
    }
  },
  usersCreatePage: (req, res) => {
    if (!isAdmin(req)) return res.redirect('/admin');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Novo usuário</title><style>body{font-family:Arial,sans-serif;padding:24px}label{display:block;margin:8px 0}input,select{padding:6px 10px;margin-right:8px;width:320px;max-width:100%}button{padding:8px 14px;background:#0e5af0;color:#fff;border:none;border-radius:4px;cursor:pointer}a{color:#0e5af0}</style></head><body><h1>Criar novo usuário</h1><form method="POST" action="/admin/usuarios/novo"><label>Nome: <input type="text" name="name" required></label><label>E-mail: <input type="email" name="email" required></label><label>Senha: <input type="password" name="password" required></label><label>Perfil: <select name="role"><option value="ADMIN">ADMIN</option><option value="DESIGN">DESIGN</option></select></label><button type="submit">Criar usuário</button></form><p><a href="/admin/dashboard">Voltar ao dashboard</a></p></body></html>`;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  },
  usersCreate: async (req, res) => {
    try {
      if (!isAdmin(req)) return res.redirect('/admin');
      const { name, email, password, role } = req.body || {};
      const r = String(role || '').toUpperCase();
      if (!name || !email || !password || !['ADMIN','DESIGN'].includes(r)) {
        req.session.flash = { type: 'error', message: 'Preencha todos os campos corretamente.' };
        return res.redirect('/admin/usuarios/novo');
      }
      const exists = await AdminUser.findOne({ where: { email } });
      if (exists) {
        req.session.flash = { type: 'error', message: 'E-mail já cadastrado.' };
        return res.redirect('/admin/usuarios/novo');
      }
      const passwordHash = await bcrypt.hash(String(password), 10);
      await AdminUser.create({ name, email, passwordHash, role: r });
      req.session.flash = { type: 'success', message: `Usuário criado com perfil ${r}.` };
      return res.redirect('/admin');
    } catch (e) {
      console.error('Erro ao criar usuário:', e);
      req.session.flash = { type: 'error', message: 'Falha ao criar usuário.' };
      return res.redirect('/admin/usuarios/novo');
    }
  },
  logout: (req, res) => {
    req.session.admin = null;
    res.redirect('/admin');
  }
};
