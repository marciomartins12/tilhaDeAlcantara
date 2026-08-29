const { Sequelize } = require('sequelize');

function requireEnv(key) {
  const v = process.env[key];
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new Error(`Variável de ambiente obrigatória ausente: ${key}`);
  }
  return v;
}

const dbName = requireEnv('DB_NAME');
const dbUser = requireEnv('DB_USER');
// Permitir senha vazia (ambientes locais podem usar sem senha)
const dbPass = process.env.DB_PASSWORD ?? '';
const dbHost = requireEnv('DB_HOST');
const dbPort = Number(requireEnv('DB_PORT'));

// SSL opcional para bancos gerenciados (KingHost Managed DB, etc.)
const dbSslRaw = String(process.env.DB_SSL || '').toLowerCase();
const dbSsl = dbSslRaw === 'true' || dbSslRaw === '1';

const dialectOptions = {};
if (dbSsl) {
  dialectOptions.ssl = { require: true, rejectUnauthorized: false };
}

/**
 * Normaliza o TIMEZONE para o formato que o MySQL2 aceita.
 * O driver MySQL2 SÓ ACEITA offsets no formato "+HH:MM" ou "-HH:MM".
 * Se o usuário passar um timezone IANA ("America/Fortaleza", "America/Sao_Paulo")
 * nós mapeamos para o offset correspondente, evitando o warning:
 *   "Ignoring invalid timezone passed to Connection: America/Fortaleza"
 *
 * Em 2026 o Brasil NÃO TEM horário de verão, então ambos são sempre -03:00.
 */
function normalizeMysqlTimezone(raw) {
  const tz = String(raw || '').trim();
  if (!tz) return '-03:00';
  // Se já estiver no formato offset (+HH:MM / -HH:MM) → usa direto
  if (/^[+-]\d{2}:\d{2}$/.test(tz)) return tz;
  // Mapeamento IANA → offset (Brasil inteiro é -03:00 em 2026)
  switch (tz) {
    case 'America/Fortaleza':
    case 'America/Sao_Paulo':
    case 'America/Manaus':
    case 'America/Porto_Velho':
    case 'America/Belem':
    case 'America/Recife':
    case 'America/Maceio':
    case 'America/Araguaina':
    case 'America/Bahia':
    case 'America/Campo_Grande':
    case 'America/Cuiaba':
    case 'America/Santarem':
    case 'America/Boa_Vista':
    case 'America/Porto_Acre':
    case 'America/Rio_Branco':
      return '-03:00';
    default:
      // Timezone IANA desconhecido — força -03:00 (BR padrão) em vez de UTC
      console.warn(`[database] TIMEZONE IANA "${tz}" mapeado para offset -03:00 (MySQL2 aceita só offsets). Para suprimir este aviso, use TIMEZONE=-03:00 no .env`);
      return '-03:00';
  }
}

const sequelize = new Sequelize(dbName, dbUser, dbPass, {
  host: dbHost,
  port: dbPort,
  dialect: 'mysql',
  logging: String(process.env.NODE_ENV || '').toLowerCase().startsWith('prod') ? false : console.log,
  pool: { max: 10, min: 0, idle: 10000, acquire: 30000 },
  timezone: normalizeMysqlTimezone(process.env.TIMEZONE),
  dialectOptions,
});

module.exports = sequelize;
