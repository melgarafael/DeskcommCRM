# ADR-0007 — A consulta sai do PostgREST para `pg`, sobre um Postgres nosso; Auth, Storage e Realtime ficam

- **Status:** aceito em 2026-11-03 pelo mantenedor (@melgarafael), na resposta ao documento de decisão do PR #3867; proposta pela @webtecnica em 2026-11-02, na issue #3715 (comentário 6587649631)
- **Data:** 2026-11-02
- **Contexto medido em:** `9a1467d02` (topo de `origin/main` em 02/11/2026); as contagens de arquivo citadas abaixo foram refeitas nesse sha, não herdadas do plano
- **Plano que a detalha:** issue #3715 — https://github.com/melgarafael/DeskcommCRM/issues/3715 (passo a passo, fase a fase; esta ADR registra só a decisão e o porquê)
- **Primeira fatia já construída:** PR #3867 (F1, `lib/tarefas`)

---

## Contexto

A issue #3715 pede, ao pé da letra, "migrar 100% para Postgres para substituir o Supabase".

Lido assim, o pedido é uma **tautologia**: o CRM já é Postgres puro. O próprio prelude de self-host
declara o propósito de rodar o baseline "num POSTGRES PURO (sem Supabase)"
(`scripts/selfhost-prelude.sql:1-4`), e há invariante impedindo que esse caminho divirja do CI
(`tests/invariants/selfhost-prelude-aplica-o-baseline.test.ts:35`). O que a issue descreve, então, não
é uma troca de banco — é o **desejo de sair do fornecedor gerenciado**.

Os três incidentes que motivam a issue confirmam que a peça a trocar é uma só, e não é o banco:

- cota de egress de 5 GB/mês no plano free (`docs/runbooks/custo-e-cota-do-supabase.md:1-4`);
- projeto caindo com `PGRST002`/`522` por falta de compute
  (`docs/runbooks/supabase-compute-insuficiente-free.md:17-24`);
- gateway do Supabase reexecutando requisições antigas (`docs/runbooks/postgrest-replay-do-gateway.md`).

Os três são sintomas de **PostgREST + infraestrutura gerenciada**. Nenhum deles melhora por trocar o
Postgres: o PostgREST continuaria na frente do banco novo.

### Fatos medidos

| Fato | Onde foi medido |
| --- | --- |
| "Migrar para Postgres" não descreve mudança: o schema e as funções já aplicam em Postgres puro, com `auth`/`storage` como stubs | `scripts/selfhost-prelude.sql:1-4`; invariante em `tests/invariants/selfhost-prelude-aplica-o-baseline.test.ts:35` |
| **718** arquivos de código importam o SDK (`@supabase/supabase-js` ou `@supabase/ssr`): `lib/` 370, `tests/` 264, `scripts/` 48, `app/` 31, `hooks/` 1, `curso/` 3, `proxy.ts` 1, `components/` 0, `types/` 0 — e há mais 5 documentos que apenas citam o pacote | comando e saída no sha desta ADR: `git grep -lE 'from "@supabase/(supabase-js\|ssr)"' 9a1467d02 \| wc -l` → **723**, dos quais 5 são `docs/**`; o 769 que circulou vinha de `git grep "@supabase"`, que conta comentário, doc e string (770 menções) |
| A fronteira já existe: três fábricas concentram o SDK, e o frontend não fala com o banco | `lib/supabase/server.ts:75`, `lib/supabase/admin.ts:26`, `lib/supabase/browser.ts:121`; `components/` e `types/` com zero importação |
| RLS **não** é o bloqueio: `lib/` tem **16** arquivos não-teste no cliente de usuário contra **131** no cliente admin, que bypassa RLS por declaração — e **400** arquivos não-teste de `app/` usam o admin client | `lib/supabase/admin.ts:2` ("BYPASSA RLS") e a regra de filtro manual em `lib/supabase/admin.ts:4-17`; comando: `git grep -lE 'from "@/lib/supabase/(server\|admin)"' 9a1467d02 -- lib app \| grep -v '\.test\.\|\.spec\.' \| ...` → lib server 16, lib admin 131, app admin 400, app server 349 |
| Já existe caminho `pg` em produção, maduro, com `query_timeout`, `keepAlive` e listener por cliente | `lib/agent-engine/db/pool.ts:25-65` |
| O custo escondido é o teste, não a sintaxe: os fakes implementam a **forma da cadeia** do PostgREST à mão, e cada domínio migrado quebra o seu | `lib/tarefas/criar-tarefa.test.ts:100-130` (a classe `Cadeia`, com `PromiseLike` no comentário de `:117`) |
| O banco escreve sozinho: **186** gatilhos e **416** funções nomeadas no SQL versionado | nomes distintos (minúsculos) em `supabase/baseline.sql` + `supabase/migrations/`, contados uma vez cada: `git grep -hoiE "create (or replace )?trigger +[a-z0-9_]+" 9a1467d02 -- supabase \| awk '{print tolower($NF)}' \| sort -u \| wc -l` → 186; o mesmo com `function` → 416 |

