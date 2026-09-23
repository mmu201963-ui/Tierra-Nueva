# TIERRA — Real-Time Market Intelligence

Bot PAPER para Binance USD-M Futures. Escanea el mercado USDT y mantiene posiciones simuladas.

## Cambio de esta versión

Cada posición tiene un botón **✕ CERRAR** en su propia ventana.

- El cierre manual usa el precio en vivo de Binance.
- Calcula P&L y comisiones simuladas.
- Registra el motivo `MANUAL_BUTTON`.
- Libera inmediatamente el slot de la posición.
- La moneda entra en cooldown para evitar una reapertura inmediata.
- El bot continúa buscando oportunidades en el siguiente ciclo.
- Se eliminó la regla automática de cierre por pérdida a los 30 segundos; el usuario decide cuándo cerrar manualmente, mientras SL/TP/cambio de régimen/tiempo máximo siguen activos.

## Seguridad

- **PAPER solamente**.
- No utiliza API keys de Binance.
- No coloca órdenes reales.
- No garantiza beneficios.

## Instalación

```bash
npm install
npm start
```

Variables opcionales:

- `PORT` — puerto HTTP.
- `INITIAL_CAPITAL` — capital PAPER inicial; por defecto `10000`.
- `PAPER_FEE_RATE` — comisión simulada; por defecto `0.0004`.
- `PAPER_SLIPPAGE_BPS` — slippage simulado; por defecto `3` bps.

## Interfaz

Cada tarjeta de posición muestra entrada, precio actual, P&L, variación, barra visual y los botones de estado/cierre. Verde = positivo, rojo = negativo y gris = neutral.
