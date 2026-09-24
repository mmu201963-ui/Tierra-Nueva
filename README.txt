TIERRA ADAPTIVE v1.7

NUEVA ESTRATEGIA
- Probabilidad LONG/SHORT basada en convergencia de señales.
- Edge = probabilidad estimada - probabilidad requerida por riesgo/beneficio.
- Bayes adaptativo: posterior Beta por lado + régimen + hora, con shrinkage al posterior global.
- Kelly fraccional (quarter-Kelly) con límite de 0.3%-2.5% de equity por entrada.
- Fibonacci 38.2/50/61.8/78.6 y extensiones implícitas mediante RR adaptativo.
- Filtro de volatilidad y microestructura: OI, funding, taker, order book, spread, basis.
- BTC alignment y lead/lag.
- Recalcula el ranking DESPUÉS de enriquecer la microestructura.
- Máximo 10 posiciones y máximo 5 por lado.

CONTROL
- BOT APAGADO al arrancar por seguridad. PRENDER BOT habilita nuevas entradas.
- PAUSAR BOT detiene nuevas entradas; la gestión de posiciones existentes continúa.
- CERRAR <SIMBOLO> cierra una posición.
- CERRAR TODO cierra todas.

P&L
- Precio de las posiciones se actualiza cada 2 segundos.
- Equity/P&L flotante se recalculan dinámicamente.
- Dashboard muestra tendencia de equity.

MODO
- PAPER por defecto. No activar LIVE_TRADING=true hasta validar en PAPER.
