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
