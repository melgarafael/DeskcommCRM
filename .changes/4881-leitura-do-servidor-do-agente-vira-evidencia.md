---
impacto: nada_mudou
secao: corrigido
titulo: Ler a agenda pelo servidor MCP do próprio agente deixa de ser vetado como promessa
---

Um agente que usa um servidor MCP **do próprio agente** (cadastro por agente, inclusive `oauth_por_contato`) para consultar uma agenda externa lia o dado certo e, mesmo assim, toda resposta que relatava o que a leitura devolveu era vetada pela conferência semântica de promessa ("promessa/compromisso fora do playbook"). O agente reescrevia, era vetado de novo e a conversa caía para atendimento humano — com o contorno de desligar a conferência de promessa.

A causa era a evidência não existir para esse caminho: a leitura do servidor MCP do agente já era marcada como leitura e executava, mas o nome dela não entrava na lista de leituras remotas do turno, e por isso o resultado nunca virava evidência `servidor_externo` da conferência. Agora a leitura do servidor do agente entra na MESMA lista e produz a MESMA evidência que a leitura do servidor MCP da organização já produzia — servidor, ferramenta e resultado consultado, só para o turno em questão. A conferência não mudou de critério: a frase sem a evidência continua vetada, e promessa comercial de verdade continua vetada.

Ferramenta de escrita não gera essa evidência, leitura que falha não é registrada como sucesso, e a evidência continua restrita à organização e ao contato do turno.

Ajuste a partir da issue #4881.
