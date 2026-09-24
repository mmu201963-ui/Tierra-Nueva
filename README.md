# SOL MESH V4

Aplica la arquitectura observada en el bot de referencia: pipeline tipo mesh
SCAN → VET → SIZE → RISK → FILLS → BOOK.

No se copia ni se asume el win-rate mostrado en la captura. Ese resultado no
puede verificarse a partir de una imagen.

El mesh añade:
- veto de estructura superior;
- sizing dinámico por riesgo;
- R:R mínimo;
- límite de drawdown y racha de pérdidas;
- control de spread;
- confirmación de order book/flow sin permitir que lo microstructure anule
  la estructura de 5m/15m;
- dashboard del pipeline.

PAPER por defecto. LIVE_TRADING=false.


## V4.1 — Correcciones
- Reinicia correctamente el pipeline MESH en cada scan.
- La evaluación VET/SIZE/RISK/FILLS/BOOK se calcula una sola vez por candidato y se reutiliza para decidir entradas.
- El rechazo por spread se registra en FILLS, no en VET.
- El dashboard muestra el capital PAPER inicial de forma consistente y expone errores de API en pantalla.
- Incluye `self-test.js` para validar el flujo completo sin dinero real ni claves de Binance.

## Prueba
`npm run self-test` ejecuta una simulación de Binance con datos sintéticos y comprueba health, scan, análisis, MESH, apertura PAPER y cierre individual.
