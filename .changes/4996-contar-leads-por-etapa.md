---
impacto: capacidade_nova
secao: adicionado
titulo: O agente conta os leads de cada etapa do funil numa chamada só, sem listar nenhum
---

Quando o agente de IA (ou uma integração por MCP) precisa responder "quantos leads tem em cada etapa do funil?", a ferramenta `crm_count_leads` agora aceita `por_etapa`. Com ela ligada, o agente informa o funil e recebe de volta o total de cada etapa, na ordem do quadro, em uma chamada, em vez de uma chamada por etapa ou de paginar a lista inteira de negócios.

A resposta traz só o identificador da etapa e o número, nunca nome nem dados de negócio. A contagem segue as mesmas regras da listagem: só a organização do token, sem contatos pessoais e, dentro de uma conversa de atendimento, só o contato da conversa. Sem `por_etapa`, nada muda.
