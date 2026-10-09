---
impacto: capacidade_nova
secao: alterado
titulo: Passar a conversa para uma pessoa por assunto jurídico vira uma chave por agente
---

Em quase todo nicho, escrever "procon", "advogado" ou "processo judicial" é sinal de reclamação grave e o sistema entrega a conversa para uma pessoa. Para um escritório de advocacia é o vocabulário normal do cliente (#2097) — quase todo lead caía em passagem e o agente não concluía a qualificação.

A escolha passou a morar NA VERSÃO DO AGENTE: a coluna `ai_agent_versions.handoff_legal_enabled` (booleano, padrão ligado; `add column if not exists` + `comment on column`, e `fn_ai_agent_version_content_immutable` recriada com a coluna nova para a versão publicada continuar imutável). Desligada, só muda a descrição da ferramenta `request_human_handoff`: ela deixa de mandar passar em "questão jurídica" e passa a dizer que assunto jurídico é o trabalho normal daquele atendimento e não é, sozinho, motivo de passagem. O pedido explícito de pessoa (`detectHumanHandoffRequest`) e as palavras de passagem (`handoff_keywords`) continuam sempre ligados, e os demais caminhos para humano — irritação percebida pelo Jev, pedido de não receber mais mensagens, limite de gasto com IA e caso escalado pela equipe — não mudam.

Na tela, o cartão "Passar para uma pessoa" ganha um segundo interruptor embaixo do "Deixar o agente chamar uma pessoa...", desabilitado quando o de cima está desligado. Só admin muda, porque toda escrita de versão já exige admin. A publicação que altera o valor emite `ai_agent.legal_handoff_changed` à parte do `ai_agent.published`, com `version_id`, `previous_version_id` e `enabled` — na primeira publicação, sem versão anterior, a referência é o padrão (ligado) e `previous_version_id` sai `null`. A chave também ganha linha em Recursos opcionais, como `passagem_por_assunto_juridico`.

Contribuição de @webtecnica (#2156).
