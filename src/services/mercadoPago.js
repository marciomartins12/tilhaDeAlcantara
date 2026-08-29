// SDK v2 (mercadopago@^2): usar classes MercadoPagoConfig e Payment
const mercadopago = require('mercadopago');
const { MercadoPagoConfig, Payment } = mercadopago;

function getClient() {
  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken) {
    console.warn('MP_ACCESS_TOKEN não configurado. Pagamentos PIX não funcionarão.');
    return null;
  }
  // Pequeno log para confirmar ambiente
  try {
    const env = String(process.env.NODE_ENV || '').toLowerCase();
    console.log(`[MP] Cliente inicializado (env=${env || 'desconhecido'})`);
  } catch (_) {}
  return new MercadoPagoConfig({ accessToken });
}

async function createPixPayment({ amount, description, cpf, email }) {
  const client = getClient();
  if (!client) throw new Error('Mercado Pago não configurado');
  const payment = new Payment(client);
  const notificationUrl = process.env.MP_NOTIFICATION_URL;
  if (!notificationUrl) {
    console.warn('MP_NOTIFICATION_URL não configurado. Webhooks de confirmação não serão enviados pelo Mercado Pago.');
  } else {
    try { console.log(`[MP] Usando notification_url=${notificationUrl}`); } catch (_) {}
  }
  const body = {
    transaction_amount: Number(amount),
    description: description || 'Inscrição Trilha do Buriti',
    payment_method_id: 'pix',
    // Se houver URL pública configurada para receber webhooks
    ...(notificationUrl ? { notification_url: notificationUrl } : {}),
    payer: {
      email: email || 'inscricao@trilhadoburiti.com',
      identification: { type: 'CPF', number: cpf },
    },
  };
  try {
    const result = await payment.create({ body });
    try {
      console.log('Resposta MP create PIX:', {
        id: result?.id,
        status: result?.status,
        hasTx: !!result?.point_of_interaction?.transaction_data,
      });
    } catch (_) {}
    return result;
  } catch (error) {
    // Logar detalhes úteis do erro para diagnóstico
    try {
      console.error('Erro MP create PIX:', {
        message: error?.message,
        status: error?.status,
        cause: error?.cause,
        error: error?.error,
      });
    } catch (_) {}
    throw error;
  }
}

async function getPaymentById(id) {
  const client = getClient();
  if (!client) throw new Error('Mercado Pago não configurado');
  const payment = new Payment(client);
  try {
    const result = await payment.get({ id });
    try {
      console.log('Resposta MP get PIX:', {
        id: result?.id,
        status: result?.status,
        hasTx: !!result?.point_of_interaction?.transaction_data,
      });
    } catch (_) {}
    return result;
  } catch (error) {
    try {
      console.error('Erro MP get PIX:', {
        message: error?.message,
        status: error?.status,
        cause: error?.cause,
        error: error?.error,
      });
    } catch (_) {}
    throw error;
  }
}

module.exports = { createPixPayment, getPaymentById };