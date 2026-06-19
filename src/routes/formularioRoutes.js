import { Router } from 'express';
import multer from 'multer';
import { procesarFormulario } from '../controllers/formularioController.js';

const router = Router();

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Cambiado a upload.array() para aceptar hasta 10 fotos simultáneas bajo la clave 'formularios'
router.post('/procesar', upload.array('formularios', 10), procesarFormulario);

export default router;
