const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema({
  menuItem: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem' },
  quantity: { type: Number, default: 1 }
});

const TableSchema = new mongoose.Schema({
  name: { type: String, required: true },
  available: { type: Boolean, default: true },
  orders: [OrderSchema], // Subdocumento en lugar de solo IDs
  linkedTables: { type: [String], default: [] },
  controlledBy: { type: String, default: null },
  waiterId: { type: String, default: null },
  waiterName: { type: String, default: null }
});

module.exports = mongoose.model('Table', TableSchema);