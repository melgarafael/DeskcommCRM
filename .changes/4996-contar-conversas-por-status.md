---
impacto: capacidade_nova
secao: adicionado
titulo: O agente conta as conversas por situação sem abrir nenhuma delas
---

Quando o agente de IA (ou uma integração por MCP) precisa responder "quantas conversas abertas, pendentes ou com a IA temos?", a nova ferramenta `crm_count_conversations` devolve só números: o total e, sem filtro, o total de cada situação (aberta, pendente, assumida, com a IA, encerrada, arquivada). Antes, a única saída era paginar a lista de conversas, 50 por vez, levando a prévia de cada mensagem ao modelo.

A contagem segue as regras da listagem: só a organização do token, sem contatos pessoais, sem canais desativados e, dentro de uma conversa de atendimento, só o contato da conversa. A ferramenta é só de leitura e vem no pacote "escalar" do modo guiado; no modo avançado qualquer token com permissão de leitura a usa. Nada muda para quem não a usar. Referente à issue #4996, item 2.
