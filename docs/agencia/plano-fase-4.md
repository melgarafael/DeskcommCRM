# Plano de implementação — Fase 4 (trilha do cliente)

> Estado: **construída e publicada no teste.emmovimento.tech** em 26/10/2026, branch
> `feat/agencia-fase-4` (sai da Fase 3). Prova pela tela em `evidence/agencia-fase-4/`.
> Spec: [`SPEC-trilhas`](SPEC-trilhas.md) — decidida pelas sugestões (o dono pediu, em
> 26/10/2026, para as fases seguirem sem parar para aprovação).
>
> **Verificação (26/10/2026):** typecheck e lint limpos; regras da trilha 15/15; no Postgres
> da VPS, baseline install + update sem erro e 88/88 invariantes da agência (15 novos). No
> teste, pelo membro de teste com uma função temporária de gestão (retirada depois):
> iniciar a trilha "Cliente recorrente" libera só a Apresentação (1 liberado, 19 bloqueados);
> marcar a Apresentação pela trilha liga também o Fechamento que a Fase 3 marca junto;
> Apresentação realizada libera a proposta (prazo D+6) e o Fechamento; "assinado e pago" em
> 20/10 dá contrato a partir de 01/11, preparação até 30/11 e primeira postagem em dezembro
> (regra do dia 15) e libera 6 passos — tarefas com a função certa e os avisos; concluir
> "Identidade visual" no quadro libera "Artes" com prazo no fim da preparação; painel das
> trilhas e editor de modelos; celular sem rolagem lateral. Relógio da trilha: "Vence em 1
> dia: marcar Reunião de Ativação" uma vez, depois 0. Remarcar a Apresentação de 25/10 para
> 28/10 arrastou o Fechamento de 01/11 para 04/11, com aviso.
>
> **Achados na prova e consertados:** no teste **ninguém recebia os avisos gerais** — o
> login do dono não tem perfil de membro e nenhuma função tem "Receber os avisos gerais"; o
> aviso era gravado para ninguém. Configurações agora mostra um alerta quando isso acontece.
> Um membro sem "ver todas as tarefas" não abre a tarefa de outra função pela trilha (é a
> regra de visibilidade da Fase 2 funcionando).
>
> **Não provado ainda:** a trilha com o Google Agenda e o WhatsApp de verdade (dependem da
> reconexão do Google e do número da agência).

## Decisões de arquitetura

- **Migration 9006** + apêndice no `baseline.sql` antes da varredura de anon. Tabelas da
  instalação, RLS, `revoke all`. O modelo "Cliente recorrente" nasce pela própria migration,
  com as funções resolvidas pelo nome (as sete nascem na 9003).
- **Motor idempotente** (`lib/agencia/trilhas/motor.ts`): toda mudança passa por `avancar`,
  que reserva a liberação com `update … where situacao = 'bloqueado'` — dois avanços juntos
  não criam tarefa em dobro.
- **Ganchos** nas ações de tarefas (salvar, mover, apagar) e de reuniões (marcar, mudar,
  cancelar, resultado): o quadro e o calendário continuam sendo onde se trabalha; a trilha
  acompanha.
- **Relógio** no cron `agencia-prazos` (sem cron novo).

## Tarefas

| # | Fatia | Pronto quando |
|---|---|---|
| 1 | Banco 9006 + baseline + invariante | install e update sem erro; modelo com 20 passos; unicidades |
| 2 | Regras puras (dia 15, desbloqueio, prazo, quem faz, validação do modelo) | testes verdes |
| 3 | Motor + ganchos em tarefas e reuniões + arrastar o Fechamento | critérios 2, 5, 7 |
| 4 | Ações (iniciar, concluir marco, pular, recriar tarefa, cancelar, modelos) | critérios 1, 3, 6 |
| 5 | Telas: aba Trilha, painel, editor de modelos, menu | critério 9 |
| 6 | Relógio da trilha no `agencia-prazos` | critério 8 |
| 7 | Verificação, banco na VPS, publicação e prova pela tela | todos |
