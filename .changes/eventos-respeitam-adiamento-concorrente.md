---
impacto: nada_mudou
secao: corrigido
titulo: Eventos respeitam o intervalo de nova tentativa com processadores concorrentes
---
Quando dois processadores leem o mesmo evento e um deles agenda uma nova tentativa, o outro agora respeita esse prazo. Isso evita processamento antecipado e o consumo prematuro de tentativas durante uma falha transitória. Crédito: @samirhvbr.
