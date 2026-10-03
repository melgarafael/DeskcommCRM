---
impacto: nada_mudou
secao: corrigido
titulo: O guia de montagem para escritório de advocacia deixa de prometer a passagem automática por assunto jurídico
---

O guia que ajuda a montar o agente de um cliente novo dizia que mencionar "advogado", "Procon" ou "justiça" sempre passava a conversa para uma pessoa, antes de qualquer IA. Isso só vale no atendente antigo, que não responde desde a v1.17.0. O agente publicado não tem essa trava fixa: a conversa vai para uma pessoa quando o cliente pede alguém explicitamente, quando aparece uma das palavras de passagem configuradas no agente, ou quando o próprio agente decide chamar a equipe. O guia agora explica esses três caminhos e como ajustá-los pelo prompt. Um teste novo reprova se essa trava fixa passar a rodar em outro lugar sem que o guia seja corrigido junto. Nada muda no comportamento de quem opera. Refs #2097, #2156.
