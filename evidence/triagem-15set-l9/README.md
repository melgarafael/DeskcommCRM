# Prova em tela do lote 9 da triagem — 15/set/2026

As imagens e os registros desta pasta são o lastro da QA visual da integração
`integracao/triagem-15set-l9`, testada no SHA **`cfdb43575`** (worktree limpo,
`git status` vazio antes da primeira escrita nesta pasta).

**Ambiente, o mais perto possível de uma VPS recém-instalada:**

- Supabase local em **Postgres 17.6**, projeto próprio (`qa-l9`, portas 5932x), banco
  montado **só pelo `supabase/baseline.sql`** (`ON_ERROR_STOP=1`, exit 0), sem as
  migrations. Realtime e PostgREST reiniciados depois do baseline, como no CI.
- Chave de cifra semeada em `private.app_secrets`, como o `ensure_encryption_key` do
  `install.sh` faz.
- Dona criada por `scripts/bootstrap-owner.ts`; onboarding concluído **pela tela**,
  pulando o opcional (WhatsApp, IA, funil, teste, equipe).
- `next build` com o `.env.e2e` — **exit 0**, 114 s — e `next start` na porta 3041.
  **Sem chave de IA, sem Resend, sem Google, sem Meta, sem Redis de pé** (o `.env.e2e`
  aponta o Upstash para uma porta vazia, como o do CI).
- Chromium do Playwright com `locale: pt-BR`, `timezoneId: America/Sao_Paulo` e
  `--lang=pt-BR`. O driver recusava rodar se o `.env.e2e` não apontasse para
  `http://127.0.0.1:59321`.
- O cron da VPS foi imitado por um laço local que chama
  `GET /api/v1/cron/event-log-drain` com `Authorization: Bearer <INTERNAL_SECRET>` a
  cada 60 s — o mesmo que o `docker/scheduler/entrypoint.sh` instala no `crond`.
- Hoje é terça, 15/set. A jornada da dona foi publicada pela tela (Equipe ›
  Atendimento: quarta e quinta, 08:00–18:00).

## #877 — automações da Agenda disparam quando uma pessoa marca pela tela

No lote (SHA `cfdb43575`):

- `877-01-regra-quando-horario-marcado-adicionar-tag.png` — Webhooks › Automações ›
  Nova automação: gatilho "Quando um horário for marcado", ação "Adicionar tag"
  `marcou-pela-agenda`. O editor também oferece "Quando um horário pendente for
  confirmado"; o de marcação foi o usado.
- `877-02-regra-ligada.png` — a regra nasce pausada e é ligada pelo interruptor.
- `877-03-agenda-marcando-marina-qua-16-10h.png` — contato "Marina Agenda" criado
  pela tela de Contatos; Agenda › Novo agendamento › Marina › quarta 16 › 10:00.
- `877-04-marcado-pela-agenda.png` — Confirmar: `POST /api/v1/agenda/agendamentos`
  → `201`, "Marcado.". O evento `appointment.created` nasceu em `event_log`
  (lido no banco, não escrito).
- `877-05-atividade-regra-executou-sucesso.png` — no tick seguinte do cron
  (05:28:56, `done: 1`), a aba Atividade mostra "Etiquetar quem marcou horário ·
  Sucesso · Adicionar tag".
- `877-06-contato-com-a-tag-da-regra.png` — Contatos: Marina com a etiqueta
  `marcou-pela-agenda`.
- `877-lote-log-do-servidor.txt` — o log inteiro do `next start` do lote tem **zero**
  "gatilho de automação não foi emitido" e **zero** "violates row-level security
  policy", e os ticks do cron em que o evento foi drenado.

**Controle positivo, na `main` (`b9bc24cf4`)** — worktree destacado próprio,
`next build` exit 0 (111 s), `next start` na 3042 contra **o mesmo banco**, com a
mesma regra ligada:

- `877-controle-main-01-marcando-rui-qua-16-11h.png` — contato "Rui Controle Main"
  criado pela tela da `main`; mesmo painel, quarta 16 › 11:00.
- `877-controle-main-02-marcado-na-main.png` — `201`, "Marcado.": o compromisso é
  gravado.
- `877-controle-main-log-do-servidor.txt` — no mesmo segundo, o servidor da `main`
  registra `[agenda] gatilho de automação não foi emitido … new row violates
  row-level security policy for table "event_log"`. No banco, nenhum
  `appointment.created` para esse compromisso; o dreno da `main` e o do lote não
  acham nada (`scanned: 0`).
- `877-controle-main-03-atividade-so-a-execucao-da-marina.png` — a Atividade segue
  com uma execução só, a da Marina.
- `877-controle-main-04-rui-sem-tag.png` — Rui sem etiqueta.

A mesma sonda (`grep` pela frase do log) que devolve zero no lote achou a linha na
`main`: ela não está cega.

