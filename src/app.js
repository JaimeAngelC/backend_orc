import express from 'express';
import dotenv from 'dotenv';
import formularioRoutes from './routes/formularioRoutes.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3002;

// Middlewares estándar
app.use(express.json());

// Cargar las rutas bajo el prefijo /api
app.use('/api', formularioRoutes);

app.listen(PORT, () => {
  console.log(`Servidor HTTP corriendo en http://localhost:${PORT}`);
});
