import { ai } from '../config/gemini.js';
import { Type } from '@google/genai';

async function llamarGeminiConReintento(ai, config, maxIntentos = 3, retrasoMs = 2000) {
  for (let intento = 1; intento <= maxIntentos; intento++) {
    try {
      return await ai.models.generateContent(config);
    } catch (error) {
      if (intento === maxIntentos || (error.status !== 503 && error.status !== 429)) {
        throw error;
      }
      console.warn(`[Intento ${intento} fallido] Servidor saturado (503). Reintentando...`);
      await new Promise(resolve => setTimeout(resolve, retrasoMs));
      retrasoMs *= 2;
    }
  }
}

export const procesarFormulario = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No se ha recibido ninguna imagen.' });
    }

    console.log("Procesando formulario SENAVEX con sistema de doble verificación...");

    let subpartidaArancelaria = "";
    let itemsSaldoMercancia = [];
    let itemsExportacionEfectiva = [];
    let itemsDetallesEmbarque = [];

    // VARIABLES EXTRAÍDAS LITERALMENTE DEL PAPEL POR LA IA
    let totalDisponibleAcumuladoPapel = 0;   // El 48547.805 impreso en el medio
    let totalEmbarcadoPapel = 0;              // El 31288.385 impreso abajo
    let saldoDisponibleFinalPapel = 0;        // El 17259.420 impreso abajo a la izquierda

    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const imagenBase64 = {
        inlineData: {
          data: file.buffer.toString('base64'),
          mimeType: file.mimetype
        }
      };

      const response = await llamarGeminiConReintento(ai, {
        model: 'gemini-2.5-flash',
        contents: [
          imagenBase64,
          `Analiza minuciosamente el formulario de SENAVEX página ${i + 1}.
           1. Extrae los pesos individuales de cada fila de las 3 tablas.
           2. Extrae LITERALMENTE los números de los totales impresos:
              - Busca el gran total intermedio impreso en el papel (ej: 48547.805 o 6580.975).
              - Busca el subtotal impreso al pie de la tabla de detalles de embarque (ej: 31288.385 o 1850.128).
              - Busca el saldo disponible final impreso en el bloque de cierre (ej: 17259.420 o 4730.847).`
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              subpartidaArancelaria: { type: Type.STRING },
              itemsSaldoMercancia: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: { concepto: { type: Type.STRING }, pesoTM: { type: Type.NUMBER } },
                  required: ["pesoTM"]
                }
              },
              itemsExportacionEfectiva: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: { empresaOReferencia: { type: Type.STRING }, pesoTotalTM: { type: Type.NUMBER } },
                  required: ["pesoTotalTM"]
                }
              },
              // Totales leídos del formulario
              totalDisponibleAcumuladoImpresoEnPapel: { type: Type.NUMBER },
              
              itemsDetallesEmbarque: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: { fechaEmbarque: { type: Type.STRING }, pesoTotalTM: { type: Type.NUMBER } },
                  required: ["pesoTotalTM"]
                }
              },
              // Totales leídos del formulario
              totalEmbarcadoImpresoEnPapel: { type: Type.NUMBER },
              saldoDisponibleFinalImpresoEnPapel: { type: Type.NUMBER }
            }
          }
        }
      });

      const paginaDatos = JSON.parse(response.text);

      if (paginaDatos.subpartidaArancelaria) subpartidaArancelaria = paginaDatos.subpartidaArancelaria;
      if (paginaDatos.itemsSaldoMercancia) itemsSaldoMercancia.push(...paginaDatos.itemsSaldoMercancia);
      if (paginaDatos.itemsExportacionEfectiva) itemsExportacionEfectiva.push(...paginaDatos.itemsExportacionEfectiva);
      if (paginaDatos.itemsDetallesEmbarque) itemsDetallesEmbarque.push(...paginaDatos.itemsDetallesEmbarque);

      // Guardar lo que la IA leyó directamente del papel
      if (paginaDatos.totalDisponibleAcumuladoImpresoEnPapel) totalDisponibleAcumuladoPapel = paginaDatos.totalDisponibleAcumuladoImpresoEnPapel;
      if (paginaDatos.totalEmbarcadoImpresoEnPapel) totalEmbarcadoPapel = paginaDatos.totalEmbarcadoImpresoEnPapel;
      if (paginaDatos.saldoDisponibleFinalImpresoEnPapel) saldoDisponibleFinalPapel = paginaDatos.saldoDisponibleFinalImpresoEnPapel;
    }

    // =========================================================================
    // CÁLCULOS PROPIOS DEL BACKEND (MATEMÁTICA PURA)
    // =========================================================================
    const totalSaldoMercanciaCalculado = itemsSaldoMercancia.reduce((acc, item) => acc + (item.pesoTM || 0), 0);
    const totalExportacionCalculado = itemsExportacionEfectiva.reduce((acc, item) => acc + (item.pesoTotalTM || 0), 0);
    const totalEmbarqueCalculado = itemsDetallesEmbarque.reduce((acc, item) => acc + (item.pesoTotalTM || 0), 0);

    // Operaciones matemáticas del sistema
    const totalDisponibleAcumuladoCalculado = totalSaldoMercanciaCalculado + totalExportacionCalculado;
    const saldoFinalCalculado = totalDisponibleAcumuladoCalculado - totalEmbarqueCalculado;

    // =========================================================================
    // COMPARACIÓN ELECTRÓNICA DE VERIFICACIÓN
    // =========================================================================
    const TOLERANCIA = 0.01;

    const coincideAcumulado = Math.abs(totalDisponibleAcumuladoCalculado - totalDisponibleAcumuladoPapel) < TOLERANCIA;
    const coincideEmbarque = Math.abs(totalEmbarqueCalculado - totalEmbarcadoPapel) < TOLERANCIA;
    const coincideSaldoFinal = Math.abs(saldoFinalCalculado - saldoDisponibleFinalPapel) < TOLERANCIA;

    const documentoVerificadoOk = (coincideAcumulado && coincideEmbarque && coincideSaldoFinal);

    // Enviar la respuesta dividida nítidamente
    return res.status(200).json({
      success: true,
      documentoVerificadoOk, // TRUE si los cálculos del back coinciden con el papel
      
      // 1. LO QUE SE EXTRAJO DEL FORMULARIO (LEÍDO POR IA)
      datosExtraidosDelPapel: {
        totalDisponibleAcumuladoPapel: totalDisponibleAcumuladoPapel,
        totalEmbarcadoPapel: totalEmbarcadoPapel,
        saldoDisponibleFinalPapel: saldoDisponibleFinalPapel
      },

      // 2. LO QUE EL SISTEMA CALCULÓ (MATEMÁTICA REAL)
      calculosSistemaBackend: {
        totalSaldoMercancia: Number(totalSaldoMercanciaCalculado.toFixed(3)),
        totalExportacionEfectiva: Number(totalExportacionCalculado.toFixed(3)),
        totalDisponibleAcumuladoCalculado: Number(totalDisponibleAcumuladoCalculado.toFixed(3)),
        totalEmbarcadoCalculado: Number(totalEmbarqueCalculado.toFixed(3)),
        saldoDisponibleFinalCalculado: Number(saldoFinalCalculado.toFixed(3))
      },

      // 3. EL RESULTADO DE COMPARAR AMBOS MUNDOS
      resultadoComparacion: {
        totalAcumuladoCoincide: coincideAcumulado,
        totalEmbarqueCoincide: coincideEmbarque,
        saldoFinalCoincide: coincideSaldoFinal
      },

      // Desglose de filas para Flutter
      detallesFilasCompletas: {
        tablaSaldoMercanciaInicial: itemsSaldoMercancia,
        tablaExportacionEfectiva: itemsExportacionEfectiva,
        tablaDetallesEmbarque: itemsDetallesEmbarque
      }
    });

  } catch (error) {
    console.error('Error en el controlador de comparación:', error);
    return res.status(500).json({ success: false, error: 'Error interno en la verificación.' });
  }
};