## #871/#872 — avisos na Central

O que foi **SQL** e o que foi **código**, com os comandos e os logs, está em
`871-caminho-sql-x-codigo.txt`. Resumo:

- **SQL:** o canal WAHA da organização (conectar exige WAHA real); e, para a IA, um
  agente publicado nesse canal e os despachos `ai_agent.dispatch_requested` cujo
  `contact_id` não existe (o mesmo cenário do invariante
  `evento-morto-nao-inunda-a-central`). Nenhum SQL tocou `agent_inbox_items`, nem o
  status, as tentativas ou o relógio de backoff de um evento.
- **Código:** as mensagens entraram por `POST /api/v1/webhooks/waha/<token>` com
  HMAC SHA512, como o WAHA entrega — a ingestão real gravou contato, conversa,
  mensagens e emitiu os eventos. O `media.persist_requested` morreu **pelo dreno do
  cron**, tentando baixar do `WAHA_API_BASE_URL` (127.0.0.1:3999, onde nada escuta):
  falhas às 05:24:56, 05:26:56, 05:30:58, 05:38:59 e morte às 05:55:00, no backoff
  real de 2/4/8/16 min. Os despachos da IA morreram **no processo real do worker**
  (`workers/agent-worker/main.ts`): cinco `drain: evento falhou` a cada ~32 s, o
  último `terminal: true`, pela FK de `job_queue`.

Imagens:

- `871-00-central-antes-da-quinta-tentativa-vazia.png` — com o evento de mídia em 3
  tentativas, a Central (sino do cabeçalho › Central de avisos) diz "Nenhum aviso em
  aberto".
- `871-01-central-aviso-generico-evento-morto.png` — 19 s depois da 5ª falha:
  "crítico · Um processamento parou de tentar (media.persist_requested)", corpo em
  português com o motivo, e a única ação é "Marcar resolvido". A palavra
  "reprocessar" não aparece na página (medido por texto, `false`).
- `871-02-central-aviso-da-ia-e-generico-coexistem.png` — **com o aviso genérico
  aberto**, o despacho da IA morre e a Central passa a "Abertos (2)": "A IA deixou de
  responder uma mensagem de cliente", com "Abra o Inbox e responda as conversas que
  estão esperando", e o genérico continua lá. Dois botões "Marcar resolvido";
  "reprocessar" `false`.
- Dedupe, sem imagem própria: mais **três** despachos com o mesmo defeito morreram
  às 06:00:58 (4 `dead` no total) e a Central seguiu com **um** aviso da IA e um
  genérico (contagem por título no banco, no arquivo de texto).
- `871-03-aviso-da-ia-marcado-resolvido-generico-segue-aberto.png` — "Marcar
  resolvido" no aviso da IA: `200`, "Abertos (2)" → "Abertos (1)", o genérico
  intacto.
- `871-04-depois-de-resolvido-a-proxima-morte-reabre-o-aviso-da-ia.png` — um novo
  despacho morto (06:03:37) reabre o aviso da IA: "Abertos (2)" de novo, e o antigo
  fica em Resolvidos. É o que o texto do aviso promete ("marque-o como resolvido
  para voltar a ser avisado").

**Legível, com ressalva:** o título e a consequência estão em português claro, mas o
corpo carrega o nome técnico do evento e o motivo cru — `media_persist_v1: fetch
failed` e, no da IA, a frase inglesa do Postgres `insert or update on table
"job_queue" violates foreign key constraint …`. O título genérico também leva
`(media.persist_requested)`.

**Consertado o corpo, não o título** (`d9a81523e`, branch `triagem/lote-9-qa-consertos`): o
corpo dos dois avisos de evento morto e o do `midia_nao_lida` da falha permanente começam
pelo que aconteceu e pelo que a pessoa pode fazer; o nome do evento, as tentativas e o
motivo cru — sem tradução — ficam no fim, depois de "Detalhe técnico, para quem der
suporte:". Provado por teste (`tests/unit/aviso-de-evento-morto-le-para-leigo.test.ts`,
e a falha permanente pelo worker real em `tests/unit/media-derive-worker.test.ts`), **não
em tela**. O título genérico segue com `(media.persist_requested)`: o invariante
`aviso-da-ia-nao-some-atras-de-outro-evento-morto` conta avisos por esse título literal, e
o pre-commit recusa editar invariante.

**NÃO MEDIDO:** o aviso `midia_nao_lida` que o #872 passa a abrir quando a
**derivação** (transcrição/leitura pela IA) estoura por exceção. Chegar lá exige a
mídia persistida e uma chamada ao provedor de IA que falhe; sem WAHA servindo o
arquivo e sem chave de IA (uma chave inválida mandaria requisição a um host externo),
não houve caminho. O "aviso aberto" usado na coexistência foi o `event_dead`
genérico, não o de mídia.

