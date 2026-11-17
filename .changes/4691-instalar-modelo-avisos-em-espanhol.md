---
impacto: nada_mudou
secao: corrigido
titulo: Instalar um fluxo de follow-up a partir de um modelo passa a recusar em espanhol quando a instalação está em espanhol
---

Três avisos da instalação de um fluxo de follow-up a partir de um modelo saíam em português mesmo com a instalação em espanhol: "Este modelo não existe mais.", "Escolha a etapa do funil que dispara este fluxo." e "A etapa escolhida não existe neste funil — escolha outra.". Agora eles saem traduzidos. Junto, a regra de quatro operações da API (testar um roteador, instalar um fluxo a partir de um modelo, alterar e desativar um tipo de agendamento) passou a morar em funções de `lib/`, para que o servidor MCP e as automações usem a mesma regra da tela sem chamar a API por HTTP; as respostas, os códigos e a auditoria continuam os mesmos. Em português nada muda.

Contribuição de @webtecnica (#4691), a partir da proposta de @hudson-souza-mkt (#4688).
