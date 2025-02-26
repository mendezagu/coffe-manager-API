const express = require('express');
const router = express.Router();
const MenuItem = require('../models/menuItem');

// Obtener todos los ítems del menú
router.get('/', async (req, res) => {
  const menuItems = await MenuItem.find();
  res.json(menuItems);
});

// Agregar un nuevo ítem al menú
router.post('/', async (req, res) => {
  const newItem = new MenuItem(req.body);
  await newItem.save();
  res.json(newItem);
});

// Editar un ítem del menú
router.put('/:id', async (req, res) => {
  const updatedItem = await MenuItem.findByIdAndUpdate(req.params.id, req.body, { new: true });
  res.json(updatedItem);
});

// Eliminar un ítem del menú
router.delete('/:id', async (req, res) => {
  await MenuItem.findByIdAndDelete(req.params.id);
  res.json({ message: 'Ítem eliminado' });
});

module.exports = router;