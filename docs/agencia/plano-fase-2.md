# Plano de implementação — Fase 2 (clientes, acervo, tarefas)

> Estado: **construída e publicada no teste.emmovimento.tech** em 24/10/2026, branch
> `feat/agencia-fase-2` (sai da Fase 1). Prova pela tela em `evidence/agencia-fase-2/`.
>
> **Verificação (24/10/2026):** typecheck limpo; testes da agência 13/13 nas regras;
> no Postgres da VPS, baseline install + update sem erro e 60/60 invariantes da agência
> (21 da Fase 1 + 39 da Fase 2). No teste: importar organização, contratação com
> quantidades, equipe do cliente, tarefa para pessoa e para função ("Pegar"),
> cronômetro, atraso em vermelho, relógio de prazos (1 aviso, depois 0) e recorrente
> (gerou 1, depois 0, próxima recalculada), membro vendo só o cliente que atende,
> celular sem rolagem lateral.
>
> **Achados na prova e consertados:** (1) o comentário com aspas no
> `docker/scheduler/entrypoint.sh` quebrou o agendador (ficou ~10 min reiniciando);
> (2) datas mostradas sem fuso apareciam em UTC na tela montada no servidor — agora
> tudo usa `formatarDataHora` (America/Sao_Paulo).
>
> **Não provado ainda:** o Google Drive de verdade (depende do passo do dono no Google
> Cloud) e, por consequência, os anexos; o spec Playwright versionado em `tests/e2e/`.
> Specs aprovadas pelo dono em 24/10/2026 "com as sugestões como estão":
> [`SPEC-clientes`](SPEC-clientes.md), [`SPEC-acervo`](SPEC-acervo.md), [`SPEC-tarefas`](SPEC-tarefas.md).

## Respostas às perguntas em aberto (pelas sugestões)

- Situações do cliente, serviços, as 8 subpastas e as 5 colunas: como propostos.
- Tarefa tem um cliente ou nenhum (interna).
- No Drive, a equipe toda vê a pasta raiz `Clientes` (A4).
- Mover para "Em andamento" **pergunta** se quer iniciar o cronômetro (não inicia sozinho).
- O `scheduler` do teste passa a ser construído com o código do fork.
- Na importação, fica de fora a organização do WhatsApp da agência (`agencia_config.canal_organization_id`).

## Decisões de arquitetura

- **Migration 9004** para a fase inteira + apêndice no `baseline.sql` **antes** da
  varredura de anon. Mesmo regime da 9003: tabelas da instalação, RLS, `revoke all`.
- **Escrita e leitura pelo servidor** (server actions em `app/actions/agencia/`),
  nunca pelo client do navegador (cookie HttpOnly — achado da Fase 1).
- **Arrastar e soltar** com a API nativa de drag-and-drop do navegador + menu
  "Mover para" no cartão (celular e teclado). Sem dependência nova.
- **Posição** dos cartões por `midpoint()` de `lib/kanban/fractional-indexing.ts`.
- **Google Drive** reaproveita o app OAuth da Agenda (`configuracaoDoGoogle`,
  `trocarCodigoPorToken`, `renovarToken`) com endereço de retorno próprio
  (`/api/v1/agencia/drive/callback`) e escopo `drive.file`.
- **Crons novos**: `api/v1/cron/agencia-prazos` (a cada 15 min) e
  `api/v1/cron/agencia-recorrentes` (de hora em hora), com `autorizaCron`;
  entram em `docker/scheduler/entrypoint.sh`.

## Tarefas

| # | Fatia | Pronto quando |
|---|---|---|
| 1 | Banco 9004 + baseline + invariante | install e update do baseline sem erro; anon/authenticated sem acesso |
| 2 | Clientes: lista, ficha (Dados, Contratações, Equipe), importação, criar organização | critérios 1–5 da spec clientes |
| 3 | Tarefas: quadro, lista, ranking, modal, etiquetas, checklist + lote, links | critérios 1, 5, 7, 8, 9 da spec tarefas |
| 4 | Atribuição, função + "Pegar", avisos `tarefa_atribuida` | critério 2 |
| 5 | Cronômetro + lançamento manual | critério 4 |
| 6 | Recorrentes + cron; relógio de prazos + cron | critérios 3 e 6 |
| 7 | Acervo: conectar Drive, pastas, compartilhar, anexos com upload direto | critérios da spec acervo |
| 8 | Início com "minhas tarefas", menu (Tarefas, Clientes, "Mais" no celular) | menu e início |
| 9 | Typecheck, testes da agência, banco na VPS, publicação (app, worker, scheduler) e prova pela tela | todas as specs |

## Pré-requisitos do dono

- No Google Cloud do app da Agenda: ativar a **Google Drive API**, acrescentar o
  escopo `drive.file` e registrar o endereço de retorno
  `https://teste.emmovimento.tech/api/v1/agencia/drive/callback`.

## Riscos

| Risco | Como lidar |
|---|---|
| Upload direto ao Google barrado por CORS | Sessão resumível criada no servidor com o `Origin` da central (o Google aceita CORS nesse caso); se falhar, anexo cai para envio pelo servidor com limite de tamanho |
| Scheduler do fork divergir do original | Mesmo processo do worker, com tag de rollback |
| Tela de tarefas pesada no celular | Lista como padrão abaixo de 768 px; quadro com rolagem horizontal contida |
