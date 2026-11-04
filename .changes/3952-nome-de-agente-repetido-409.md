---
impacto: nada_mudou
secao: corrigido
titulo: Nome de agente repetido vira 409 com a frase no campo, não 500
---

Criar (ou renomear) um agente com um nome que a organização já usa furava
`ai_agents_name_unique` e o erro cru do banco virava **500** — "Erro ao criar
agent". Na tela, a pessoa via um toast genérico no canto, sem saber qual campo
estava errado nem que o conserto era trocar o nome.

Agora a recusa é **409** com o envelope de `lib/api/wrappers.ts`, código estável
`agent_name_taken` e frase em pt/es/en — e na tela a frase fica
**embaixo do campo de nome**, com `aria-describedby`, `aria-invalid` e
`role="alert"`, sumindo quando a pessoa digita outro nome.

O discriminador é o **nome do índice**, não o código: `23505` é genérico e
`ai_agents` tem mais de um índice único (além de `ai_agent_versions` na mesma
transação). Traduzir todo `23505` para "nome repetido" trocaria um 500 honesto
por um 409 que mente — e quem tem o nome livre iria embora achando que o defeito
era dele. Mesmo nome em **outra organização** continua criando normalmente.
