require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Conexión a MongoDB Atlas
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('Conectado a MongoDB Atlas'))
  .catch(err => console.error('Error al conectar a MongoDB', err));

// Rutas
const tableRoutes = require('./routes/tableRoutes');
const menuRoutes = require('./routes/menuRoutes');
const waiterRoutes = require('./routes/waiterRoutes');
const balanceRoutes = require('./routes/balanceRoutes');

app.use('/api/tables', tableRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/waiters', waiterRoutes);
app.use('/api/balances', balanceRoutes);

// Ruta raíz para evitar el error 404
app.get("/", (req, res) => {
  res.send("Bienvenido a Coffee Manager API");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en el puerto ${PORT}`));