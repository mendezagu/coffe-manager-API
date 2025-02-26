const mongoose = require('mongoose');

const WaiterSchema = new mongoose.Schema({
  name: { type: String, required: true }
});

module.exports = mongoose.model('Waiter', WaiterSchema);