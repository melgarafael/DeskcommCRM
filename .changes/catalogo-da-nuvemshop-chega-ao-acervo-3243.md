---
impacto: nada_mudou
secao: corrigido
titulo: O catálogo da Nuvemshop passa a chegar à base de conhecimento do agente
---
Com a loja da Nuvemshop conectada, o agente não enxergava nenhum produto: o aviso de produto alterado saía com um nome que ninguém escutava, a credencial da loja não era lida e a loja recém-conectada nunca recebia a carga inicial. Agora a conexão dispara a carga do catálogo inteiro, e cada alteração de produto na loja atualiza o catálogo todo, preparado em lotes para caber no tempo da fila. Loja com mais de 2 mil produtos recebe um erro claro em vez de um catálogo pela metade. Lojas que já estavam conectadas recebem o catálogo na próxima alteração de qualquer produto, ou ao reconectar a loja. Nada a fazer na atualização. Crédito: @Agenciatektus (#3243).