## Decisão

### D1 — Troca-se o cliente de consulta, e só ele

`@supabase/supabase-js`/PostgREST sai de cena como **cliente de consulta**; o acesso ao banco passa a
ser `pg` com SQL escrito à mão e parâmetros vinculados. **Auth (GoTrue), Storage e Realtime ficam no
Supabase.** A issue não os menciona, os três runbooks não os tocam, e a superfície deles é de outra
ordem de custo: Auth é a única peça em que "migrar" significa "reimplementar" (MFA TOTP, códigos de
recuperação, OAuth Google, PKCE, 58 `auth.getUser()` em produção).

### D2 — A operação é Postgres próprio, e o contrato já está escrito

O destino é **Postgres self-host**, não o banco gerenciado do fornecedor. Esse caminho já é o do
repositório: `scripts/selfhost-prelude.sql` recria roles, schemas e extensões que o dump supõe, e
`auth.uid()` continua lendo `request.jwt.claims` (`scripts/selfhost-prelude.sql:88-94`) — o mesmo
contrato em que as políticas RLS de hoje se apoiam. O limite declarado é honesto e não muda com esta
decisão: login e upload continuam exigindo Supabase real enquanto D1 valer
(`docs/deploy-selfhost/README.md:94-96`).

### D3 — Migração por domínio, com o PostgREST no ar para o resto

Cada domínio troca de cliente num commit próprio. O produto fica inteiro o tempo todo: os domínios
ainda não migrados continuam no PostgREST, e o revert de um domínio é o revert de um commit.

**Dual-write é inviável, e está recusado explicitamente.** Não é preferência: o banco tem 187
gatilhos e 416 funções que escrevem por conta própria (`supabase/baseline.sql`, `supabase/migrations/`).
Não existe forma de "escrever nos dois lados" quando um dos lados é o próprio banco — a segunda
escrita acontece sem o código saber, e a divergência é silenciosa. O que não pode haver é **dois donos
da mesma tabela ao mesmo tempo**; uma janela de minutos por domínio é mais barata que qualquer
mecanismo de reconciliação.

### D4 — O piloto é `lib/tarefas`, e ele já existe no PR #3867

`lib/tarefas` é a menor fatia que prova ponta a ponta: 11 arquivos fora os testes, **9** chamadas
`.from` em 4 deles, e **zero** de tudo o que dói — nenhum `.rpc(`, nenhum embed de PostgREST, nenhum
`.storage`, nenhum `.auth`, nenhum `.channel(`. Ela exercita os quatro caminhos de execução do produto
(rota autenticada, cron sem sessão, Server Action e lib chamada por terceiros) com a forma de consulta
mais comum do repositório.

O PR #3867 fez exatamente isso em 20 arquivos (+1.301/−627): a porta `lib/db/` reusa `createPool` de
`lib/agent-engine/db/pool.ts:25-65` em vez de instanciar outro pool, e `lib/tarefas` ficou com **zero**
`@supabase` e **zero** `.from(`. É a prova de que o adaptador serve; se não servisse, o custo de
descobrir seria 11 arquivos, não 292.

### D5 — A ordem é F0 a F4, e Auth é a última — a única irreversível

