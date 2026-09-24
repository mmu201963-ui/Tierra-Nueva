TIERRA ADAPTIVE BAYES + KELLY + FIBONACCI v1.5

Implementación aplicada sobre el server.js actual de TIERRA.

Nuevos motores:
- Probabilidad compuesta: edge técnico + microestructura + volatilidad + Fibonacci + contexto BTC.
- Bayesian learning online: actualiza win/loss por lado, régimen y hora UTC después de cada operación cerrada.
- Timing: aprende qué ventanas horarias tienen mejor resultado; no fuerza 65% sin datos suficientes.
- Kelly fraccional: ajusta el tamaño de cada operación según probabilidad estimada y reward/risk, con límites.
- Filtro de volatilidad: evita ATR excesivo.
- Divergencia BTC/activo: penaliza señales contra el contexto BTC y premia alineación/divergencia útil.
- Fibonacci: retrocesos 38.2/50/61.8/78.6 y extensiones 127.2/161.8; se usa como confluencia, no como señal única.
- Recalculo del score DESPUÉS de OI, funding, order book y taker flow.
- Hasta 10 posiciones y cierre individual se mantienen.
- LIVE sigue desactivado salvo LIVE_TRADING=true; primero validar en PAPER.

Importante: esto no garantiza utilidades. La probabilidad es una estimación interna que debe calibrarse con operaciones reales/paper suficientes.