## #875 — seed de demonstração (`scripts/seed-automacoes-e-followups.ts`)

**(a) Destino remoto:** `875-a-recusa-destino-remoto-sonda-de-rede.txt`. Com
`NEXT_PUBLIC_SUPABASE_URL=https://exemplo-remoto.invalid`, ambiente limpo (`env -i`)
e sem `.env.local` no disco: **exit 2**, a frase de recusa, e a sonda de rede
pré-carregada no processo (`875-a-sonda-rede.cjs.txt`: `fetch`, `http(s).request|get`,
`net.connect`, `dns.lookup`) registra só o pipe local do `tsx`. **Controle da sonda:**
o mesmo destino com `--permitir-remoto` (e um `.e2e-creds.json` fictício noutro
diretório) registra `GET` e depois `POST https://exemplo-remoto.invalid/rest/v1/automation_rules`
e os `dns.lookup` — a sonda vê requisição quando há. `.invalid` não resolve: nenhum
host real foi alcançado.

**(b) Supabase local:** `875-b-seed-local-saida.txt` — `seed-e2e-credentials.ts` →
`seed-crm-vivo.ts` → o seed, duas vezes (exit 0 nas duas; no banco, 3 regras, 3
execuções e 4 inscrições depois da segunda).

- `875-01-seed-automacoes-tres-regras-ativas.png` — logado como `e2e-manager`, a aba
  Automações lista as três regras, todas "Ativa", com gatilho e número de ações.
