const express = require('express');
const router = express.Router();
const Table = require('../models/table');
const MenuItem = require('../models/menuItem');
const mongoose = require('mongoose');

// Obtener todas las mesas
router.get('/', async (req, res) => {
  try {
    const tables = await Table.find();
    res.json(tables);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error al obtener las mesas' });
  }
});

// Agregar una nueva mesa
router.post('/', async (req, res) => {
  try {
    const newTable = new Table(req.body);
    await newTable.save();
    res.json(newTable);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error al agregar la mesa' });
  }
});

// Editar una mesa
router.put('/:id', async (req, res) => {
  try {
    const updatedTable = await Table.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!updatedTable) {
      return res.status(404).json({ message: 'Mesa no encontrada' });
    }
    res.json(updatedTable);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error al editar la mesa' });
  }
});

// Eliminar una mesa
router.delete('/:id', async (req, res) => {
  try {
    const deletedTable = await Table.findByIdAndDelete(req.params.id);
    if (!deletedTable) {
      return res.status(404).json({ message: 'Mesa no encontrada' });
    }
    res.json({ message: 'Mesa eliminada' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error al eliminar la mesa' });
  }
});

// Agregar ítems a la mesa
router.put('/:id/add-items', async (req, res) => {
  try {
    const tableId = req.params.id;
    const { items } = req.body;

    // Verificar si la mesa existe
    const table = await Table.findById(tableId);
    if (!table) {
      return res.status(404).json({ message: 'Mesa no encontrada' });
    }

    // Procesar cada ítem del pedido
    for (let item of items) {
      const menuItem = await MenuItem.findById(item.id);
      if (!menuItem) {
        return res.status(404).json({ message: `Ítem con ID ${item.id} no encontrado` });
      }

      // Verificar si el ítem ya está en la orden
      const existingOrder = table.orders.find(order => order.menuItem.toString() === item.id);

      if (existingOrder) {
        // Aumentar la cantidad si ya existe
        existingOrder.quantity += item.quantity || 1;
      } else {
        // Agregar nuevo ítem a las órdenes
        table.orders.push({
          menuItem: menuItem._id,
          quantity: item.quantity || 1
        });
      }
    }

    // Guardar los cambios en la base de datos
    await table.save();

    // Devolver la mesa actualizada con detalles de los ítems
    const updatedTable = await Table.findById(tableId).populate('orders.menuItem');
    res.json(updatedTable);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error al agregar ítems a la mesa' });
  }
});

// Ruta para buscar un mozo por su nombre
router.get('/waiter-by-name/:name', async (req, res) => {
  try {
    const waiterName = req.params.name;
    const waiter = await Waiter.findOne({ name: waiterName });

    if (!waiter) {
      return res.status(404).json({ message: 'Mozo no encontrado' });
    }

    res.json(waiter);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error al buscar el mozo' });
  }
});

// Buscar mozo por ID directamente
router.get('/waiter-by-id/:id', async (req, res) => {
  try {
    const waiter = await Waiter.findById(req.params.id);

    if (!waiter) {
      return res.status(404).json({ message: 'Mozo no encontrado' });
    }

    res.json(waiter);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error al buscar el mozo' });
  }
});

// Asignar un mozo a una mesa
router.put('/:id/assign-waiter', async (req, res) => {
  try {
    const tableId = req.params.id;
    const { waiterId, waiterName } = req.body;

    const table = await Table.findById(tableId);
    if (!table) {
      return res.status(404).json({ message: 'Mesa no encontrada' });
    }

    table.waiterId = waiterId;
    table.waiterName = waiterName;
    await table.save();

    res.json({ message: 'Mozo asignado correctamente', table });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error al asignar el mozo' });
  }
});

// Ruta para vincular mesas
router.put('/:id/link-tables', async (req, res) => {
  try {
    const tableId = req.params.id;
    const { linkedTableIds } = req.body;

    const table = await Table.findById(tableId);
    if (!table) {
      return res.status(404).json({ message: 'Mesa no encontrada' });
    }

    // Verificar que todas las mesas a vincular existan y actualizarlas
    for (let linkedTableId of linkedTableIds) {
      const linkedTable = await Table.findById(linkedTableId);
      if (!linkedTable) {
        return res.status(404).json({ message: `Mesa con ID ${linkedTableId} no encontrada` });
      }

      // Actualizar la mesa vinculada
      linkedTable.controlledBy = tableId; // Indica que está controlada por otra mesa
      linkedTable.available = false; // La mesa vinculada se marca como no disponible
      await linkedTable.save();
    }

    // Actualizar el campo linkedTables de la mesa principal
    table.linkedTables = linkedTableIds;
    await table.save();

    res.json({ message: 'Mesas vinculadas correctamente', table });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error al vincular las mesas' });
  }
});

// Ruta para desvincular mesas
router.put('/:id/unlink-tables', async (req, res) => {
  try {
    const tableId = req.params.id;
    const { linkedTableIds } = req.body;

    const table = await Table.findById(tableId);
    if (!table) {
      return res.status(404).json({ message: 'Mesa no encontrada' });
    }

    // Actualizar cada mesa vinculada
    for (let linkedTableId of linkedTableIds) {
      const linkedTable = await Table.findById(linkedTableId);
      if (linkedTable) {
        linkedTable.controlledBy = undefined; // Elimina la referencia de control
        linkedTable.available = true; // La mesa vuelve a estar disponible
        await linkedTable.save();
      }
    }

    // Filtrar las mesas que se deben desvincular
    table.linkedTables = table.linkedTables.filter(id => !linkedTableIds.includes(id));
    await table.save();

    res.json({ message: 'Mesas desvinculadas correctamente', table });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error al desvincular las mesas' });
  }
});

// Ruta para eliminar órdenes de una mesa
router.put('/:id/remove-order', async (req, res) => {
  try {
    const tableId = req.params.id; // Obtén el ID de la mesa de la URL
    const { orderIds } = req.body;  // Los IDs de las órdenes a eliminar

    console.log('ID de la mesa:', tableId);
    console.log('Órdenes a eliminar:', orderIds);

    const table = await Table.findById(tableId);  // Busca la mesa por ID
    if (!table) {
      return res.status(404).json({ message: 'Mesa no encontrada' });
    }

    // Filtra las órdenes que no se eliminarán
    const ordersToKeep = table.orders.filter(order => !orderIds.includes(order._id.toString()));
    console.log('Órdenes que quedan después de la eliminación:', ordersToKeep);
    
    table.orders = ordersToKeep;

    // Guarda la mesa con las órdenes actualizadas
    await table.save();

    res.json({ message: 'Órdenes eliminadas correctamente', table });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Error al eliminar las órdenes' });
  }
});

// Obtener una mesa específica por ID
router.get('/:id', async (req, res) => {
  try {
    const table = await Table.findById(req.params.id).populate('orders.menuItem');

    if (!table) {
      return res.status(404).json({ message: 'Mesa no encontrada' });
    }

    res.json(table);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error al obtener la mesa' });
  }
});

// Ruta para resetear una mesa
router.put('/:id/reset', async (req, res) => {
  try {
    const tableId = req.params.id;

    // Buscar la mesa por ID
    const table = await Table.findById(tableId);
    if (!table) {
      return res.status(404).json({ message: 'Mesa no encontrada' });
    }

    // Limpiar órdenes
    table.orders = [];

    // Desvincular mesas
    for (let linkedTableId of table.linkedTables) {
      const linkedTable = await Table.findById(linkedTableId);
      if (linkedTable) {
        linkedTable.controlledBy = undefined;
        linkedTable.available = true;
        await linkedTable.save();
      }
    }

    // Limpiar las mesas vinculadas y reiniciar el estado
    table.linkedTables = [];
    table.available = true;
    table.waiterId = undefined;
    table.waiterName = undefined;

    await table.save();

    res.json({ message: 'Mesa reseteada correctamente', table });
  } catch (error) {
    console.error('Error al resetear la mesa:', error);
    res.status(500).json({ message: 'Error al resetear la mesa' });
  }
});

module.exports = router;