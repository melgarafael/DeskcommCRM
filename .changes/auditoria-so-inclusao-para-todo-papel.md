---
impacto: nada_mudou
secao: corrigido
titulo: O registro de auditoria passa a ser só-inclusão para todo papel do banco, inclusive o do worker
---
O registro de auditoria só aceita novas linhas: nenhum papel do banco altera nem apaga o que já está lá, a não ser a limpeza automática por prazo de retenção. Até aqui essa regra valia para uma lista fixa de papéis, e o papel dedicado do worker que o guia de instalação com Postgres próprio manda criar ficava fora dela. Agora vale para qualquer papel, com o nome que você tiver dado a ele, e a atualização reaplica a regra sozinha. O guia de instalação também foi ajustado. Não é preciso fazer nada na instalação.
