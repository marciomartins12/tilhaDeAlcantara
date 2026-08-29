const { DataTypes } = require('sequelize');
const { sequelize } = require('./index');

const Registration = sequelize.define('Registration', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    type: { type: DataTypes.ENUM('ATLETA', 'ACOMPANHANTE'), allowNull: false },
    name: { type: DataTypes.STRING(120), allowNull: false, comment: 'Nome curto / apelido que vai aparecer no avatar/card' },
    realName: { type: DataTypes.STRING(190), allowNull: true, comment: 'Nome completo real do ciclista (apenas registros internos)' },
    cpf: { type: DataTypes.STRING(14), allowNull: false, unique: true },
    birthDate: { type: DataTypes.DATEONLY, allowNull: true, comment: 'Data de nascimento (YYYY-MM-DD)' },
    group: { type: DataTypes.STRING(120), allowNull: true },
    city: { type: DataTypes.STRING(120), allowNull: true },
    phone: { type: DataTypes.STRING(20), allowNull: true },
    termsAccepted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    paymentStatus: { type: DataTypes.ENUM('pending', 'paid'), allowNull: false, defaultValue: 'pending' },
    mpPaymentId: { type: DataTypes.STRING(64), allowNull: true },
    mpQrCode: { type: DataTypes.TEXT, allowNull: true },
    mpQrCodeBase64: { type: DataTypes.TEXT, allowNull: true },
  mpTicketUrl: { type: DataTypes.STRING(255), allowNull: true },
  avatarPath: { type: DataTypes.STRING(255), allowNull: true },
  // Armazena a imagem editada (recortada) diretamente no banco para uso posterior
  avatarData: { type: DataTypes.BLOB('long'), allowNull: true },
  paidOrder: { type: DataTypes.INTEGER, allowNull: true, unique: true },
  // Confirmação manual de pagamento (vinculada ao admin)
  paymentConfirmedBy: { type: DataTypes.STRING(190), allowNull: true },
  paymentConfirmedAt: { type: DataTypes.DATE, allowNull: true },
  // Controle de recebimento do Kit Ciclista no evento
  kitReceivedAt: { type: DataTypes.DATE, allowNull: true, comment: 'Data/hora de entrega do kit (null = não recebido)' },
  kitReceivedBy: { type: DataTypes.STRING(190), allowNull: true, comment: 'Nome da pessoa que retirou (o próprio atleta OU terceiro autorizado)' },
  kitReceivedSelf: { type: DataTypes.BOOLEAN, allowNull: true, comment: 'true = próprio atleta retirou; false = terceiro retirou' },
  kitDeliveredBy: { type: DataTypes.STRING(190), allowNull: true, comment: 'Voluntário/admin que entregou o kit (audit)' },
  }, {
    tableName: 'registrations',
    timestamps: true,
  });
module.exports = Registration;