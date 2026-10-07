---
impacto: nada_mudou
secao: corrigido
titulo: O roteador volta a mostrar o funil e a etapa de destino depois de salvar e recarregar
---

O editor do roteador aceitava salvar o funil e a etapa de destino de uma intenção, mas ao recarregar a página os dois campos voltavam para "Sem destino — só escolher o agente". A gravação existia (o banco e a API de detalhe já lidavam com os campos); o que faltava era a tela enxergar o que estava salvo: a carga inicial do editor (server-side) não selecionava o funil e a etapa de destino dos membros, e o estado editável da tela não reidratava quando a busca em segundo plano devolvia a resposta completa da API.

Agora a carga inicial traz os dois campos e a tela reidrata o destino quando o dado carregado muda — sem sobrescrever uma edição local pendente. A regra continua a mesma: etapa vazia = primeira etapa aberta do funil; funil vazio = só escolher o agente.

Atenção: antes desta correção, salvar as intenções de um roteador regravava sem destino toda intenção cujo funil não tivesse sido escolhido de novo naquele salvamento, porque a tela não enxergava o que estava salvo. O defeito veio com o destino por intenção, nas versões 1.73.0 e 1.74.0. Se algum roteador teve as intenções salvas nesse estado, o funil e a etapa de destino podem ter sido apagados. Vale abrir o editor de cada roteador e conferir. Não há nada a configurar na atualização.

Crédito: @webtecnica, a partir do relato de @Fabricio-Point-Machine.
