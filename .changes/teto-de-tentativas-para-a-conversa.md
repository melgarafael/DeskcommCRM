---
impacto: capacidade_nova
secao: corrigido
titulo: O limite de "Tentativas antes de desistir" passa a valer de verdade
---

O número configurado em Configurações › Atendimento limitava o contador, não a
repetição: depois de estourar, a conversa continuava sendo tentada para sempre, a
cada rodada, e o aviso da Central voltava junto — o mesmo item reaparecendo para
quem já o tinha dado por visto.

Agora, ao estourar o limite, a distribuição para de tentar, o aviso aparece uma
vez e a conversa fica na fila esperando alguém — como o texto da tela sempre
disse. Ela continua visível no Inbox, sem responsável, e volta a ser distribuída
por um fato novo: mensagem do cliente, disponibilidade da equipe ou reabertura.
