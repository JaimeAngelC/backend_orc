import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

// SOLUCIÓN: Agrega las llaves vacías {} dentro de los paréntesis
export const ai = new GoogleGenAI({});
