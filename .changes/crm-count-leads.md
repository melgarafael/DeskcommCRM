---
impacto: capacidade_nova
secao: adicionado
titulo: Agentes e integrações MCP contam leads sem listá-los
---
Nova ferramenta `crm_count_leads`: devolve só números (o total e, sem filtro de status, o total de abertos, ganhos e perdidos), com filtro por funil, etapa e status. Quem precisa responder "quantos leads temos?" deixa de paginar a lista inteira do `crm_list_leads` (que não informa total e leva todos os negócios ao modelo). A contagem respeita as mesmas regras da listagem: só a organização do token, sem contatos pessoais e, em conversa de atendimento, só os negócios do contato da conversa. A ferramenta aparece no pacote "Não perder o cliente" do agente.
