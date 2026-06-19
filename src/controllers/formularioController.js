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
      return res.status(400).json({ error: 'No se ha recibido ninguna imagen para procesar.' });
    }

    console.log("Procesando formulario SENAVEX basado puramente en extracción de ítems...");

    let descripcionMercaderia = "";
    let subpartidaArancelaria = "";
    
    // Arrays acumuladores para almacenar las celdas e ítems crudos
    let itemsSaldoMercanciaAcumulados = [];
    let itemsExportacionEfectivaAcumulados = [];
    let itemsDetallesEmbarqueAcumulados = [];
    
    // Totales leídos literalmente del papel para contrastar al final
    let totalDisponibleAcumuladoPapel = 0;   // El 6580.975 impreso en el medio
    let saldoDisponibleFinalPapel = 0;       // El 4730.847 impreso al final

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
          `Analiza el formulario de SENAVEX página ${i + 1}. 
           Extrae estrictamente los pesos individuales (TM) de cada fila de las 3 tablas.
           No intentes calcular nada, solo extrae los números tal como aparecen de forma individual.`
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              descripcionMercaderia: { type: Type.STRING },
              subpartidaArancelaria: { type: Type.STRING },
              
              // Tabla 1: Valores individuales (Saldo Inicial, Traspaso Int, Traspaso Ext)
              itemsSaldoMercancia: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    concepto: { type: Type.STRING }, 
                    pesoTM: { type: Type.NUMBER }
                  },
                  required: ["concepto", "pesoTM"]
                }
              },
              
              // Tabla 2: Ítems de Exportación Efectiva
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
              totalDisponibleAcumuladoImpreso: { type: Type.NUMBER }, // Captura del 6580.975 del papel
              
              // Tabla 3: Detalles del Embarque (Abajo)
              itemsDetallesEmbarque: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    noConocimientoEmbarque: { type: Type.STRING }, 
                    pesoTotalTM: { type: Type.NUMBER }
                  },
                  required: ["pesoTotalTM"]
                }
              },
              saldoDisponibleFinalImpreso: { type: Type.NUMBER } // Captura del 4730.847 del papel
            }
          }
        }
      });

      const paginaDatos = JSON.parse(response.text);

      if (paginaDatos.descripcionMercaderia) descripcionMercaderia = paginaDatos.descripcionMercaderia;
      if (paginaDatos.subpartidaArancelaria) subpartidaArancelaria = paginaDatos.subpartidaArancelaria;
      
      if (paginaDatos.itemsSaldoMercancia) itemsSaldoMercanciaAcumulados.push(...paginaDatos.itemsSaldoMercancia);
      if (paginaDatos.itemsExportacionEfectiva) itemsExportacionEfectivaAcumulados.push(...paginaDatos.itemsExportacionEfectiva);
      if (paginaDatos.itemsDetallesEmbarque) itemsDetallesEmbarqueAcumulados.push(...paginaDatos.itemsDetallesEmbarque);

      if (paginaDatos.totalDisponibleAcumuladoImpreso) totalDisponibleAcumuladoPapel = paginaDatos.totalDisponibleAcumuladoImpreso;
      if (paginaDatos.saldoDisponibleFinalImpreso) saldoDisponibleFinalPapel = paginaDatos.saldoDisponibleFinalImpreso;
    }

    // =========================================================================
    // LÓGICA MATEMÁTICA PURA CONTROLADA POR EL BACKEND (CERO ERRORES DE IA)
    // =========================================================================
    const TOLERANCIA = 0.01;
    let listaErrores = [];

    // PASO 1: Sumar Tabla Saldo Mercancía (2581.336 + 0 + 0)
    const totalSaldoMercanciaCalculado = itemsSaldoMercanciaAcumulados.reduce((acc, item) => acc + (item.pesoTM || 0), 0);

    // PASO 2: Sumar Tabla Exportación Efectiva (3999.639 + 0 + 0...)
    const totalExportacionCalculado = itemsExportacionEfectivaAcumulados.reduce((acc, item) => acc + (item.pesoTotalTM || 0), 0);

    // PASO 3: SUMA CRUZADA INTERMEDIA (Total Saldo Mercancía + Total Exportación)
    // Ej: 2581.336 + 3999.639 = 6580.975
    const totalDisponibleAcumuladoCalculado = totalSaldoMercanciaCalculado + totalExportacionCalculado;
    
    // Validamos contra el valor físico del papel
    const acumuladoIntermedioOk = Math.abs(totalDisponibleAcumuladoCalculado - totalDisponibleAcumuladoPapel) < TOLERANCIA;
    if (!acumuladoIntermedioOk && totalDisponibleAcumuladoPapel > 0) {
      listaErrores.push(`Error de Kardex: La suma del Saldo Inicial (${totalSaldoMercanciaCalculado.toFixed(3)} TM) y la Exportación Efectiva (${totalExportacionCalculado.toFixed(3)} TM) da ${totalDisponibleAcumuladoCalculado.toFixed(3)} TM, pero el papel registra ${totalDisponibleAcumuladoPapel.toFixed(3)} TM.`);
    }

    // PASO 4: Sumar Tabla Detalles del Embarque (1500.128 + 350.000)
    const totalEmbarqueCalculado = itemsDetallesEmbarqueAcumulados.reduce((acc, item) => acc + (item.pesoTotalTM || 0), 0);

    // PASO 5: RESTA FINAL DE CIERRE (Total Disponible Acumulado - Total Embarque)
    // Ej: 6580.975 - 1850.128 = 4730.847
    const saldoFinalCalculado = totalDisponibleAcumuladoCalculado - totalEmbarqueCalculado;

    // Validamos contra el saldo final del papel
    const balanceFinalOk = Math.abs(saldoFinalCalculado - saldoDisponibleFinalPapel) < TOLERANCIA;
    if (!balanceFinalOk && saldoDisponibleFinalPapel > 0) {
      listaErrores.push(`Error de Balance Final: El acumulado (${totalDisponibleAcumuladoCalculado.toFixed(3)} TM) menos el embarque (${totalEmbarqueCalculado.toFixed(3)} TM) debería dejar ${saldoFinalCalculado.toFixed(3)} TM, pero el papel declara ${saldoDisponibleFinalPapel.toFixed(3)} TM.`);
    }

    const documentoAprobado = listaErrores.length === 0;

    return res.status(200).json({
      success: true,
      documentoAprobado,
      totalPaginasProcesadas: req.files.length,
      alertasYErrores: listaErrores,
      identificacion: {
        descripcionMercaderia,
        subpartidaArancelaria
      },
      auditoriaContableReal: {
        tabla_1_totalSaldoMercancia: Number(totalSaldoMercanciaCalculado.toFixed(3)),
        tabla_2_totalExportacionEfectiva: Number(totalExportacionCalculado.toFixed(3)),
        
        operacionSumaCruzadaIntermedia: `${totalSaldoMercanciaCalculado.toFixed(3)} + ${totalExportacionCalculado.toFixed(3)} = ${totalDisponibleAcumuladoCalculado.toFixed(3)} TM`,
        totalDisponibleAcumuladoPapel: totalDisponibleAcumuladoPapel,
        
        tabla_3_totalEmbarque: Number(totalEmbarqueCalculado.toFixed(3)),
        
        operacionRestaFinalCierre: `${totalDisponibleAcumuladoCalculado.toFixed(3)} - ${totalEmbarqueCalculado.toFixed(3)} = ${saldoFinalCalculado.toFixed(3)} TM`,
        saldoFinalPapel: saldoDisponibleFinalPapel
      },
      detallesFilasCompletas: {
        tablaSaldoMercanciaInicial: itemsSaldoMercanciaAcumulados,
        tablaExportacionEfectiva: itemsExportacionEfectivaAcumulados,
        tablaDetallesEmbarque: itemsDetallesEmbarqueAcumulados
      }
    });

  } catch (error) {
    console.error('Error en el flujo matemático estricto:', error);
    return res.status(500).json({
      success: false,
      error: 'Error interno en el cálculo matemático del formulario.'
    });
  }
};


