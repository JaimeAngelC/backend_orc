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
      console.warn(`[Intento ${intento} fallido] Servidor saturedo (503). Reintentando...`);
      await new Promise(resolve => setTimeout(resolve, retrasoMs));
      retrasoMs *= 2;
    }
  }
}

export const procesarFormulario = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No se ha recibido ninguna imagen para procesar.' });
    }

    console.log("Procesando formulario SENAVEX con cálculo matemático nativo en Backend...");

    let subpartidaArancelaria = "";
    let codigoSeguimiento = "";
    
    let itemsSaldoMercanciaAcumulados = [];
    let itemsExportacionEfectivaAcumulados = [];
    let itemsDetallesEmbarqueAcumulados = [];

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
           Extrae estrictamente los pesos individuales (TM) fila por fila de las 3 tablas visibles.
           Ignora por completo las celdas de totales o subtotales del papel, solo extrae los ítems individuales.`
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              subpartidaArancelaria: { type: Type.STRING },
              codigoSeguimiento: { type: Type.STRING },
              
              // Tabla 1: Valores individuales superiores
              itemsSaldoMercancia: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    concepto: { type: Type.STRING }, // "Saldo Inicial", "Traspaso Interno", "Traspaso Externo"
                    pesoTM: { type: Type.NUMBER }
                  },
                  required: ["concepto", "pesoTM"]
                }
              },
              
              // Tabla 2: Items de la sección central (Exportación Efectiva)
              itemsExportacionEfectiva: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    empresaOReferencia: { type: Type.STRING }, 
                    pesoTotalTM: { type: Type.NUMBER }
                  },
                  required: ["pesoTotalTM"]
                }
              },
              
              // Tabla 3: Items de la sección inferior (Detalles del Embarque)
              itemsDetallesEmbarque: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    fechaEmbarque: { type: Type.STRING }, 
                    pesoTotalTM: { type: Type.NUMBER }
                  },
                  required: ["pesoTotalTM"]
                }
              }
            }
          }
        }
      });

      const paginaDatos = JSON.parse(response.text);

      if (paginaDatos.subpartidaArancelaria) subpartidaArancelaria = paginaDatos.subpartidaArancelaria;
      if (paginaDatos.codigoSeguimiento) codigoSeguimiento = paginaDatos.codigoSeguimiento;
      
      if (paginaDatos.itemsSaldoMercancia) itemsSaldoMercanciaAcumulados.push(...paginaDatos.itemsSaldoMercancia);
      if (paginaDatos.itemsExportacionEfectiva) itemsExportacionEfectivaAcumulados.push(...paginaDatos.itemsExportacionEfectiva);
      if (paginaDatos.itemsDetallesEmbarque) itemsDetallesEmbarqueAcumulados.push(...paginaDatos.itemsDetallesEmbarque);
    }

    // =========================================================================
    // MATEMÁTICA EXACTA Y CONTROLADA EN NODE.JS (CERO FALSOS ERRORES)
    // =========================================================================
    
    // 1. Sumar Tabla 1: Saldo Mercancía (Ej: 25207.809 + 0 + 0)
    const totalSaldoMercanciaCalculado = itemsSaldoMercanciaAcumulados.reduce((acc, item) => acc + (item.pesoTM || 0), 0);

    // 2. Sumar Tabla 2: Exportación Efectiva (Ej: 23339.996 + 0...)
    const totalExportacionCalculado = itemsExportacionEfectivaAcumulados.reduce((acc, item) => acc + (item.pesoTotalTM || 0), 0);

    // 3. CALCULAR EL ACUMULADO INTERMEDIO (Suma Cruzada)
    // Ej: 25207.809 + 23339.996 = 48547.805
    const totalDisponibleAcumuladoCalculado = totalSaldoMercanciaCalculado + totalExportacionCalculado;

    // 4. Sumar Tabla 3: Detalles del Embarque (Suma de los 25 ítems de la parte inferior)
    const totalEmbarqueCalculado = itemsDetallesEmbarqueAcumulados.reduce((acc, item) => acc + (item.pesoTotalTM || 0), 0);

    // 5. CALCULAR EL DISPONIBLE FINAL (Acumulado - Embarque)
    // Ej: 48547.805 - 31288.385 = 17259.420
    const saldoFinalCalculado = totalDisponibleAcumuladoCalculado - totalEmbarqueCalculado;

    return res.status(200).json({
      success: true,
      identificacion: {
        subpartidaArancelaria,
        codigoSeguimiento
      },
      // Cálculos matemáticos reales generados por el servidor
      calculosSistema: {
        totalSaldoMercancia: Number(totalSaldoMercanciaCalculado.toFixed(3)),
        totalExportacionEfectiva: Number(totalExportacionCalculado.toFixed(3)),
        
        formulaAcumuladoIntermedio: `${totalSaldoMercanciaCalculado.toFixed(3)} + ${totalExportacionCalculado.toFixed(3)} = ${totalDisponibleAcumuladoCalculado.toFixed(3)} TM`,
        totalDisponibleAcumulado: Number(totalDisponibleAcumuladoCalculado.toFixed(3)),
        
        totalEmbarcadoInferior: Number(totalEmbarqueCalculado.toFixed(3)),
        
        formulaBalanceCierre: `${totalDisponibleAcumuladoCalculado.toFixed(3)} - ${totalEmbarqueCalculado.toFixed(3)} = ${saldoFinalCalculado.toFixed(3)} TM`,
        saldoDisponibleFinalProximoFormulario: Number(saldoFinalCalculado.toFixed(3))
      },
      // Desglose completo ítem por ítem para renderizar en Flutter
      detallesFilasCompletas: {
        tablaSaldoMercanciaInicial: itemsSaldoMercanciaAcumulados,
        tablaExportacionEfectiva: itemsExportacionEfectivaAcumulados,
        tablaDetallesEmbarque: itemsDetallesEmbarqueAcumulados
      }
    });

  } catch (error) {
    console.error('Error en el flujo matemático nativo:', error);
    return res.status(500).json({
      success: false,
      error: 'Error interno en el procesamiento del formulario.'
    });
  }
};