- `875-02-seed-historico-sucesso-parcial-falha.png` — a Atividade mostra **Sucesso**
  (há 2 horas: Adicionar tag ✓, Atribuir a um atendente ✓), **Parcial** (há 6 horas:
  a atribuição ✗ com `user_not_in_org`) e **Falhou** (há 1 dia, "Quem pede orçamento
  ganha etiqueta": `TypeError: fetch failed`). Cada execução lista as ações da regra a
  que pertence, e `user_not_in_org` é o erro que `assign-owner.ts` devolve de fato.
- `875-03-seed-regra-vip-no-editor.png` — a regra VIP abre no editor com a condição
  no seletor ("Tags do lead contém vip"), não como campo avançado, e as duas ações
  preenchidas.

**(c) Follow-ups:**

- `875-04-seed-followups-fluxo-ativo.png` — Follow-ups › Fluxos: "Retomada de contato
  (demonstração)", Ativo, versão publicada.
- `875-05-seed-followups-fila-com-as-inscricoes.png` — Fila: as quatro inscrições
  (Ativo, Aguardando resposta, Concluído, Pausado por atendimento humano), com o
  próximo disparo nas duas vivas.
- `875-06-seed-followup-dossie-com-trilha.png` — **defeito do lote, reportado e não
  consertado**, abaixo.

### Defeito: a trilha de uma inscrição de demonstração não é coerente

Passo a passo: rode a cadeia de (b), entre como `e2e-manager`, Follow-ups › Fila ›
"Follow-up · esperando resposta".

1. O cabeçalho diz **Começou 15/09/2026 05:31** (o `created_at` da inscrição, gravado
   agora), e a trilha "O que já aconteceu" começa em **12/09** e segue em **13/09** —
   passos anteriores ao início. O seed data os eventos com `daqui(-(i + 2) * DIA)` e
   não recua o `created_at` da inscrição.
2. As duas linhas saem como "Passo registrado pelo motor · código: enrolled" e
   "· código: node_entered" — o `default` de `lib/followup/eventos-legiveis.ts`.
   `node_entered` não é emitido por nenhum código do repositório; `enrolled` só pela
   função de falta à consulta do `baseline.sql`.
3. A inscrição está "Aguardando resposta" em "Retoma o contato", e a trilha termina em
   "Espera 1 dia", sem nenhum passo de envio.

É a mesma classe que o lote consertou no histórico de automações ("só execuções
possíveis"), no lado dos follow-ups. Direção: gerar a trilha pelo vocabulário que o
motor escreve (`node_advanced`, `wait_started`, `action_sent`, `handoff_paused`,
`flow_completed`), coerente com o estado de cada inscrição, com o `created_at` recuado
para o primeiro passo — e levá-la para `scripts/lib/`, onde um teste pode passar cada
evento por `descreveEvento` e reprovar o que cair no `default`.

**Consertado em `5a83d292a`** (branch `triagem/lote-9-qa-consertos`). O motor grava a
trilha por três portas — o tick (`engine.ts`), a conclusão do envio (`turn-bridge.ts`) e a
reatividade a atendimento humano (`reactivity.ts`) —, e a inscrição manual nasce **sem**
passo nenhum (`enroll.ts`). A demonstração passou a ter só isso:

- estado e trilha em `scripts/lib/followups-de-demonstracao.ts`, com o `event_type`, o
  payload e a chave de idempotência (`<nó>:<passos>`) que essas portas gravam, e
  `started_at`/`updated_at`/`completed_at` coerentes com a trilha;
- o grafo ganhou o nó "Espera a resposta" (`match_reply`): o motor só grava
  `waiting_reply` num nó que espera o cliente, então num fluxo que termina na mensagem
  "Aguardando resposta" é um estado inalcançável;
- `tests/unit/followups-de-demonstracao-sao-possiveis.test.ts` reencena cada trilha com
  `runFollowupTick`, `completeTurnForEnrollment` e `applyReactivityEvent` sobre um banco
  em memória e exige os mesmos passos e o mesmo estado final; confere que todo código é
  literal de um módulo que insere em `followup_enrollment_events` (achados no código) e
  que a tela o traduz; e que as datas andam a partir do início. Sabotagens (previsão =
  observado): `node_entered` no lugar de `wait_started` → 6 vermelhos; primeiro passo
  2 dias antes do início → 5; "esperando resposta" parada no nó da mensagem → 1.

Prova em tela, mesma construção do app (`next build` da árvore de `5a83d292a`, e a tela do dossiê
não mudou no conserto), Supabase local próprio (`fx-l9-qa`, portas 5972x, Postgres 17.6,
só o `baseline.sql`), `e2e-manager`, Chromium `pt-BR`/`America/Sao_Paulo`:

- `875-07-dossie-antes-trilha-impossivel.png` — o seed do SHA `e0b68b70f`: "Começou
  15/09/2026 06:26", trilha "código: enrolled" em 12/09 e "código: node_entered" em 13/09,
  "Aguardando resposta" em "Retoma o contato", 2 passos.
- `875-08-dossie-depois-trilha-do-motor.png` — as linhas do fluxo antigo apagadas **do
  banco descartável**, e o seed do conserto: "Começou 13/09/2026 22:28", seis passos em
  ordem a partir do início (Seguiu em frente → Começou a esperar → Seguiu em frente →
  Pediu ao agente para escrever a mensagem → Mensagem enviada → Começou a esperar), a
  inscrição em "Espera a resposta". Nenhuma linha "código:". Os outros três dossiês
  abertos pela mesma sonda (texto, sem imagem): relógio com 2 passos, pausado com
  "Pausado porque uma pessoa assumiu a conversa" depois da espera, concluído com 8
  passos terminando em "Fluxo concluído · esgotou as tentativas".

**Menores, na mesma saída:** na segunda rodada o seed imprime "3 regras ativas, 0
execuções no histórico" e "0 inscrições" com 3 e 4 no banco — conta o que a rodada
gravou e diz que é o estado. E ele manda olhar "abas Regras e Atividade"; a aba se
chama "Automações".

**Consertado** (branch `triagem/lote-9-qa-consertos`, commit do item 2): o resumo relê do
banco o que existe depois da rodada e diz, ao lado, quantas a rodada criou; e manda olhar
"Webhooks › abas Automações e Atividade" e "Follow-ups › abas Fluxos e Fila" —
`tests/unit/resumo-do-seed-diz-o-que-existe.test.ts` lê esses nomes do menu
(`lib/navigation/catalogo.ts`) e dos `TabsTrigger` das telas. Saída real de duas rodadas
no Supabase local descartável, com 3 regras, 3 execuções e 4 inscrições no banco:
`875-09-seed-resumo-duas-rodadas.txt`.

## Regressão do lote 8 na árvore combinada

- `l8-regressao-01-agenda-abre.png` — a Agenda abre, com os dois compromissos em
  Próximos.
- `l8-regressao-02-outro-horario-1045-confirmando.png` — Novo agendamento › quinta 17
  › "Outro horário" › 10:45 › Usar: "Confirmar quinta-feira, 17 de setembro às 10:45".
  O botão Confirmar em 843–875 px, dentro do painel (0–900), `scrollWidth` 1440 =
  `clientWidth` 1440. Não confirmado, para não criar outro compromisso.
- `l8-regressao-03-admin-meta-carrega.png` — `/admin/meta` responde `200` para a dona
  e abre "Nunca configurado por aqui.".

## O que estas imagens NÃO provam

- O aviso `midia_nao_lida` por exceção na derivação (ver acima).
- Uma pane da IA por causa orgânica: o despacho morto foi preparado com um contato
  inexistente. O caminho de morte e de aviso é o de produção; a causa, não.
- O gatilho "horário pendente confirmado" pela tela: não há tela para um tipo exigir
  aprovação (medido no lote 8), e o de marcação cobre o mesmo `emit_event`.
- Remarcar e cancelar pela tela disparando as regras correspondentes.
- A Central a 400 px e no tema escuro.
