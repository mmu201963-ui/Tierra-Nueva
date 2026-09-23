# SUPREMO V13 — MARKET MICROSTRUCTURE + LEAD/LAG

PAPER only. No Binance API keys required.

## Qué cambia
- Escanea TODO el universo de perpetuos USD-M USDT disponibles en Binance.
- BTC es contexto de mercado, no un filtro que limite las monedas candidatas.
- Añade análisis multi-timeframe de BTC: 1m/5m/15m/1h.
- Añade lead/lag para buscar movimientos que comienzan sin perseguir spikes excesivos.
- Enriquece las mejores candidatas de TODO el mercado con:
  - Open Interest y cambio de OI.
  - Funding.
  - Precio Spot vs Futures (basis/premium simple).
  - Order book imbalance y spread.
  - Taker buy/sell flow.
- Mantiene indicadores técnicos de V12.2 como capa secundaria.
- Coste PAPER configurable: comisión y slippage estimados.
- Máximo 4 posiciones y máximo 2 por dirección.
- Una entrada por ciclo.
- Evita escaneos solapados: el siguiente ciclo empieza después de terminar el anterior.
- No invierte automáticamente LONG/SHORT.

## Importante
La capa de arbitraje se utiliza como **señal relativa/lead-lag**, no como arbitraje ejecutado. El bot no abre dos patas Spot/Futures ni garantiza una ganancia de arbitraje.

Esta versión sigue siendo PAPER y no garantiza beneficios. La finalidad es medir si la información de microestructura y lead/lag mejora la selección frente a V12.2 antes de considerar cualquier operación real.

## Railway
Start Command: `npm start`

Variables opcionales:
- `PORT`
- `INITIAL_CAPITAL` (default 10000)
- `PAPER_FEE_RATE` (default 0.0004)
- `PAPER_SLIPPAGE_BPS` (default 3)
