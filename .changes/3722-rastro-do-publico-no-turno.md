---
impacto: capacidade_nova
secao: adicionado
titulo: O turno registra por que cada agente do número atendeu ou não o contato (público do agente, rastro da decisão)
---

Desde o público do agente, dois agentes publicados no mesmo número se dividem por funil e etiqueta — mas o turno só dizia "nenhum agente atendeu" ou dava a resposta sem dizer quem foi considerado. Agora a resolução do turno carrega o rastro da decisão e o escreve uma vez no log: a fila de agentes do número na ordem de precedência, a posição de cada um, e a regra que o liberou ou o barrou, com o item declarado na configuração que decidiu (por exemplo, a etiqueta excluída que barrou o agente de vendas para um cliente com contrato). Quem veio depois de quem ganhou aparece como não avaliado, e agente que não declarou público aparece como tal — não como barrado. Número onde nenhum agente declara público não ganha linha nova de log. Sem migração e sem mudança de comportamento: é rastro. Contribuição de @webtecnica (#3722).
