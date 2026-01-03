# Coffee Manager API - Migración a NestJS

## ✅ Migración Completada

Este proyecto ha sido migrado exitosamente de Express.js a NestJS manteniendo **todos los endpoints** funcionando exactamente igual.

## 📋 Endpoints Disponibles

### Tables (`/api/tables`)
- `GET /api/tables` - Obtener todas las mesas
- `GET /api/tables/:id` - Obtener una mesa específica
- `POST /api/tables` - Crear nueva mesa
- `PUT /api/tables/:id` - Actualizar mesa
- `DELETE /api/tables/:id` - Eliminar mesa
- `PUT /api/tables/:id/add-items` - Agregar ítems a la mesa
- `GET /api/tables/waiter-by-name/:name` - Buscar mozo por nombre
- `GET /api/tables/waiter-by-id/:id` - Buscar mozo por ID
- `PUT /api/tables/:id/assign-waiter` - Asignar mozo a mesa
- `PUT /api/tables/:id/link-tables` - Vincular mesas
- `PUT /api/tables/:id/unlink-tables` - Desvincular mesas
- `PUT /api/tables/:id/remove-order` - Eliminar órdenes
- `PUT /api/tables/:id/reset` - Resetear mesa

### Menu (`/api/menu`)
- `GET /api/menu` - Obtener todos los ítems del menú
- `POST /api/menu` - Crear nuevo ítem
- `PUT /api/menu/:id` - Actualizar ítem
- `DELETE /api/menu/:id` - Eliminar ítem

### Waiters (`/api/waiters`)
- `GET /api/waiters` - Obtener todos los meseros
- `POST /api/waiters` - Crear nuevo mesero
- `PUT /api/waiters/:id` - Actualizar mesero
- `DELETE /api/waiters/:id` - Eliminar mesero

### Balances (`/api/balances`)
- `GET /api/balances` - Obtener todos los balances
- `POST /api/balances` - Crear nuevo balance
- `DELETE /api/balances` - Eliminar todos los balances

## 🚀 Instalación

```bash
# Instalar dependencias
npm install
```

## ▶️ Ejecutar la aplicación

```bash
# Desarrollo (con hot-reload)
npm run start:dev

# Producción
npm run build
npm run start:prod
```

## 📁 Estructura del Proyecto

```
src/
├── app.module.ts              # Módulo principal
├── app.controller.ts          # Controlador principal
├── app.service.ts             # Servicio principal
├── main.ts                    # Punto de entrada
├── balance/                   # Módulo de balances
│   ├── balance.controller.ts
│   ├── balance.service.ts
│   ├── balance.module.ts
│   └── schemas/
│       └── balance.schema.ts
├── menu/                      # Módulo de menú
│   ├── menu.controller.ts
│   ├── menu.service.ts
│   └── menu.module.ts
├── menu-item/                 # Schema de items del menú
│   └── schemas/
│       └── menu-item.schema.ts
├── tables/                    # Módulo de mesas
│   ├── tables.controller.ts
│   ├── tables.service.ts
│   └── tables.module.ts
├── table/                     # Schema de mesas
│   └── schemas/
│       └── table.schema.ts
├── waiters/                   # Módulo de meseros
│   ├── waiters.controller.ts
│   ├── waiters.service.ts
│   └── waiters.module.ts
└── waiter/                    # Schema de meseros
    └── schemas/
        └── waiter.schema.ts
```

## 🔄 Cambios Realizados

### ✅ Mantenido
- **Todos los endpoints** funcionan exactamente igual
- **Lógica de negocio** completa preservada
- **Estructura de base de datos** MongoDB con Mongoose
- **Variables de entorno** (.env)
- **CORS** habilitado
- **Puerto** configurado desde .env (default: 3000)

### 🆕 Mejorado
- Arquitectura modular con NestJS
- Inyección de dependencias
- Mejor organización del código
- TypeScript con tipado
- Decoradores para rutas HTTP
- Manejo de excepciones mejorado

## ⚙️ Configuración

El archivo `.env` mantiene la misma estructura:

```env
MONGO_URI="mongodb+srv://..."
PORT=3000
```

## 📝 Notas de Migración

1. **Archivos antiguos**: Los archivos Express.js originales (`server.js`, `routes/`, `models/`) se pueden mantener como respaldo pero ya no son necesarios.

2. **Sin cambios en el frontend**: El frontend Angular no necesita cambios, todos los endpoints funcionan igual.

3. **Compatibilidad 100%**: La API responde con el mismo formato JSON que antes.

## 🧪 Pruebas

Puedes probar que todos los endpoints funcionan correctamente con:

```bash
# GET
curl http://localhost:3000/api/tables

# POST
curl -X POST http://localhost:3000/api/menu -H "Content-Type: application/json" -d '{"name":"Café","price":50}'
```

## 📦 Dependencias Principales

- `@nestjs/core` - Framework NestJS
- `@nestjs/mongoose` - Integración con MongoDB
- `@nestjs/config` - Manejo de variables de entorno
- `mongoose` - ODM para MongoDB
- `reflect-metadata` - Necesario para decoradores
- `rxjs` - Programación reactiva

---

**Migración completada exitosamente** ✅
Todos los endpoints mantienen su funcionalidad original.
