---
impacto: capacidade_nova
secao: alterado
titulo: Busca e retorno do atendimento passam pelas ferramentas internas do agente, e o esquema das ferramentas ficou mais enxuto
---

No atendimento, o agente que tinha a busca no acervo e o agendamento de retorno ligados como capacidades recebia duas ferramentas para a mesma coisa em cada passo: a interna (`search_knowledge`, `schedule_followup`) e a do catálogo (`crm_search_knowledge`, `crm_schedule_followup`). Agora, quando a interna está no turno, a do catálogo fica de fora. A capacidade só sai do turno quando a interna está nele; sem material de consulta publicado, ou com o retorno automático desligado, a do catálogo continua. No Operador e para quem integra pelo MCP, nada muda.

A busca interna cita as fontes na resposta, registra a consulta e usa o limiar e a quantidade de trechos configurados no agente. Ela não faz duas coisas que a do catálogo fazia: o agente não escolhe mais quantos trechos quer, e, quando nenhum trecho passa do limiar, ele não recebe a nota do trecho mais próximo (essa nota continua registrada na consulta, para quem administra). O retorno interno recebeu o que só o do catálogo tinha: a escolha do negócio do cliente em que o retorno é anotado, limitada aos negócios principais dele nos funis do agente, e a orientação que separa retorno de compromisso com hora marcada.

O painel de uso das capacidades explica, na linha de cada uma, que esse uso não entra na contagem, e não recomenda mais desligá-las por "nunca usada".

O esquema de cada ferramenta deixou de levar a anotação `$schema`, que não muda nada no que o modelo gera. Há também uma chave nova no `.env`, `LLM_TOOL_SCHEMA_SEM_PADRAO`, desligada por padrão. Ligada (`on`), ela tira do esquema enviado ao modelo o padrão de texto que só repete o formato do campo (id, data, e-mail). A validação dos argumentos não muda. Ela fica desligada até ser avaliada; quem ligar reinicia o app e o worker.

Prompt ou skill que manda chamar `crm_search_knowledge` ou `crm_schedule_followup` pelo nome continua funcionando: no atendimento, quando a ferramenta interna está no turno, a chamada pelo nome do catálogo vai direto para ela, sem passo perdido. Você não precisa editar nada para atualizar.
