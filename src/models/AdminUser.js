const { DataTypes } = require('sequelize');
const { sequelize } = require('./index');

const AdminUser = sequelize.define('AdminUser', {
  id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
  name: { type: DataTypes.STRING(120), allowNull: true },
  email: { type: DataTypes.STRING(190), allowNull: false, unique: true, validate: { isEmail: true } },
  passwordHash: { type: DataTypes.STRING(100), allowNull: false },
  role: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'ADMIN' },
}, {
  tableName: 'admin_users',
  timestamps: true,
});

module.exports = AdminUser;
