# SOL V3 — Multi-Timeframe Decision Engine

PAPER por defecto.

Cambios principales:
- 15m y 5m son filtros estructurales; el flow/order-book no puede anular una contradicción de tendencia superior.
- Estrategias separadas: TREND, PULLBACK, BREAKOUT y REVERSAL.
- LONG y SHORT se evalúan por separado.
- Funding, OI, order book y taker flow son confirmaciones secundarias.
- Volatilidad y volumen mínimo.
- Circuit breaker: pausa nuevas entradas al alcanzar 1% de drawdown del capital inicial o 5 pérdidas cerradas.
- Mantiene TP/SL, break-even, trailing, cierre individual y cierre total.
- LIVE_TRADING=false por defecto.

No es una garantía de rentabilidad. Validar en PAPER antes de considerar LIVE.
