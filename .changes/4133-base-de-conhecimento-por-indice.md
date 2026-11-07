---
impacto: capacidade_nova
secao: adicionado
titulo: O agente pode consultar a base de conhecimento por índice, sem chave de embedding
---

O agente ganhou um segundo modo de usar a base de conhecimento, a leitura
direta: ele recebe um índice dos materiais no contexto e lê o material que
precisar pelo id. Esse modo não usa embedding, então funciona mesmo sem a chave
do provedor de busca.

O modo atual, por busca, continua o padrão e não muda nada para quem já usa. A
leitura direta é escolhida por agente na configuração (`knowledge_mode`) e ainda
não tem seletor na tela. O tamanho do índice por turno é limitado pela variável
`KNOWLEDGE_INDEX_MAX_TOKENS` (padrão 600 tokens, cerca de 23 materiais); o que não
cabe é contado no índice, para o agente pedir pelo nome.
