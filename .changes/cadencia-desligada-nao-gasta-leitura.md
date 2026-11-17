---
impacto: nada_mudou
secao: corrigido
titulo: A cadência desligada deixa de gastar 120 leituras por hora no banco
---

Numa instalação que nunca ligou o módulo de cadências, o cron `cadencia-worker` perguntava "o módulo está instalado?" a cada minuto, e essa pergunta custava duas leituras ao PostgREST (`platform_config` e `modulos_instalados`): 120 idas ao banco por hora só para descobrir que não havia nada a fazer. Agora a rota consulta o retrato do piso ocioso, que responde a mesma pergunta uma vez por janela de 30 s para todas as rotas do processo e não gasta a cota do PostgREST. Com o módulo desligado, a batida sai antes de qualquer leitura; com o módulo ligado, a rodada acontece exatamente como antes, inclusive a auditoria de quem teve inscrição processada.
