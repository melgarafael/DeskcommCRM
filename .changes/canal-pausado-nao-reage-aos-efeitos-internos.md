---
impacto: nada_mudou
secao: corrigido
titulo: Canal pausado não reage mais: push, follow-up, retorno e automação ficam quietos
---

A pausa de um canal já tirava a conversa da caixa de entrada, acordava a IA e barrava o envio (1.74.0), mas os efeitos internos de uma mensagem recebida continuavam rodando: o push no celular disparava, de conversa individual e de grupo, com uma conversa que nem aparece na lista, o fluxo de follow-up avançava o nó e gravava o texto, o contato era inscrito no gatilho de retorno, e — o que de fato saía para fora — uma regra de automação podia disparar um webhook HTTP de saída com mensagem de canal que o operador acabou de desligar. O follow-up agendado antes da pausa ainda queimava as 5 tentativas do job e virava um Job descartado com aviso crítico na Central, um por follow-up, com o canal desligado e nada a fazer. Agora os cinco leem o canal da própria mensagem antes de agir e respondem "pulado — canal desativado": nada muda para quem está com o canal ligado, e, depois de religar o canal, as mensagens que chegarem voltam a correr como antes, sem reimportar nada. O que chegou ou venceu durante a pausa não é reprocessado: um follow-up que parou num nó do fluxo enquanto o canal estava desligado não volta sozinho. O job de follow-up de canal pausado passa a ser consumido sem erro — fim das retentativas e do alerta crítico.

Contribuição de @webtecnica (#2329).