| Fase | O que troca | Reversível |
| --- | --- | --- |
| **F0** | a fronteira: `lib/db/` como porta única e lint que proíbe `.from(` fora da lista, que só encolhe | sim, sem risco de runtime |
| **F1** | o piloto `lib/tarefas` (feito, #3867) | sim, revert de commit |
| **F2** | domínios planos (sem embed, sem RPC) | sim, por domínio |
| **F3** | domínios com embed e `onConflict` — `JOIN` explícito e mapeamento aninhado, com teste de contrato do JSON | sim, por domínio |
| **F4** | RPCs: `.rpc("x")` vira `SELECT x($1)`, com `emit_event` tratado num lugar só | sim; as funções SQL não mudam |
| **F5** | Storage (8 buckets, 24 sítios) — só se D1 mudar | cópia, não movimento, até apagar o bucket |
| **F6** | Auth — só se D1 mudar | **não**: hashes de senha, segredos TOTP e sessões não voltam |

F5 e F6 **não** fazem parte desta decisão; aparecem na tabela para deixar claro o que fica de fora e
por que a fronteira é aqui.

### D6 — Nenhuma fase sai sem prova de isolamento por `organization_id`

Com `pg`, o service role deixa de existir: existe a credencial do pool. Para os 144 arquivos de `lib/`
que hoje bypassam RLS, o comportamento é o mesmo — eles já filtram `organization_id` na mão
(`lib/supabase/admin.ts:4-17`). O risco está nos 17 arquivos user-scoped e nas rotas que dependem de
`auth.getUser()`: ali, um `auth.uid()` que não receba `request.jwt.claims` passa verde no teste e vira
vazamento entre tenants. Por isso o critério de saída de **toda** fase inclui um teste provando que a
query sem filtro de organização devolve zero linhas — o harness já existe
(`tests/invariants/`, `vitest.db.config.ts`).

## Consequências

- **Quem opera uma instalação:** nada muda no dia a dia; o Postgres é o mesmo, e os domínios migrados
  deixam de depender do PostgREST para responder. Os três incidentes dos runbooks deixam de ter como
  acontecer nos domínios já migrados.
- **Quem contribui:** `lib/tarefas` passa a ser o exemplo a copiar — SQL com `$1`, erro em exceção,
  porta injetada. A cadeia `from().select().eq()` deixa de ser o idioma do repositório.
- **Testes:** cada domínio migrado troca o fake de cadeia por banco efêmero. O esforço de teste é da
  mesma ordem do esforço de código — é o que faz uma migração "de uma semana" virar seis.
- **Paginação:** o PostgREST cortava em `max-rows` silenciosamente; `pg` devolve o que houver. Toda
  consulta migrada precisa de `LIMIT` explícito ou keyset — sem isso a regressão é de memória, não de
  sintaxe.
- **Segurança:** o isolamento por tenant deixa de ser reforçado pelo banco nos arquivos que hoje usam
  service role e passa a ser disciplina de código **com prova em teste** (D6).
- **Rollback:** nada em F0–F4 é irreversível — schema, funções e dados ficam no mesmo Postgres, e cada
  fase volta por revert de commit.

## Alternativas consideradas e recusadas

| Alternativa | Por que não | Reconsideraríamos se |
| --- | --- | --- |
| **Dual-write** durante a migração | 186 gatilhos e 416 funções escrevem sozinhos no banco: não há como o código escrever "dos dois lados" de uma escrita que ele não fez. O custo é a divergência silenciosa, não o código | nunca, enquanto o schema tiver gatilho de escrita |
| **Sair do Supabase inteiro agora** (Auth + Storage + Realtime no mesmo movimento) | Multiplica o escopo por uma peça que a issue não pede e que é a única irreversível; transforma uma migração de fases numa reescrita de plataforma | depois de F4, com decisão própria e nova ADR |
| **Manter o PostgREST e só pagar mais/upgrade de compute** | Resolve a cota de hoje e mantém os dois incidentes estruturais (replay do gateway, `max-rows` silencioso). É remendo, não decisão | se o custo de operar Postgres próprio se mostrar maior que o do fornecedor — decisão de operação, não de código |
| **ORM (Prisma/Drizzle) sobre o banco** | O schema é escrito à mão em 616 migrations com 416 funções e 186 gatilhos; um ORM cobriria a leitura e mentiria no resto, e ainda esconderia o `LIMIT` que D5 exige explicitar | se a superfície migrada fosse só CRUD sem função — não é o caso |
| **Um PR único, big bang, para os 728 arquivos** | Sem janela por domínio não há rollback por commit; a revisão de 292 arquivos de uma vez não é revisão | nunca |
| **Trocar Auth junto** | 58 `auth.getUser()` em produção são o mecanismo de autorização de toda rota; migrar hashes de senha, MFA e PKCE é projeto, não tarefa | decisão separada do dono, com orçamento próprio |

## O que esta ADR não decide

- **Migrar Auth, Storage ou Realtime.** Ficam no Supabase por D1; cada um, se sair, pede ADR própria.
- **O provedor e a operação do Postgres** — onde roda, quem faz backup, PITR e upgrade de versão. D2
  fixa o destino (self-host), não o fornecedor de infraestrutura.
- **Desempenho e capacidade:** nenhuma meta de latência, pool ou custo por consulta.
- **A ordem interna dos domínios de F2 e F3**, e a estimativa de calendário — estão no plano da issue.
- **O que acontece com `emit_event`** além de "tratado num lugar só" em F4.

## Aceite

**Aceita em 2026-11-03 pelo mantenedor**, com D1–D6 como propostas na issue #3715 em 2026-11-02. O aceite não migra nada: F1
já está construída no PR #3867, e a entrega seguinte é a F0 (a porta e o lint) e depois F2, domínio a
domínio, cada um com teste de isolamento por `organization_id` (D6).

Para ver o que já chegou à `main` e o que está em PR:
`git log --oneline origin/main -- lib/agent-engine/db/pool.ts` e o diff de `lib/tarefas` no #3867.
