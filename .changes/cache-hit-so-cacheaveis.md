---
impacto: nada_mudou
secao: corrigido
titulo: **O aviso de cache hit conta só as chamadas que podem ir para cache**
---
O aviso "Cache hit de prompt abaixo do alvo" parava de fazer sentido em instalações com classificadores: a razão somava no denominador chamadas com menos de **1.024 tokens de entrada**, que nenhum provedor guarda em cache, e o aviso abria e reabria sozinho mesmo com o turno principal cacheando bem. A razão agora considera só as chamadas cacheáveis, ponderada pelos tokens de entrada, e o texto do aviso mostra o **recorte por finalidade e por provedor** — assim o operador vê onde a razão cai (por exemplo, um `checkpoint` a 0,2%) em vez de ler uma causa genérica sobre o prefixo do prompt.
