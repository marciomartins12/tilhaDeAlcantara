const { DataTypes } = require('sequelize');
const { sequelize } = require('./index');

const GalleryItem = sequelize.define('GalleryItem', {
  id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
  title: { type: DataTypes.STRING(160), allowNull: true },
  description: { type: DataTypes.TEXT, allowNull: true },
  type: { type: DataTypes.ENUM('image', 'video'), allowNull: false },
  // Para itens antigos, filePath continuará funcional; para novos, salvamos o binário no DB
  filePath: { type: DataTypes.STRING(255), allowNull: true },
  mimeType: { type: DataTypes.STRING(100), allowNull: true },
  originalName: { type: DataTypes.STRING(255), allowNull: true },
  data: { type: DataTypes.BLOB('long'), allowNull: true },
  isPublished: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  orderIndex: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
}, {
  tableName: 'gallery_items',
  timestamps: true,
});

module.exports = GalleryItem;