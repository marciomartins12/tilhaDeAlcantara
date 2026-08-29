const sequelize = require('../config/database');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
let AdminUser; // será injetado após definir

async function initDb() {
  try {
    // criar database se não existir (compatível com XAMPP)
    const requireEnv = (k) => {
      const v = process.env[k];
      if (v === undefined || v === null || String(v).trim() === '') throw new Error(`Variável ausente: ${k}`);
      return v;
    };
    const dbName = requireEnv('DB_NAME');
    const dbUser = requireEnv('DB_USER');
    const dbPass = process.env.DB_PASSWORD ?? '';
    const dbHost = requireEnv('DB_HOST');
    const dbPort = Number(requireEnv('DB_PORT'));

    const conn = await mysql.createConnection({ host: dbHost, port: dbPort, user: dbUser, password: dbPass });
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;`);
    await conn.end();

    await sequelize.authenticate();
    console.log('Conexão com banco estabelecida.');

    // Ajuste de max_allowed_packet removido por padrão para evitar erros de permissão em ambientes locais.
    // Caso realmente precise alterar, habilite via variável de ambiente DB_TUNE_MAX_PACKET=true.
    try {
      const tune = String(process.env.DB_TUNE_MAX_PACKET || '').toLowerCase() === 'true';
      if (tune) {
      const maxPacketRaw = process.env.DB_MAX_PACKET_BYTES;
      const maxPacket = maxPacketRaw ? Number(maxPacketRaw) : undefined;
      if (!maxPacket) throw new Error('DB_MAX_PACKET_BYTES ausente ou inválido');
        await sequelize.query(`SET GLOBAL max_allowed_packet = ${maxPacket}`);
        await sequelize.query(`SET SESSION max_allowed_packet = ${maxPacket}`);
        console.log('max_allowed_packet ajustado para', maxPacket);
      }
    } catch (e) {
      console.warn('Não foi possível ajustar max_allowed_packet automaticamente:', e.message);
    }

    // carregar modelos de forma lazy para evitar ciclo
    AdminUser = require('./AdminUser');
    require('./Registration');
    require('./GalleryItem');
    // Evitar alter automático para não proliferar índices e causar erros "Too many keys specified".
    // Garanta que o schema já esteja atualizado; se necessário, rode migrações manualmente.
    await sequelize.sync();

    // Garantir coluna avatarData (LONGBLOB) para armazenar a imagem recortada no banco
    try {
      const [rows] = await sequelize.query(
        "SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'registrations' AND COLUMN_NAME = 'avatarData'",
        { replacements: [dbName] }
      );
      const cnt = Array.isArray(rows) ? (rows[0]?.cnt ?? rows[0]?.CNT ?? rows[0]?.['COUNT(*)']) : 0;
      if (!cnt) {
        await sequelize.query("ALTER TABLE `registrations` ADD COLUMN `avatarData` LONGBLOB NULL");
        console.log('Coluna avatarData adicionada em registrations');
      }
    } catch (e) {
      console.warn('Não foi possível verificar/adicionar coluna avatarData:', e.message);
    }

    // Garantir colunas de confirmação manual de pagamento
    try {
      const [rowsBy] = await sequelize.query(
        "SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'registrations' AND COLUMN_NAME = 'paymentConfirmedBy'",
        { replacements: [dbName] }
      );
      const cntBy = Array.isArray(rowsBy) ? (rowsBy[0]?.cnt ?? rowsBy[0]?.CNT ?? rowsBy[0]?.['COUNT(*)']) : 0;
      if (!cntBy) {
        await sequelize.query("ALTER TABLE `registrations` ADD COLUMN `paymentConfirmedBy` VARCHAR(190) NULL");
        console.log('Coluna paymentConfirmedBy adicionada em registrations');
      }
      const [rowsAt] = await sequelize.query(
        "SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'registrations' AND COLUMN_NAME = 'paymentConfirmedAt'",
        { replacements: [dbName] }
      );
      const cntAt = Array.isArray(rowsAt) ? (rowsAt[0]?.cnt ?? rowsAt[0]?.CNT ?? rowsAt[0]?.['COUNT(*)']) : 0;
      if (!cntAt) {
        await sequelize.query("ALTER TABLE `registrations` ADD COLUMN `paymentConfirmedAt` DATETIME NULL");
        console.log('Coluna paymentConfirmedAt adicionada em registrations');
      }
    } catch (e) {
      console.warn('Não foi possível verificar/adicionar colunas de confirmação:', e.message);
    }

    // Garantir coluna paidOrder para ordem de pagamento
    try {
      const [rowsPaidOrder] = await sequelize.query(
        "SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'registrations' AND COLUMN_NAME = 'paidOrder'",
        { replacements: [dbName] }
      );
      const cntPaidOrder = Array.isArray(rowsPaidOrder) ? (rowsPaidOrder[0]?.cnt ?? rowsPaidOrder[0]?.CNT ?? rowsPaidOrder[0]?.['COUNT(*)']) : 0;
      if (!cntPaidOrder) {
        await sequelize.query("ALTER TABLE `registrations` ADD COLUMN `paidOrder` INT NULL AFTER `avatarData`");
        console.log('Coluna paidOrder adicionada em registrations');
      }
    } catch (e) {
      console.warn('Não foi possível verificar/adicionar coluna paidOrder:', e.message);
    }

    // Garantir coluna birthDate (data de nascimento)
    try {
      const [rowsBD] = await sequelize.query(
        "SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'registrations' AND COLUMN_NAME = 'birthDate'",
        { replacements: [dbName] }
      );
      const cntBD = Array.isArray(rowsBD) ? (rowsBD[0]?.cnt ?? rowsBD[0]?.CNT ?? rowsBD[0]?.['COUNT(*)']) : 0;
      if (!cntBD) {
        await sequelize.query("ALTER TABLE `registrations` ADD COLUMN `birthDate` DATE NULL AFTER `cpf`");
        console.log('Coluna birthDate adicionada em registrations');
      }
    } catch (e) {
      console.warn('Não foi possível verificar/adicionar coluna birthDate:', e.message);
    }

    // Garantir coluna realName (nome completo do ciclista — só para registro interno)
    try {
      const [rowsRN] = await sequelize.query(
        "SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'registrations' AND COLUMN_NAME = 'realName'",
        { replacements: [dbName] }
      );
      const cntRN = Array.isArray(rowsRN) ? (rowsRN[0]?.cnt ?? rowsRN[0]?.CNT ?? rowsRN[0]?.['COUNT(*)']) : 0;
      if (!cntRN) {
        await sequelize.query("ALTER TABLE `registrations` ADD COLUMN `realName` VARCHAR(190) NULL AFTER `name`");
        console.log('Coluna realName adicionada em registrations');
      }
    } catch (e) {
      console.warn('Não foi possível verificar/adicionar coluna realName:', e.message);
    }

    // Garantir colunas de controle de recebimento do kit (kitReceivedAt / kitReceivedBy / kitReceivedSelf / kitDeliveredBy)
    try {
      const [rowsKRA] = await sequelize.query(
        "SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'registrations' AND COLUMN_NAME = 'kitReceivedAt'",
        { replacements: [dbName] }
      );
      const cntKRA = Array.isArray(rowsKRA) ? (rowsKRA[0]?.cnt ?? rowsKRA[0]?.CNT ?? rowsKRA[0]?.['COUNT(*)']) : 0;
      if (!cntKRA) {
        await sequelize.query("ALTER TABLE `registrations` ADD COLUMN `kitReceivedAt` DATETIME NULL AFTER `paymentConfirmedAt`");
        console.log('Coluna kitReceivedAt adicionada em registrations');
      }
      const [rowsKRB] = await sequelize.query(
        "SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'registrations' AND COLUMN_NAME = 'kitReceivedBy'",
        { replacements: [dbName] }
      );
      const cntKRB = Array.isArray(rowsKRB) ? (rowsKRB[0]?.cnt ?? rowsKRB[0]?.CNT ?? rowsKRB[0]?.['COUNT(*)']) : 0;
      if (!cntKRB) {
        await sequelize.query("ALTER TABLE `registrations` ADD COLUMN `kitReceivedBy` VARCHAR(190) NULL AFTER `kitReceivedAt`");
        console.log('Coluna kitReceivedBy adicionada em registrations');
      }
      const [rowsKRS] = await sequelize.query(
        "SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'registrations' AND COLUMN_NAME = 'kitReceivedSelf'",
        { replacements: [dbName] }
      );
      const cntKRS = Array.isArray(rowsKRS) ? (rowsKRS[0]?.cnt ?? rowsKRS[0]?.CNT ?? rowsKRS[0]?.['COUNT(*)']) : 0;
      if (!cntKRS) {
        await sequelize.query("ALTER TABLE `registrations` ADD COLUMN `kitReceivedSelf` TINYINT(1) NULL AFTER `kitReceivedBy`");
        console.log('Coluna kitReceivedSelf adicionada em registrations');
      }
      const [rowsKDB] = await sequelize.query(
        "SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'registrations' AND COLUMN_NAME = 'kitDeliveredBy'",
        { replacements: [dbName] }
      );
      const cntKDB = Array.isArray(rowsKDB) ? (rowsKDB[0]?.cnt ?? rowsKDB[0]?.CNT ?? rowsKDB[0]?.['COUNT(*)']) : 0;
      if (!cntKDB) {
        await sequelize.query("ALTER TABLE `registrations` ADD COLUMN `kitDeliveredBy` VARCHAR(190) NULL AFTER `kitReceivedSelf`");
        console.log('Coluna kitDeliveredBy adicionada em registrations');
      }
    } catch (e) {
      console.warn('Não foi possível verificar/adicionar colunas de kit:', e.message);
    }

    // Garantir UNIQUE em paidOrder e resolver duplicatas antigas (se houver)
    try {
      const [idxRows] = await sequelize.query(
        "SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'registrations' AND INDEX_NAME = 'paidOrder'",
        { replacements: [dbName] }
      );
      const hasIdx = Array.isArray(idxRows) ? (idxRows[0]?.cnt ?? idxRows[0]?.CNT ?? idxRows[0]?.['COUNT(*)']) : 0;
      if (!hasIdx) {
        // Passo 1: detectar duplicatas
        const [dups] = await sequelize.query(
          "SELECT paidOrder, COUNT(*) AS qtd FROM registrations WHERE type = 'ATLETA' AND paidOrder IS NOT NULL GROUP BY paidOrder HAVING qtd > 1"
        );
        if (Array.isArray(dups) && dups.length > 0) {
          console.warn(`Encontradas ${dups.length} placas duplicadas em paidOrder — corrigindo...`);
          // Passo 2: listar todos atletas pagos ordenados por data de confirmação (priorizando quem confirmou primeiro)
          const [allAthletes] = await sequelize.query(
            "SELECT id, paidOrder FROM registrations WHERE type = 'ATLETA' AND paymentStatus = 'paid' ORDER BY COALESCE(paymentConfirmedAt, createdAt) ASC, id ASC"
          );
          if (Array.isArray(allAthletes)) {
            // Passo 3: nulificar todos paidOrders (evita conflito ao reordenar)
            await sequelize.query("UPDATE registrations SET paidOrder = NULL WHERE type = 'ATLETA' AND paidOrder IS NOT NULL");
            // Passo 4: reatribuir sequencialmente respeitando ordem temporal
            let seq = 0;
            for (const ath of allAthletes) {
              seq += 1;
              await sequelize.query("UPDATE registrations SET paidOrder = ? WHERE id = ?", { replacements: [seq, ath.id] });
            }
            console.log(`paidOrder dedup concluído: ${seq} atletas renumerados sequencialmente`);
          }
        }
        // Passo 5: criar índice único
        await sequelize.query("ALTER TABLE `registrations` ADD UNIQUE INDEX `paidOrder` (`paidOrder`)");
        console.log('Índice UNIQUE criado em registrations.paidOrder');
      }
    } catch (e) {
      console.warn('Não foi possível garantir índice UNIQUE em paidOrder:', e.message);
    }

    // Garantir coluna 'name' em admin_users para exibir nome do admin
    try {
      const [rowsAdminName] = await sequelize.query(
        "SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'admin_users' AND COLUMN_NAME = 'name'",
        { replacements: [dbName] }
      );
      const cntAdminName = Array.isArray(rowsAdminName) ? (rowsAdminName[0]?.cnt ?? rowsAdminName[0]?.CNT ?? rowsAdminName[0]?.['COUNT(*)']) : 0;
      if (!cntAdminName) {
        await sequelize.query("ALTER TABLE `admin_users` ADD COLUMN `name` VARCHAR(120) NULL");
        console.log('Coluna name adicionada em admin_users');
      }
    } catch (e) {
      console.warn('Não foi possível verificar/adicionar coluna name em admin_users:', e.message);
    }

    // Garantir coluna 'role' em admin_users para controle de acesso
    try {
      const [rowsAdminRole] = await sequelize.query(
        "SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'admin_users' AND COLUMN_NAME = 'role'",
        { replacements: [dbName] }
      );
      const cntAdminRole = Array.isArray(rowsAdminRole) ? (rowsAdminRole[0]?.cnt ?? rowsAdminRole[0]?.CNT ?? rowsAdminRole[0]?.['COUNT(*)']) : 0;
      if (!cntAdminRole) {
        await sequelize.query("ALTER TABLE `admin_users` ADD COLUMN `role` VARCHAR(20) NOT NULL DEFAULT 'ADMIN'");
        console.log("Coluna role adicionada em admin_users");
      }
    } catch (e) {
      console.warn('Não foi possível verificar/adicionar coluna role em admin_users:', e.message);
    }

    // seed usuário admin padrão se nenhum existir, OU se a senha do .env mudou
    try {
      const email = requireEnv('ADMIN_EMAIL');
      const name = requireEnv('ADMIN_NAME');
      const plain = requireEnv('ADMIN_PASSWORD');
      const count = await AdminUser.count();
      if (count === 0) {
        const passwordHash = await bcrypt.hash(plain, 10);
        await AdminUser.create({ email, name, passwordHash, role: 'ADMIN' });
        console.log('Usuário admin padrão criado:', email);
      } else {
        // Se o usuário padrão existe mas a senha do .env mudou, rehash
        const existing = await AdminUser.findOne({ where: { email: email.toLowerCase() } });
        if (existing) {
          const match = await bcrypt.compare(plain, existing.passwordHash);
          if (!match) {
            existing.passwordHash = await bcrypt.hash(plain, 10);
            if (typeof existing.name === 'string' && !existing.name && name) existing.name = name;
            await existing.save();
            console.log('Senha do admin padrão atualizada via .env:', email);
          }
        }
      }
    } catch (seedErr) {
      console.warn('Seed admin não concluído:', seedErr.message);
    }
  } catch (err) {
    console.error('Falha ao conectar ao banco:', err.message);
  }
}

module.exports = { sequelize, initDb };
