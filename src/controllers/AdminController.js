const bcrypt = require('bcrypt');
const { sequelize } = require('../models');
const Registration = require('../models/Registration');
const AdminUser = require('../models/AdminUser');
const { composeCard, assignPaidOrderIfNeeded, parseBirthDate, repairBrokenPaidRegistrations, diagnosePlatesAndPayments, safeSave } = require('./RegistrationController');

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
      const saveOk = await safeSave(reg);
      if (!saveOk) {
        try {
          await sequelize.query(
            "UPDATE registrations SET paymentStatus='paid', paymentConfirmedBy=?, paymentConfirmedAt=?, updatedAt=NOW() WHERE id=?",
            { replacements: [confirmedBy, confirmedAt, id] }
          );
        } catch (e3) {
          console.error('Confirmar Pagamento (fallback SQL também falhou):', e3);
        }
      }
      const assigned = await assignPaidOrderIfNeeded(reg.id, { paymentConfirmedAt: confirmedAt, paymentConfirmedBy: confirmedBy });
      const isAthlete = reg.type === 'ATLETA';
      const orderOk = !isAthlete || (assigned && Number(assigned.paidOrder) > 0);
      if (!orderOk) {
        req.session.flash = { type: 'error',
          message: 'Pagamento confirmado, mas ' + (isAthlete ? 'a placa não foi atribuída automaticamente. Verifique o Diagnóstico e execute o Reparo de Pagamentos.' : '') };
      } else {
        req.session.flash = { type: 'success',
          message: 'Pagamento confirmado' + (assigned && assigned.paidOrder ? ` (placa ${String(Math.min(Number(assigned.paidOrder), 999)).padStart(3, '0')})` : '') + '.' };
      }
      return res.redirect('/admin/inscricoes');
    } catch (e) {
      console.error('Erro ao confirmar pagamento:', e);
      req.session.flash = { type: 'error', message: 'Falha ao confirmar pagamento: ' + (e.message || String(e)) };
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
      const medalCutoffRaw = process.env.MEDAL_CUTOFF;
      const medalCutoff = medalCutoffRaw ? Number(medalCutoffRaw) : undefined;
      const tx = await sequelize.transaction({ isolationLevel: require('sequelize').Transaction.ISOLATION_LEVELS.SERIALIZABLE });

      try {
        const reg = await Registration.findByPk(id, { transaction: tx });
        if (!reg) {
          await tx.rollback();
          return res.status(404).send('Inscrição não encontrada');
        }

        const wasPaid = reg.paymentStatus === 'paid';
        const wasAthlete = reg.type === 'ATLETA';
        const vacatedOrder = wasPaid && wasAthlete && Number.isFinite(Number(reg.paidOrder)) ? Number(reg.paidOrder) : null;

        await reg.destroy({ transaction: tx });

        let shiftedCount = 0;
        if (vacatedOrder != null) {
          const [rows] = await sequelize.query(
            "SELECT id, paidOrder FROM registrations WHERE paymentStatus = 'paid' AND type = 'ATLETA' AND paidOrder > ? ORDER BY paidOrder ASC",
            { replacements: [vacatedOrder], transaction: tx }
          );
          if (rows && rows.length > 0) {
            const tmpOffset = -1000000;
            for (const row of rows) {
              await sequelize.query(
                "UPDATE registrations SET paidOrder = ?, updatedAt = NOW() WHERE id = ?",
                { replacements: [tmpOffset + Number(row.paidOrder), row.id], transaction: tx }
              );
            }
            for (const row of rows) {
              const newOrder = Number(row.paidOrder) - 1;
              const [[occ]] = await sequelize.query(
                "SELECT COUNT(*) AS c FROM registrations WHERE paidOrder = ?",
                { replacements: [newOrder], transaction: tx }
              );
              if (Number(occ?.c || 0) > 0) {
                const extra = ` (falhou ao mover id=${row.id} de paidOrder=${row.paidOrder} para ${newOrder} pois já está ocupada)`;
                await tx.rollback();
                req.session.flash = { type: 'error', message: 'Falha ao reorganizar numeração após cancelamento.' + extra };
                return res.redirect('/admin/inscricoes');
              }
              await sequelize.query(
                "UPDATE registrations SET paidOrder = ?, updatedAt = NOW() WHERE id = ?",
                { replacements: [newOrder, row.id], transaction: tx }
              );
              shiftedCount++;
            }
          }
        }

        await tx.commit();

        const placaStr = vacatedOrder != null ? String(Math.min(vacatedOrder, 999)).padStart(3, '0') : null;
        if (vacatedOrder != null) {
          req.session.flash = { type: 'success', message: `Inscrição cancelada. Reorganizada numeração a partir da placa ${placaStr} (${shiftedCount} reajustes via shift seguro).` };
        } else {
          req.session.flash = { type: 'success', message: 'Inscrição cancelada e removida.' };
        }
        return res.redirect('/admin/inscricoes');
      } catch (err) {
        await tx.rollback();
        console.error('Erro ao cancelar inscrição (tx):', err);
        let extra = '';
        try {
          if (err && err.parent) extra = ` (MySQL: ${err.parent.code || ''} ${err.parent.sqlMessage || ''})`;
          else if (err && err.message) extra = ` (${err.message})`;
        } catch (_) {}
        req.session.flash = { type: 'error', message: 'Falha ao cancelar inscrição.' + extra };
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
      const ok = await safeSave(reg);
      if (ok) {
        try { await reg.reload(); } catch (_) {}
      } else {
        console.warn('[Admin Edit] safeSave falhou para id=', id, '. Tentando UPDATE SQL.');
        try {
          await sequelize.query(
            "UPDATE registrations SET name=?, realName=?, cpf=?, city=?, `group`=?, phone=?, type=?, amount=?, birthDate=?, updatedAt=NOW() WHERE id=?",
            { replacements: [reg.name, reg.realName, reg.cpf, reg.city, reg.group, reg.phone, reg.type, reg.amount, reg.birthDate, id] }
          );
        } catch (e2) {
          console.error('[Admin Edit] fallback SQL falhou:', e2);
        }
      }
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
      const Op = require('sequelize').Op;
      const fromRaw = req.body?.from ?? req.query?.from ?? 22;
      const from = Number(fromRaw);
      if (!Number.isFinite(from) || from < 1) {
        req.session.flash = { type: 'error', message: 'Parâmetro inválido.' };
        return res.redirect('/admin/inscricoes');
      }
      const gapPos = from + 1;

      const [[chkGap]] = await sequelize.query(
        "SELECT COUNT(*) AS c FROM registrations WHERE paidOrder = ?",
        { replacements: [gapPos] }
      );
      const gapFree = Number(chkGap?.c || 0) === 0;

      if (!gapFree) {
        req.session.flash = { type: 'error',
          message: `Não há gap na posição ${String(gapPos).padStart(3,'0')}. Essa placa já está ocupada. Use o reparo de pagamentos primeiro, ou informe a placa imediatamente ANTES do verdadeiro buraco.` };
        return res.redirect('/admin/inscricoes');
      }

      const [rows] = await sequelize.query(
        "SELECT id, paidOrder FROM registrations WHERE paymentStatus = 'paid' AND type = 'ATLETA' AND paidOrder > ? ORDER BY paidOrder ASC",
        { replacements: [from] }
      );
      if (!rows || rows.length === 0) {
        req.session.flash = { type: 'info',
          message: `Nenhuma placa maior que ${String(from).padStart(3,'0')} para reajustar. Nada foi alterado.` };
        return res.redirect('/admin/inscricoes');
      }

      const tx = await sequelize.transaction({ isolationLevel: require('sequelize').Transaction.ISOLATION_LEVELS.SERIALIZABLE });
      try {
        const tmpOffset = -1000000;
        for (const row of rows) {
          await sequelize.query(
            "UPDATE registrations SET paidOrder = ?, updatedAt = NOW() WHERE id = ?",
            { replacements: [tmpOffset + Number(row.paidOrder), row.id], transaction: tx }
          );
        }
        let shifted = 0;
        for (const row of rows) {
          const newOrder = Number(row.paidOrder) - 1;
          const [[occ]] = await sequelize.query(
            "SELECT COUNT(*) AS c FROM registrations WHERE paidOrder = ?",
            { replacements: [newOrder], transaction: tx }
          );
          if (Number(occ?.c || 0) > 0) {
            await tx.rollback();
            req.session.flash = { type: 'error',
              message: `Conflito ao tentar atribuir placa ${String(newOrder).padStart(3,'0')} (já ocupada durante shift). Abortado e desfeito.` };
            return res.redirect('/admin/inscricoes');
          }
          await sequelize.query(
            "UPDATE registrations SET paidOrder = ?, updatedAt = NOW() WHERE id = ?",
            { replacements: [newOrder, row.id], transaction: tx }
          );
          shifted++;
        }
        await tx.commit();
        const placaStr = String(Math.min(from, 999)).padStart(3, '0');
        req.session.flash = { type: 'success',
          message: `Corrigido gap a partir da placa ${placaStr} (${shifted} placas reajustadas via shift seguro).` };
        return res.redirect('/admin/inscricoes');
      } catch (err) {
        try { await tx.rollback(); } catch (_) {}
        console.error('Erro ao corrigir gap de placas (tx):', err);
        let extra = '';
        try {
          if (err && err.parent) extra = ` (MySQL: ${err.parent.code || ''} ${err.parent.sqlMessage || ''})`;
          else if (err && err.message) extra = ` (${err.message})`;
        } catch (_) {}
        req.session.flash = { type: 'error', message: 'Falha ao corrigir gap.' + extra };
        return res.redirect('/admin/inscricoes');
      }
    } catch (e) {
      console.error('Erro ao corrigir gap de placas:', e);
      req.session.flash = { type: 'error', message: 'Falha ao corrigir gap.' };
      return res.redirect('/admin/inscricoes');
    }
  },
  registrationsRepair: async (req, res) => {
    try {
      if (!isAdmin(req)) return res.redirect('/admin');
      const report = await repairBrokenPaidRegistrations();
      const parts = [];
      parts.push(`Total com problema: ${report.totalBrokenPaid ?? report.total}`);
      parts.push(`Corrigidos com sucesso: ${report.fixed}`);
      if (Number(report.clearedGuestsWithPlate) > 0) parts.push(`Acompanhantes com placa indevida limpos: ${report.clearedGuestsWithPlate}`);
      if (Number(report.clearedZeroPlates) > 0) parts.push(`Placas zeradas/inválidas limpas: ${report.clearedZeroPlates}`);
      if (report.fixedConfirmation > 0) parts.push(`Confirmações (Mercado Pago) restauradas: ${report.fixedConfirmation}`);
      if (report.fixedOrder > 0) parts.push(`Placas atribuídas: ${report.fixedOrder}`);
      if (report.duplicatePlates && report.duplicatePlates.length > 0) parts.push(`Atenção: ainda há ${report.duplicatePlates.length} placas DUPLICADAS (resolver manual)`);
      if (report.gaps && report.gaps.length > 0) {
        const g = report.gaps.slice(0, 10).map(n => String(n).padStart(3, '0')).join(', ');
        parts.push(`Lacunas detectadas: ${g}${report.gaps.length > 10 ? '...' : ''}`);
      }
      if (report.stillBroken > 0) parts.push(`Ainda com problema: ${report.stillBroken}`);
      let detailMsg = parts.join(' | ');
      if (report.errors && report.errors.length > 0) {
        const topErrs = report.errors.slice(0, 5).map(e => `id=${e.id} ${e.name || ''} (${e.reason})`).join(' ; ');
        detailMsg += ` — Erros: ${topErrs}`;
        console.warn('[RepairPagamentos] relatório completo de erros:', JSON.stringify(report.errors, null, 2));
      }
      const hasDuplicates = report.duplicatePlates && report.duplicatePlates.length > 0;
      const type = report.stillBroken === 0 && !hasDuplicates ? 'success' : 'error';
      req.session.flash = { type, message: `Reparo de pagamentos concluído. ${detailMsg}` };
      return res.redirect('/admin/pagamentos/diagnostico');
    } catch (e) {
      console.error('Erro no reparo de pagamentos:', e);
      req.session.flash = { type: 'error', message: 'Falha ao executar reparo de pagamentos. ' + (e?.message || String(e)) };
      return res.redirect('/admin/inscricoes');
    }
  },
  registrationsDiagnose: async (req, res) => {
    try {
      if (!isAdmin(req)) return res.redirect('/admin');
      const d = await diagnosePlatesAndPayments();
      const pad = (n) => String(n).padStart(3, '0');
      const esc = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      const rowsTable = (d.tabela || []).slice(0, 500).map(r => {
        const badgeType = r.type === 'ATLETA' ? 'Ciclista' : 'Acomp';
        const badgeStatus = r.paymentStatus === 'paid' ? 'Pago' : 'Pend';
        const who = esc(`${r.id}: ${r.name} (${r.cpf})`);
        const conf = esc(String(r.paymentConfirmedBy || ''));
        return `<tr><td style="text-align:center;font-family:monospace;font-size:16px;font-weight:bold;">${pad(r.paidOrder)}</td><td>${who}</td><td>${badgeType}</td><td>${badgeStatus}</td><td>${conf || '<em style="color:#ff8080">SEM CONFIRMAÇÃO</em>'}</td></tr>`;
      }).join('');
      const semPlaca = (d.atletasPagosSemPlaca || []).map(r => `<li>id=${r.id} — ${esc(r.name)} (${esc(r.cpf)}) — mpPaymentId=${esc(r.mpPaymentId || 'nulo')}</li>`).join('') || '<li style="color:#7fff9f">Nenhum. Todos os atletas pagos tem placa.</li>';
      const semConf = (d.pagosSemConfirmacao || []).map(r => `<li>[${r.type}] placa=${(r.paidOrder||'—')} id=${r.id} — ${esc(r.name)} (${esc(r.cpf)})</li>`).join('') || '<li style="color:#7fff9f">Nenhum. Todos os pagos tem confirmação.</li>';
      const guestPlates = (d.acompanhantesComPlaca || []).map(r => `<li>placa=${pad(r.paidOrder)} id=${r.id} — ${esc(r.name)} (${esc(r.cpf)})</li>`).join('') || '<li style="color:#7fff9f">Nenhum acompanhante indevidamente com placa.</li>';
      const zeroPlates = (d.zeroOuMenosPlates || []).map(r => `<li>paidOrder=${r.paidOrder} [${r.type}] id=${r.id} — ${esc(r.name)} (${esc(r.cpf)})</li>`).join('') || '<li style="color:#7fff9f">Nenhuma placa zero/negativa.</li>';
      const dups = (d.duplicatas || []).map(r => `<li><strong>Placa ${pad(r.paidOrder)}</strong> (${r.n} vezes): ${esc(r.who || r.ids)}</li>`).join('') || '<li style="color:#7fff9f">Nenhuma placa duplicada.</li>';
      const lacs = (d.lacunas || []).map(n => pad(n)).join(', ') || '<em style="color:#7fff9f">Nenhuma lacuna — numeração perfeita.</em>';
      const livres = (d.proximas50Livre || []).map(n => pad(n)).join(', ');
      const sem = d.atletasPagos - d.atletasPagosComPlaca;
      const qtdGuestBug = d.acompanhantesComPlaca ? d.acompanhantesComPlaca.length : 0;
      const qtdDup = d.duplicatas ? d.duplicatas.length : 0;
      const qtdLac = d.lacunas ? d.lacunas.length : 0;
      const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Diagnóstico de Placas e Pagamentos</title>
        <style>
          body{font-family:Arial,Helvetica,sans-serif;background:#0f172a;color:#f1f5f9;margin:0;padding:24px;}
          .wrap{max-width:1200px;margin:0 auto;}
          h1{margin-top:0;}
          h2{margin-top:28px;border-bottom:1px solid #334155;padding-bottom:6px;}
          .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:16px 0 24px;}
          .kpi{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:14px;}
          .kpi .label{font-size:0.8rem;color:#94a3b8;margin-bottom:4px;}
          .kpi .value{font-size:1.8rem;font-weight:bold;color:#fff;}
          .kpi.danger .value{color:#ff6b6b;}
          .kpi.warn .value{color:#ffcf5c;}
          .kpi.ok .value{color:#7fff9f;}
          table{width:100%;border-collapse:collapse;margin-top:10px;background:#111827;}
          th,td{border:1px solid #374151;padding:7px 10px;text-align:left;font-size:0.92rem;}
          th{background:#1f2937;color:#e5e7eb;text-align:center;}
          ul.problems{background:#111827;border:1px solid #374151;border-radius:8px;padding:14px 14px 14px 32px;line-height:1.55em;}
          ul.problems li{margin:3px 0;}
          .btn{display:inline-block;background:#0e5af0;color:#fff;text-decoration:none;padding:10px 14px;border-radius:8px;font-weight:bold;border:none;cursor:pointer;}
          .btn.warn{background:#f59e0b;}
          .btns{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0;}
          code{background:#1f2937;padding:2px 6px;border-radius:4px;color:#a5d8ff;}
          small{color:#94a3b8;}
        </style>
      </head><body><div class="wrap">
        <h1>🔍 Diagnóstico de Placas e Pagamentos</h1>
        <small>Gerado em ${new Date(d.generatedAt).toLocaleString('pt-BR')}</small>
        <div class="btns">
          <a class="btn" href="/admin/inscricoes">← Voltar para Inscrições</a>
          <form method="POST" action="/admin/pagamentos/reparar" style="display:inline;">
            <button class="btn warn" onclick="return confirm('Isso irá limpar placas de ACOMPANHANTES, resetar placas inválidas (0 / negativas), atribuir \\\"Mercado Pago\\\" e números de placa aos atletas pagos que estão sem. Continuar?')">🛠️ Executar Reparo Agora</button>
          </form>
        </div>
        <div class="kpis">
          <div class="kpi"><div class="label">Total de inscrições</div><div class="value">${d.totalInscricoes}</div></div>
          <div class="kpi"><div class="label">Atletas</div><div class="value">${d.atletas}</div></div>
          <div class="kpi"><div class="label">Acompanhantes</div><div class="value">${d.acompanhantes}</div></div>
          <div class="kpi ok"><div class="label">Inscrições pagas</div><div class="value">${d.pagos}</div></div>
          <div class="kpi warn"><div class="label">Inscrições pendentes</div><div class="value">${d.pendentes}</div></div>
          <div class="kpi ok"><div class="label">Atletas pagos</div><div class="value">${d.atletasPagos}</div></div>
          <div class="kpi ok"><div class="label">Atletas pagos com placa válida</div><div class="value">${d.atletasPagosComPlaca}</div></div>
          <div class="kpi danger"><div class="label">Atletas pagos SEM PLACA</div><div class="value">${sem}</div></div>
          <div class="kpi ${qtdGuestBug ? 'danger' : 'ok'}"><div class="label">Acompanhantes com placa (BUG)</div><div class="value">${qtdGuestBug}</div></div>
          <div class="kpi ${qtdDup ? 'danger' : 'ok'}"><div class="label">Placas duplicadas</div><div class="value">${qtdDup}</div></div>
          <div class="kpi ${qtdLac ? 'warn' : 'ok'}"><div class="label">Lacunas (buracos)</div><div class="value">${qtdLac}</div></div>
          <div class="kpi"><div class="label">Placa máxima usada</div><div class="value">${pad(d.maxPlaca)}</div></div>
        </div>
        ${d.error ? `<div style="background:#7f1d1d;border:1px solid #ef4444;padding:14px;border-radius:8px;color:#fecaca;">ERRO NO DIAGNÓSTICO: ${esc(d.error)}</div>` : ''}
        <h2>🚨 Problemas Detectados</h2>
        <h3>Atletas pagos SEM número de placa (são eles que aparecem como 000):</h3>
        <ul class="problems">${semPlaca}</ul>
        <h3>Pagos SEM informação de confirmação (sem "Mercado Pago" ou admin):</h3>
        <ul class="problems">${semConf}</ul>
        <h3>Acompanhantes que tem placa indevida (ocupam UNIQUE index):</h3>
        <ul class="problems">${guestPlates}</ul>
        <h3>Placas inválidas (zero ou negativas):</h3>
        <ul class="problems">${zeroPlates}</ul>
        <h3>Placas DUPLICADAS (2 inscrições com mesmo número):</h3>
        <ul class="problems">${dups}</ul>
        <h2>📊 Numeração</h2>
        <h3>Lacunas (buracos) na numeração (até 100 primeiros):</h3>
        <div class="problems" style="padding:14px;font-family:monospace;font-size:1.05rem;letter-spacing:1px;">${lacs}</div>
        <h3>Próximas 50 placas LIVRES após a máxima atual:</h3>
        <div class="problems" style="padding:14px;font-family:monospace;font-size:1.05rem;letter-spacing:1px;">${livres}</div>
        <h2>🧾 Tabela de TODAS as inscrições com placa (ordenado por placa, até 500)</h2>
        <table>
          <thead><tr><th>Placa</th><th>Inscrição</th><th>Tipo</th><th>Status</th><th>Confirmado por</th></tr></thead>
          <tbody>${rowsTable || '<tr><td colspan="5" style="text-align:center;color:#94a3b8;">Nenhuma inscrição com placa.</td></tr>'}</tbody>
        </table>
      </div></body></html>`;
      res.type('text/html; charset=utf-8');
      return res.send(html);
    } catch (e) {
      console.error('Erro no diagnóstico de pagamentos/placas:', e);
      req.session.flash = { type: 'error', message: 'Falha ao executar diagnóstico. ' + (e?.message || String(e)) };
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
