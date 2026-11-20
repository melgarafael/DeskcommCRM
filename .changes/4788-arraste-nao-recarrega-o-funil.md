---
impacto: nada_mudou
secao: corrigido
titulo: Arrastar um card deixa de recarregar o funil inteiro, e a rajada de realtime vira uma leitura só
---

Num funil com milhares de negócios, cada card solto custava uma leitura COMPLETA do quadro — a rota paginada, com as tarefas, anexos, conversas, marcadores, dono, próxima ação e score de cada card. Duas linhas faziam isso: `useMoveCard` invalidava o quadro no `onSettled`, e `useBoard` invalidava a cada evento de `postgres_changes`, sem debounce. Medido na `main 54c12aa3c3`: **1 invalidação por arraste** e **10 invalidações para 10 eventos em 300 ms** (mais uma pelo eco do próprio arraste).

Agora o arraste não relê o quadro: a única reconciliação é a resposta do servidor, fundida no card que se moveu (etapa, posição, `updated_at`, `status`), e o card aparece na coluna de destino antes da resposta chegar. A rajada de realtime do mesmo funil vira **uma** releitura, com janela de 250 ms e teto de 1 s — o teto existe para um fluxo contínuo de eventos não adiar a leitura para sempre. Evento de outro funil, e o eco da própria ação, não reconciliam.

Medido depois: **0 invalidações por arraste**, **1 por rajada de 10 eventos**, **0** para evento de outro funil e **0** para o eco. Nada muda para quem lê o quadro: a convergência continua garantida pela resposta do servidor (etapa divergente corrige a tela), pelo próximo evento de quem mudou o card e pela rede de segurança que confere a assinatura na volta para a aba. Erro e 409 continuam devolvendo o snapshot e relendo, como antes.

Ficou de fora, declarado: o recorte de encerrados antigos da rota continua em memória (`closed_at` já existe na tabela, então levá-lo para o filtro da consulta não precisa de migration — mas mexe na prova de paginação e não é o que trava o arraste; além disso só é calculado quando o funil liga `ocultar_encerrados_dias`). Nenhuma migration, nenhuma coluna nova.
