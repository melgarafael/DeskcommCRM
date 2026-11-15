---
impacto: nada_mudou
secao: corrigido
titulo: No Testar agente, abrir caso para uma pessoa libera a frase de espera
---

Na aba Testar do agente, quando a IA abria um caso para a equipe e respondia "vou verificar com a equipe, aguarde", o teste barrava a frase como promessa de humano sem caso aberto, embora o atendimento de verdade a deixasse sair. Quem afinava o roteiro corrigia um problema que não existia. Agora o caso proposto no teste, com os campos válidos, conta para essa verificação, e nada é gravado: o caso continua sendo só uma proposta. Quando uma verificação barra a resposta, o aviso aparece no próprio turno da conversa de teste, com o código da regra que cortou, para separar "o agente escreveu errado" de "a regra barrou o texto". Nada a fazer na VPS. Contribuição de @webtecnica (#4620, #4592).
