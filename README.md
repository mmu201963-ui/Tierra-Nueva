# TIERRA 1.1 — Real-Time Market Intelligence

PAPER-only Binance USD-M market scanner/trader. Uses public Binance market data and does not place real orders.

## Included controls
- Manual **CERRAR** button on every open position.
- **CERRAR TODAS** button to close every open PAPER position at a fresh Binance ticker price.
- Manual closes are recorded as realized P&L and the symbol enters cooldown.
- After closing all positions, entries are paused briefly so TIERRA does not immediately refill the book in the same cycle.
- Existing SL/TP, regime-flip and max-hold exits remain active.

## Run
```bash
npm install
npm start
```

Railway provides `PORT` automatically. Optional variables:
- `INITIAL_CAPITAL` (default 10000)
- `PAPER_FEE_RATE` (default 0.0004)
- `PAPER_SLIPPAGE_BPS` (default 3)

No Binance API keys are required for PAPER mode because the bot uses public market data only.

This software is an experimental paper-trading system. PAPER results are not a guarantee of live profitability.
