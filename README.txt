TIERRA v2.0 ON-FIX

Corrección principal:
- PAPER queda habilitado por defecto al iniciar Railway.
- El botón PRENDER BOT establece botEnabled=true y dispara un nuevo scan.
- PAUSAR BOT establece botEnabled=false y bloquea nuevas entradas, sin borrar posiciones.
- LIVE requiere LIVE_TRADING=true y BOT_ENABLED=true.
- Mantiene 10 posiciones, cierre individual, CERRAR TODO, P&L dinámico y estrategia Bayes/Kelly/Fibonacci.

Variables opcionales:
BOT_ENABLED=false para arrancar PAPER pausado.
