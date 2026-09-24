# SOL — Multi-Strategy Engine

Motor PAPER-first para Binance USD-M.

Incluye análisis de tendencia, momentum, RSI, MACD, ATR, volumen relativo,
breakout, mean reversion, funding, open interest, order-book imbalance,
taker flow, contexto BTC, ranking dinámico LONG/SHORT, gestión de posiciones,
TP/SL, break-even, trailing, cooldown y diagnóstico.

## Seguridad

`LIVE_TRADING=false` por defecto. No pongas API keys para probar PAPER.

## Railway

Build/Start:
`npm start`

Variables opcionales:
- `LIVE_TRADING=false`
- `PAPER_CAPITAL=10000`
- `MAX_POSITIONS=10`
- `MIN_SIGNAL_SCORE=0.58`
- `SCAN_INTERVAL_MS=20000`

El sistema no garantiza ganancias. Antes de activar LIVE hay que validar
entradas, cierres y protecciones en PAPER.
