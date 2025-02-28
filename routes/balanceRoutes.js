const express = require('express');
const router = express.Router();
const Balance = require('../models/Balance'); // Creamos un modelo para almacenar balances

// Obtener todos los balances
router.get('/', async (req, res) => {
  try {
    const balances = await Balance.find();
    res.json(balances);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener balances', error });
  }
});

// Agregar un nuevo balance cuando se libera una mesa
router.post('/', async (req, res) => {
  try {
    const newBalance = new Balance(req.body);
    await newBalance.save();
    res.status(201).json(newBalance);
  } catch (error) {
    res.status(500).json({ message: 'Error al guardar balance', error });
  }
});

// Eliminar todos los balances
router.delete('/', async (req, res) => {
    try {
      await Balance.deleteMany({}); // Elimina todos los documentos de la colección
      res.json({ message: 'Todos los balances han sido eliminados' });
    } catch (error) {
      res.status(500).json({ message: 'Error al eliminar balances', error });
    }
  });

module.exports = router;