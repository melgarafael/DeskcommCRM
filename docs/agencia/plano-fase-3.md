# Plano de implementação — Fase 3 (calendário e reuniões)

> Estado: **construída e publicada no teste.emmovimento.tech** em 24/10/2026, branch
> `feat/agencia-fase-3` (sai da Fase 2). Prova pela tela em `evidence/agencia-fase-3/`.
> Spec aprovada pelo dono em 24/10/2026 "com as sugestões como estão":
> [`SPEC-calendario`](SPEC-calendario.md).
>
> **Verificação (24/10/2026):** typecheck limpo; lint limpo nos arquivos da fase; testes
> unitários da agência 49/49 (16 novos do calendário); no Postgres da VPS, baseline install +
> update sem erro e 73/73 invariantes da agência (13 novos). No teste, pelo membro de teste
> (com uma função temporária com `calendario.gerenciar`, retirada depois): Apresentação
> marcada com título e pauta sugeridos e o Fechamento sozinho uma semana depois, no mesmo
> horário; sem Google, a reunião fica na central e a tela diz o que falta; reunião interna
> marcada como realizada com ata e gravação; "Reuniões de hoje" no Início; aba Reuniões na
> ficha; no celular abre em Próximos, sem rolagem lateral, barra Início · Tarefas ·
> Calendário · Mais. Avisos `reuniao_marcada` para o outro participante; relógio de prazos
> mandou o lembrete de 1 dia uma vez (depois 0), 403 sem o segredo, auditoria só da rodada
> com efeito.
>
> **Achados na prova e consertados:** a aba escolhida (Semana/Próximos) estava sem a cor de
> texto do fundo verde; o dia de hoje usava o mesmo verde das reuniões. As cercas pegaram
> `rounded` puro (também em restos da Fase 2) e dois hosts do Google da Fase 2 sem declarar.
>
> **Não provado ainda:** o evento de verdade na Agenda Google com Meet (depende de o dono
> reconectar o Google com a permissão da Agenda) e a mensagem ao cliente no WhatsApp (o
> número da agência ainda não está conectado no teste). Nem o spec Playwright versionado em
> `tests/e2e/`.

## Respostas às perguntas em aberto (pelas sugestões)

- **K1** — a mesma conta Google (AI Pro) autoriza Drive e Agenda; "Reconectar" uma vez.
- **K4** — o cliente recebe também pelo WhatsApp da agência (chave por reunião, ligada por padrão).
- **K7** — lembretes 1 dia e 1 hora antes, configuráveis.
- **K3** — só ida: a central é a fonte; o que muda direto no Google não volta.

## Decisões de arquitetura

- **Migration 9005** + apêndice no `baseline.sql` antes da varredura de anon. Mesmo regime
  das 9003/9004: tabelas da instalação, RLS, `revoke all`, só o servidor.
- **Uma conexão Google**: `agencia_drive` passa a guardar `escopos text[]`; o consentimento
  pede `drive.file` + `calendar.events`. A Agenda só é usada quando o escopo foi concedido.
- **Evento do Google** direto na API v3 (`calendars/primary/events`, `conferenceDataVersion=1`,
  `sendUpdates=all`), com o access token da conexão da agência. Falha do Google nunca
  impede a reunião: vira `google_erro` na linha e aparece no modal (K10).
- **Lembretes no relógio que já existe** (`agencia-prazos`): sem cron novo, sem reconstruir o
  agendador. Cada marco uma vez (`primary key (reuniao_id, marco)`); marco anterior ao
  momento em que o horário foi definido não dispara (quem acabou de marcar já foi avisado).
- **Remarcar** apaga os lembretes já registrados e define `horario_em` de novo.
- **WhatsApp ao cliente** pela fila que já existe, motivo novo `reuniao`, que respeita a
  janela de horário como o aviso.

## Tarefas

| # | Fatia | Pronto quando |
|---|---|---|
| 1 | Banco 9005 + baseline + invariante | install e update sem erro; anon/authenticated sem acesso; `fim > inicio`; lembrete único |
| 2 | Regras puras (semana, mês, D+7, marcos, visibilidade, texto ao cliente, corpo do evento) + testes | testes verdes |
| 3 | Google: escopo da Agenda, criar/alterar/cancelar evento com Meet | corpo testado; erro vira `google_erro` |
| 4 | Ações: marcar, editar, remarcar, cancelar, situação/ata/gravação; avisos e WhatsApp | critérios 1, 3, 4, 7 |
| 5 | Lembretes no `agencia-prazos` | critério 5 |
| 6 | Telas: calendário (Semana, Mês, Próximos), modal, aba Reuniões, Início, Configurações, menu | critérios 6, 8 |
| 7 | Typecheck, lint, testes, banco na VPS, publicação no teste (app + worker) e prova pela tela | todos |

## Pré-requisitos do dono

- No Google Cloud do app da Agenda (o mesmo do Drive), a **Google Calendar API** já está
  ativa; acrescentar o escopo `calendar.events` à tela de consentimento, se ainda não estiver.
- Em Configurações da agência, clicar em **Reconectar** na conexão Google.
