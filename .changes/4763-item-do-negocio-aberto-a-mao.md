---
impacto: nada_mudou
secao: corrigido
titulo: Negócio aberto à mão num funil de item deixa de nascer sem o item conferido
---

Quando a empresa usa receita de banco externo, o negócio aberto pelo agente com
funil e etapa passados à mão e sem a referência do item nascia sem nenhuma
conferência: numa conversa real, o agente abriu "Casa com piscina em Alphaville —
AU-9999" para um imóvel que não existe. Agora, quando o funil informado é o
destino do interesse de uma receita ativa e a conversa está em andamento, a
criação pede a referência do item e o item é conferido no banco de origem; sem
ela, o agente recebe a explicação e passa a conversa para a equipe em vez de
abrir o negócio.

O que não mudou: criação com referência continua idêntica, e a criação manual em
funil que não é destino de receita continua permitida — com o registro
`funil_a_mao_sem_item` na auditoria da chamada, para que esse negócio não se
confunda com um que veio de um item conferido. Fora do atendimento (rota MCP,
integração), nada é recusado.

Contribuição de @webtecnica (#4785), a partir da medição de @paulolimajr77 com IA real (#4763).
