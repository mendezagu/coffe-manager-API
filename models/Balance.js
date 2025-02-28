const mongoose = require('mongoose');

const BalanceSchema = new mongoose.Schema({
  tableName: String,
  waiterName: String,
  totalAmount: Number,
  date: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Balance', BalanceSchema);