---
impacto: capacidade_nova
secao: alterado
titulo: O gate G4 de termos jurídicos passa a ser configurável por organização
---

O gate G4 (`G4_LEGAL_REGEX`) entregava a conversa para um humano sempre que o lead escrevia "procon", "advogado", "processar", "processo judicial", "justiça", "juiz", "reclame aqui", "denúncia", "defensoria" ou "ministério público". Para quase todo nicho isso é sinal de reclamação grave, mas para um escritório de advocacia é o vocabulário normal do cliente (#2097) — quase todo lead caía em handoff e o agente não concluía a qualificação.

A preferência passou a ser por organização, guardada em `organizations.settings.handoff.g4_juridico` (booleano, sem migration). Só o `false` explícito desliga: quem não configurou nada continua com o G4 ligado e com exatamente o mesmo resultado de antes; a ordem das checagens e os textos das demais gates não mudaram, e o pedido explícito de humano (G1) segue disparando do mesmo jeito. A leitura do banco acontece só quando o regex bate, então mensagem sem termo jurídico não ganha consulta extra.

Ainda não há interruptor em tela — a chave é ligada e desligada pelo mesmo caminho de `settings.jev`.

Contribuição de @webtecnica (#2156).
