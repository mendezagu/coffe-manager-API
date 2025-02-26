const express = require('express');
const router = express.Router();
const Waiter = require('../models/waiter');

// Obtener todos los meseros
router.get('/', async (req, res) => {
  const waiters = await Waiter.find();
  res.json(waiters);
});

// Agregar un nuevo mesero
router.post('/', async (req, res) => {
  const newWaiter = new Waiter(req.body);
  await newWaiter.save();
  res.json(newWaiter);
});

// Editar un mesero
router.put('/:id', async (req, res) => {
  const updatedWaiter = await Waiter.findByIdAndUpdate(req.params.id, req.body, { new: true });
  res.json(updatedWaiter);
});

// Eliminar un mesero
router.delete('/:id', async (req, res) => {
  await Waiter.findByIdAndDelete(req.params.id);
  res.json({ message: 'Mesero eliminado' });
});

module.exports = router;