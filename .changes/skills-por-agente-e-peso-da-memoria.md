---
impacto: capacidade_nova
secao: adicionado
titulo: Cada agente pode escolher as próprias skills, e a Memória da IA mostra quanto pesa no prompt
---

Até aqui toda skill da organização, e toda skill de plataforma mesmo sem instalar, entrava em todo agente. A tela do agente ganhou a seção «Quais skills ele usa». O padrão continua «Usar todas as skills da organização», e é o que todo agente que já existe tem, então nada muda para quem não mexer. Ao desmarcar, a lista começa com todas marcadas, e você desmarca as que não servem àquele agente. A skill que um roteiro de atendimento puxa continua valendo mesmo fora da lista. Uma skill marcada que deixou de existir aparece sinalizada, para você desmarcar. O histórico de versões mostra a troca. Ao instalar uma skill, o aviso diz quais agentes têm lista própria e por isso não a recebem.

A tela Memória da IA passou a mostrar, ao lado dos caracteres, o peso aproximado em tokens. A conta é a mesma que o agente usa: aprendizado arquivado ou vencido não entra. Acima de 1.500 tokens (o recomendado; cada empresa pode escolher outro limite) aparece um aviso de que o texto vai inteiro em toda resposta de todo agente. O aviso só informa: publicar continua igual.

A atualização acrescenta uma coluna às versões de agente. Ela fica vazia em toda versão existente, e vazia quer dizer «todas as skills».

No teste do agente e no rascunho do modo assistido, as notas do contato seguem inteiras no prompt como antes. Só um contato com notas muito longas (mais de cerca de 14 mil caracteres somados) passa a ver o índice das notas, como no atendimento automático.

O histórico da conversa também pode ir ao agente em linhas, um formato mais curto, pela variável `LEAD_CONTEXT_HISTORY_FORMAT=linhas`. Ela vale para a resposta a uma mensagem do cliente, o teste do agente e o rascunho do modo assistido; o follow-up e a resposta a um caso interno seguem no formato de sempre. É experimental e vem desligada (`json`, o formato de sempre).
