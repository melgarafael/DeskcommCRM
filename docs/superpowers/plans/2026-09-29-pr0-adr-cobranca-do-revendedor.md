# ADR-0004 (PR 0 da cobrança do revendedor) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Registrar, só em documentação, o terceiro eixo de dinheiro do produto (o dono de uma instalação cobra as empresas que atende) como a ADR-0004, e reconciliar com ela todo documento que hoje diz o contrário ou diz de um jeito que envelhece quando a cobrança chegar.

**Architecture:** Um arquivo novo (`docs/adr/0004-cobranca-do-revendedor.md`) com o peso das duas tabelas vazias medido num Postgres 17 descartável, mais edições pontuais (old → new) em sete documentos. Nenhum código, nenhuma migration, nenhum fragmento `.changes/`. O "teste" de cada tarefa é uma sonda `grep` com contagem esperada antes (vermelho) e depois (verde), mais o gate que já existe para documentos de autoridade, `tests/unit/documentacao-aponta-para-o-que-existe.test.ts`, que reprova link relativo morto e caminho em crase que não existe.

**Tech Stack:** Markdown; `grep`; Docker com `pgvector/pgvector:pg17` (a imagem que o `test:db` usa, já presente localmente) para a medição; Vitest (`pnpm exec vitest run`, `pnpm test:unit`).

**Spec:** `docs/superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md` (§14 PR 0; decisão D-1; §1.1, §1.2, §2.2, §2.3, §16 item 2.A).

## Global Constraints

- Trabalho na worktree existente `/Users/rafaelmelgaco/deskcomm-saas/spec`, branch `docs/spec-cobranca-do-revendedor`. O PR 0 leva **a spec e a ADR juntas**: a ADR linka a spec, e o gate de links reprova link para arquivo que não existe na branch. Todo `cd` é `cd /Users/rafaelmelgaco/deskcomm-saas/spec || exit 1`.
- Número da ADR: `0004` (medido em 29/09/2026: `docs/adr/` da `origin/main` tem 0001, 0002 e 0003; nenhum dos 15 PRs abertos toca `docs/adr/`). Reconfira no Task 1, Step 1.
- O texto da ADR usa "capacidade do núcleo com chave da instalação" para a cobrança; **nunca** a classifica como "módulo". A palavra "módulo" só aparece para nomear o conceito da ADR-0002 (para contrastá-lo), módulos reais (comanda, honorários) ou o caminho de código existente `lib/instalacao/modulos.ts`.
- Documento de autoridade (`docs/adr`, `docs/doctrine`, `docs/index.md`, entre outros — lista em `tests/unit/documentacao-aponta-para-o-que-existe.test.ts`, constante `AUTORIDADE`) **não** cita em crase caminho de arquivo que ainda não existe (`lib/organizacao/operante.ts`, `lib/cobranca/vocabulario.ts`, o arquivo do PR #307 com prefixo `docs/adr/`...). Diretório sem extensão (`lib/cobranca/`) não é cobrado pelo gate e pode aparecer.
- Afirmação de estado que envelhece vira comando (`git log ... -- lib/cobranca`, `grep -n ...`), nunca "a cobrança já existe" nem "hoje devolve 0".
- Não editar a ADR-0002 nem a ADR-0003 (registro histórico). A revisão da condição 2 mora na ADR-0004.
- Não rodar `prettier --write` em nenhum `.md` (o `format:check` não está no CI e reformataria arquivos inteiros; linha de tabela desalinhada renderiza igual).
- Sem fragmento `.changes/`: PR só de documentação não muda comportamento visível a quem opera uma VPS (DoD 17; `docs/doctrine/versionamento.md`, "Todo PR que muda comportamento traz um arquivo em `.changes/`"; `lib/release/fragmento.ts` só valida forma, não cobra presença).
- Commits: conventional em pt-br, corpo via heredoc `<<'FIM'` (crase e `$` em aspas duplas são executados pelo shell), terminando com a linha `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- `git push` e abertura de PR são ação de impacto externo: **exigem confirmação explícita do dono do produto no momento do envio**. A aprovação do plano não cobre publicação.

## Review Focus

1. **Leitor que conclui que o projeto passou a vender assinatura.** Toda frase editada nomeia o eixo (mantenedor / operador de agentes / dono da instalação); VISION, LP e a doutrina continuam dizendo, sem ambiguidade, que o projeto não vende assinatura. Pinado pelas sondas dos Tasks 2 e 3 (a frase "Nós não vendemos assinatura" continua presente).
2. **Link ou caminho em crase para arquivo que só existirá nos PRs seguintes**, em documento de autoridade. Pinado por `pnpm exec vitest run tests/unit/documentacao-aponta-para-o-que-existe.test.ts` ao fim de cada task que toca documento de autoridade (Tasks 1, 2, 5).
3. **A régua nova da brecha "Faturamento e planos" lida como fechada quando as tabelas `cobranca_*` aparecerem.** A pergunta nova classifica essas tabelas como eixo 3 por escrito, e o Task 2 roda a sonda nova com um controle positivo (`cobranca_planos` sintético aparece na saída).
4. **Placeholder de medição esquecido na ADR** (`{{PESO_...}}`). Pinado pelo Step 7 do Task 1 (`grep -c '{{PESO'` → `0`).
5. **"Módulo" classificando a cobrança**, o que reabriria a discussão da ADR-0002. Pinado pelo Step 8 do Task 1 (cada ocorrência revisada contra o critério das Global Constraints).

---

### Task 1: A ADR-0004, com o peso medido, e o índice que aponta para ela

**Files:**
- Create: `docs/adr/0004-cobranca-do-revendedor.md`
- Modify: `docs/index.md:100` (duas linhas novas logo depois da linha da ADR-0002)
- Test: `tests/unit/documentacao-aponta-para-o-que-existe.test.ts` (existente, não muda)

**Interfaces:**
- Consumes: a spec (§14 PR 0, D-1, §2.2, §2.3, §16 2.A); `docs/adr/0002-tabelas-de-modulo-num-banco-so.md` (condição 2, D4, D7, D9, "O que esta ADR não decide" sobre o caixa).
- Produces: o arquivo `docs/adr/0004-cobranca-do-revendedor.md`, que os Tasks 2–4 linkam como `../adr/0004-cobranca-do-revendedor.md` (de `docs/<pasta>/`) ou `docs/adr/0004-cobranca-do-revendedor.md` (da raiz), com as seções "Relação com a ADR-0002" e "Relação com a doutrina de operação de agentes".

- [ ] **Step 1: Branch limpa, atualizada com a main, e número livre**

```bash
cd /Users/rafaelmelgaco/deskcomm-saas/spec || exit 1
git status --short                       # esperado: vazio (árvore limpa; se não, PARE — não é sua)
git fetch origin
git merge origin/main -m "chore: traz a main para a branch da spec da cobrança"
git ls-tree --name-only origin/main docs/adr/
gh pr list --state open --limit 200 --json number,title,files \
  --jq '.[] | select([.files[].path] | any(startswith("docs/adr/"))) | "\(.number) \(.title)"'
```

Esperado: o merge entra sem conflito (a branch só acrescenta `docs/superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md`); `ls-tree` lista só `0001-…`, `0002-…`, `0003-…`; o `gh` não imprime nada. Se aparecer `0004-*` na main ou num PR aberto, use o próximo número livre e troque `0004` em todo este plano. (Ressalva: `--json files` corta em 100 arquivos por PR; se algum PR aberto tiver mais que isso, confira-o com `git diff --name-only origin/main...refs/pull/<N>/head -- docs/adr`.)

- [ ] **Step 2: Os documentos citados não andaram desde a medição deste plano**

```bash
cd /Users/rafaelmelgaco/deskcomm-saas/spec || exit 1
git diff --stat 9b63075bf origin/main -- docs/doctrine/operacao-de-agentes.md \
  docs/specs/19-spec-console-de-agencia.md VISION.md docs/growth/lp-plano.md \
  docs/business-rules/00-business-rules-catalog.md docs/doctrine/extensoes.md docs/index.md \
  docs/adr supabase/baseline.sql docs/white-label.md lib/instalacao/modulos.ts \
  lib/mcp/rate-limit.ts lib/api/auth-dual.ts "app/api/v1/admin/tenants/[id]/suspend/route.ts"
```

Esperado: saída vazia. Se algum arquivo aparecer, releia o trecho dele que este plano edita ou cita antes de seguir, e troque `9b63075bf` na linha "Contexto medido em" da ADR pelo `git rev-parse --short origin/main` do dia.

- [ ] **Step 3: Escrever o teste que falha — o índice aponta para a ADR que ainda não existe**

Em `docs/index.md`, logo depois da linha que começa com ``| [`adr/0002-tabelas-de-modulo-num-banco-so.md`]`` (linha 100 hoje), acrescente:

old:
```markdown
| [`adr/0002-tabelas-de-modulo-num-banco-so.md`](adr/0002-tabelas-de-modulo-num-banco-so.md) | **Aceita em 17/09/2026.** Tabelas de módulo opcional: um banco só, `public`, criadas por função provisionadora fixa quando o módulo é instalado |
```

new:
```markdown
| [`adr/0002-tabelas-de-modulo-num-banco-so.md`](adr/0002-tabelas-de-modulo-num-banco-so.md) | **Aceita em 17/09/2026.** Tabelas de módulo opcional: um banco só, `public`, criadas por função provisionadora fixa quando o módulo é instalado |
| [`adr/0003-perfil-declarativo-v2-portas-nomeadas-e-vitrine.md`](adr/0003-perfil-declarativo-v2-portas-nomeadas-e-vitrine.md) | **Aceita em 17/09/2026.** Perfil declarativo v2 das extensões: portas nomeadas e o metadado de loja no catálogo |
| [`adr/0004-cobranca-do-revendedor.md`](adr/0004-cobranca-do-revendedor.md) | **Aceita em 29/09/2026.** Cobrança do revendedor: o terceiro eixo de dinheiro — o dono da instalação cobra as empresas que atende; capacidade do núcleo com chave, desligada por padrão; revisa a condição 2 da ADR-0002 só para este caso |
```

(A linha da ADR-0003 entra junto porque o índice pulava dela; a tabela de ADRs fica completa.)

- [ ] **Step 4: Rodar o teste e ver falhar**

Run: `cd /Users/rafaelmelgaco/deskcomm-saas/spec || exit 1; pnpm exec vitest run tests/unit/documentacao-aponta-para-o-que-existe.test.ts`

Expected: FAIL em "nenhum link relativo aponta para arquivo que não existe", com a linha `docs/index.md → adr/0004-cobranca-do-revendedor.md` (e só ela). Se falhar com outra linha, ela já estava morta antes deste plano: anote e não conserte aqui.

- [ ] **Step 5: Medir o peso das duas tabelas vazias num Postgres 17 descartável**

```bash
cd /Users/rafaelmelgaco/deskcomm-saas/spec || exit 1
docker run -d --rm --name adr0004-peso -e POSTGRES_PASSWORD=descartavel pgvector/pgvector:pg17
# o entrypoint sobe um servidor temporário e depois o definitivo: espere o 2º "ready"
until [ "$(docker logs adr0004-peso 2>&1 | grep -c 'ready to accept connections')" -ge 2 ]; do sleep 1; done
docker exec -i adr0004-peso psql -U postgres -v ON_ERROR_STOP=1 -At <<'SQL'
-- Esteios mínimos para o DDL da spec compilar fora do baseline
create role anon; create role authenticated; create role service_role;
create table public.organizations (id uuid primary key default gen_random_uuid());
create function public.fn_role_at_least(p_org uuid, p_min text) returns boolean
  language sql stable as $$ select false $$;

-- §2.2 da spec, verbatim
create table if not exists public.cobranca_planos (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (char_length(nome) between 1 and 60),
  preco_cents bigint not null check (preco_cents >= 500),
  moeda text not null default 'BRL' check (moeda = 'BRL'),
  intervalo text not null check (intervalo in ('mes','ano')),
  trial_dias integer not null default 14 check (trial_dias between 0 and 90),
  max_assentos integer check (max_assentos >= 1),
  max_canais integer check (max_canais >= 1),
  teto_ia_usd_cents integer check (teto_ia_usd_cents >= 100),
  padrao_no_cadastro boolean not null default false,
  arquivado_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create unique index if not exists cobranca_planos_um_padrao
  on public.cobranca_planos ((true)) where padrao_no_cadastro and arquivado_em is null;
alter table public.cobranca_planos enable row level security;
revoke all on public.cobranca_planos from anon, authenticated;
grant select, insert, update, delete on public.cobranca_planos to service_role;

-- §2.3 da spec, verbatim
create table if not exists public.cobranca_assinaturas (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  plano_id uuid not null references public.cobranca_planos(id) on delete restrict,
  plano_agendado_id uuid references public.cobranca_planos(id) on delete restrict,
  estado text not null default 'trial' check (estado in ('trial','ativa','em_atraso','cancelada')),
  trial_ate timestamptz,
  provedor text check (provedor in ('stripe','asaas')),
  modo text check (modo in ('teste','producao')),
  provedor_cliente_id text,
  provedor_assinatura_id text,
  vencida_desde timestamptz,
  proximo_vencimento timestamptz,
  cancela_no_fim boolean not null default false,
  prazo_extra_ate timestamptz,
  ultimo_aviso text check (ultimo_aviso in ('trial_acabando','venceu','suspende_em_breve','suspensa')),
  ultimo_aviso_em timestamptz,
  checkout_url text, checkout_expira_em timestamptz,
  relida_em timestamptz,
  assinaturas_vivas integer not null default 0,
  ultimo_erro text check (ultimo_erro in ('credencial_invalida','provedor_fora','pagamento_de_assinatura_cancelada','leitura_invalida')),
  ultimo_erro_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((provedor is null) = (provedor_cliente_id is null))
);
create unique index if not exists cobranca_assinaturas_cliente
  on public.cobranca_assinaturas (provedor, provedor_cliente_id) where provedor is not null;
alter table public.cobranca_assinaturas enable row level security;
create policy tenant_isolation_cobranca_assinaturas_select on public.cobranca_assinaturas
  for select to authenticated using (public.fn_role_at_least(organization_id, 'admin'));
revoke all on public.cobranca_assinaturas from anon, authenticated;
grant select on public.cobranca_assinaturas to authenticated;
grant select, insert, update, delete on public.cobranca_assinaturas to service_role;

-- A medição
select c.relname, pg_total_relation_size(c.oid)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname in ('cobranca_planos','cobranca_assinaturas')
 order by 1;
select sum(pg_total_relation_size(c.oid)), pg_size_pretty(sum(pg_total_relation_size(c.oid)))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname in ('cobranca_planos','cobranca_assinaturas');
SQL
echo "exit=$?"
docker stop adr0004-peso
```

Expected: `exit=0` e três linhas no fim. Estimativa (não é o número a publicar): cada tabela vazia pesa três páginas de 8 KB — dois índices btree e o índice da TOAST —, então `cobranca_assinaturas|24576`, `cobranca_planos|24576` e `49152|48 kB`. **O que vai para a ADR é o impresso.** Anote os dois valores da última linha (bytes e legível). Se o psql abortar (`exit` ≠ 0) — por exemplo no índice `((true))` —, isso é defeito do DDL da spec (§2.2): pare e reporte ao dono do plano com a mensagem de erro; não mude o DDL por conta própria.

- [ ] **Step 6: Escrever a ADR**

Crie `docs/adr/0004-cobranca-do-revendedor.md` com o texto abaixo, inteiro:

```markdown
# ADR-0004 — Cobrança do revendedor: o dono da instalação cobra as empresas que atende

- **Status:** aceito em 2026-09-29 pelo dono do produto, junto com o desenho e as decisões D-1…D-14 dele
- **Data:** 2026-09-29
- **Contexto medido em:** `9b63075bf` (topo de `origin/main` em 29/09/2026); o peso das tabelas, num Postgres 17 descartável no mesmo dia
- **Lei que muda quando aceita:** [`docs/doctrine/operacao-de-agentes.md`](../doctrine/operacao-de-agentes.md) — §0, a brecha "Faturamento e planos" da §3 e as proibições 2 e 3 da §4 — e, **só para este caso**, a condição 2 da [ADR-0002](0002-tabelas-de-modulo-num-banco-so.md)
- **Desenho que a detalha:** [`docs/superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md`](../superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md)

---

## Contexto

O produto tinha duas respostas escritas para "quem cobra quem":

1. **O mantenedor não vende assinatura.** O software é MIT, completo e sem versão paga; o projeto
   se sustenta por infraestrutura, na parceria de VPS ([`VISION.md`](../../VISION.md), "Modelo do
   projeto").
2. **O operador de agentes cobra retainer por cliente operado.** Decidido em 13/09/2026
   ([`operacao-de-agentes.md`](../doctrine/operacao-de-agentes.md) §0 e a spec 19). O faturamento
   desse eixo continua proibido antes do primeiro operador que paga (§4, proibição 2).

Uma terceira pessoa já existia e não tinha ferramenta: **quem instala o sistema para outras
empresas e cobra por isso**. O guia de marca própria autoriza desde sempre — "você pode modificar,
hospedar para terceiros, revender e cobrar o que quiser" ([`docs/white-label.md`](../white-label.md)) —,
e a instalação já é multiempresa, com marca por instalação e por organização. O que falta é o dono
da instalação transformá-la num SaaS próprio: criar planos, dar teste grátis às empresas novas,
receber por um checkout hospedado, avisar quem atrasa, suspender depois de uma tolerância e liberar
sozinho quando o pagamento entra.

Três fatos moldam a decisão:

| Fato | Onde foi medido |
|---|---|
| A suspensão de empresa que existe hoje troca `organizations.status` e mais nada: a IA, as automações e os envios da empresa suspensa não leem esse status | o `update` de status em `app/api/v1/admin/tenants/[id]/suspend/route.ts`; os pontos de corte que faltam estão enumerados na §4 do desenho |
| As travas que um plano precisa — pessoas, números conectados, teste grátis na criação da empresa — têm de morar em tabelas do núcleo: `user_organizations`, `channel_sessions`, `organizations` | §2.6 e §5 do desenho |
| A VPS de quem instala não compila código: ela baixa imagem pronta, e o `update.sh` regrava a imagem a cada atualização | `hostgator-setup-kit/update.sh`; [doutrina de packaging](../doctrine/packaging.md) |

### A tentativa anterior (PR #307)

O PR #307 ("Pivot SaaS pago (Genesisia Contabilidade): billing Asaas + fundação contábil") propôs
outra coisa: uma **instância hospedada paga**, sob uma marca, vendendo assinatura — o eixo 1
invertido. Trazia a própria ADR, no arquivo `0002-pivot-saas-pago.md`, com o número que a `main`
deu depois à ADR-0002 das tabelas de módulo. Foi fechado sem merge em 24/08/2026. Esta ADR não o
retoma: aqui quem cobra é quem instala, nunca o projeto. O que os dois desenhos têm em comum —
desligado por padrão, Asaas como provedor, suspensão pelo `organizations.status` — é convergência
registrada, não herança de código.

---

## Decisão

### D1 — Existe um terceiro eixo de dinheiro, e ele é de quem instala

| Eixo | Quem cobra | De quem, e como | Onde está decidido |
|---|---|---|---|
| 1 | o mantenedor | de ninguém: não vende assinatura; o projeto vive de infraestrutura | [`VISION.md`](../../VISION.md) |
| 2 | o operador de agentes | das empresas que ele opera: retainer por cliente operado | [`operacao-de-agentes.md`](../doctrine/operacao-de-agentes.md) §0; spec 19 |
| 3 | o dono de uma instalação (administrador da plataforma) | das empresas da própria instalação: planos, teste grátis, checkout hospedado (Stripe ou Asaas), régua de atraso | esta ADR e o desenho |

Os três convivem. O eixo 3 não autoriza o eixo 1 a vender nada, e não constrói o faturamento do
eixo 2.

### D2 — Capacidade do núcleo, com chave da instalação, desligada por padrão

- A cobrança entra no código de toda instalação e chega pelo `update.sh` como qualquer correção.
  Fica desligada até o dono da instalação ligá-la em `/admin/sistema`. A chave mora em
  `platform_config`, no mesmo trilho das chaves de instalação que `lib/instalacao/modulos.ts` já lê,
  e só o valor `ligado` a liga (falha fechada).
- Com a chave desligada, **nada do que existe muda**: as rotas da cobrança respondem 404, a tela do
  dono some do menu, nenhum limite vale, o cron sai sem auditar, e o formulário de nova empresa, o
  rótulo de plano, a tela de cobrança da empresa e o menu seguem idênticos. Quem opera uma empresa
  só vê um interruptor a mais.
- As duas tabelas da cobrança (planos e assinaturas) nascem vazias no banco de **toda**
  instalação, inclusive de quem nunca liga a chave. O peso está medido na seção seguinte.

### D3 — Empresa sem assinatura é isenta

Não há estado "isenta": empresa sem linha de assinatura não tem cobrança, limite nem régua. Isso
cobre de uma vez a empresa do próprio dono, toda empresa que existia antes de ligar a chave e quem
o dono isentar.

### D4 — O provedor é insumo, não fonte de regra

Teste grátis, régua de atraso e limites moram no nosso banco. O provedor responde só "há assinatura
viva e paga?", "está devendo?" e "foi cancelada?", e responde por releitura na API dele, nunca pelo
corpo de um aviso recebido. Um provedor por vez para assinatura nova; as antigas seguem no provedor
em que nasceram (decisão D-8).

### D5 — A suspensão que suspende vem antes, e vale sem a chave

Uma empresa suspensa — pelo dono, por motivo administrativo, ou pela régua, por falta de
pagamento — para de gastar e de falar: nenhuma IA roda, nada sai, a sessão cai numa tela própria,
token e MCP recebem 403. Mensagem que chega continua gravada, e a LGPD nunca é bloqueada. Isso
conserta a suspensão administrativa de hoje, vale para toda instalação e é o primeiro PR da
entrega, antes de qualquer linha de cobrança.

### D6 — As decisões de produto estão no desenho

As 14 decisões do dono (D-1…D-14: prazo de tolerância, troca de plano só na virada paga, convites
fora do limite, o que a suspensão corta e o que deixa passar, entre outras) estão na tabela do topo
do desenho. Esta ADR registra só o que muda doutrina: a D-1 (seção seguinte) e o alcance das
proibições da doutrina de operação de agentes.

---

## Relação com a ADR-0002

A ADR-0002 separa dois destinos para tabela nova: o **núcleo**, pela tripla de sempre (migration,
apêndice do baseline, MANIFEST), e o **módulo opcional com dados**, cujas tabelas só nascem quando o
módulo é instalado, por uma função provisionadora sem parâmetro. A condição 2 do dono sustenta a
separação: "quem não usa o módulo não carrega as tabelas dele".

A cobrança é classificada como **capacidade do núcleo com chave da instalação**, pelo mesmo caminho
do caixa, que a ADR-0002 registra como "já decidido como núcleo e entra pela tripla de sempre" (seção
"O que esta ADR não decide"). O motivo é estrutural:

- as travas de pessoas e de números e o teste grátis automático são gatilhos em tabelas do núcleo
  (`user_organizations`, `channel_sessions`, `organizations`) que **consultam** as tabelas da
  cobrança;
- a D4 da ADR-0002 reprova, por invariante, função provisionadora cujo corpo referencie tabela de
  fora do módulo — e a provisionadora da cobrança teria de criar esses gatilhos no núcleo;
- a saída que sobra — tabelas criadas pela provisionadora e gatilhos no baseline que toleram a
  ausência delas com `to_regclass` e SQL dinâmico, no espírito da D7 — poria SQL dinâmico em
  gatilhos quentes, no caminho de todo convite aceito e de toda conexão de número, contra duas
  tabelas pequenas. Recusada.

**O custo, medido.** As duas tabelas vazias, com os índices do desenho (§2.2 e §2.3), ocupam
**{{PESO_LEGIVEL}}** ({{PESO_BYTES}} bytes) num Postgres 17 descartável — a mesma bancada em que a
ADR-0002 mediu ~368 KB para as cinco tabelas vazias da comanda, com 18 índices.

**Isto revisa a condição 2, só para este caso.** A linha "Tabelas no baseline para todos" da D9 da
ADR-0002 diz que a reconsideraria "se o dono revisar a condição 2". O dono revisou, em 29/09/2026,
para a cobrança do revendedor (decisão D-1). A condição 2 continua valendo para todo módulo com
dados — a comanda, os honorários e os próximos —, e a exceção não vira precedente automático: outra
capacidade que queira o mesmo caminho precisa de decisão própria, com o peso medido na mão.

---

## Relação com a doutrina de operação de agentes

- **Invariante 1** (software livre, operação cobrada) segue intacta: nada do software fica atrás de
  pagamento ao projeto. A cobrança é uma ferramenta que quem instala usa ou não; desligada, a
  instalação é a mesma de antes.
- **Invariante 2** (quem opera sozinho não paga) segue intacta: o caminho self-host continua
  completo, e a empresa que instala para si nunca liga a chave. Quem paga, no eixo 3, é o cliente de
  um revendedor, pelo serviço que o revendedor presta, na instalação do revendedor.
- **Proibição 2** (faturamento antes do primeiro operador que paga) passa a dizer de quem é: do
  **operador de agentes**. O faturamento do retainer continua não construído, e a brecha
  "Faturamento e planos" continua aberta para ele.
- **Proibição 3** (licença ou assento) passa a dizer de quem é: do **mantenedor e do operador de
  agentes**. Planos, preço e limites — inclusive de pessoas — do revendedor são configuração dele.
  Todo limite nasce nulo, isto é, sem teto, até ele definir um.

---

## Consequências

- **Quem instala para si:** nenhum passo novo; um interruptor a mais em `/admin/sistema`; duas
  tabelas vazias no banco.
- **Quem revende:** liga a chave, conecta Stripe ou Asaas pela tela, cria planos e testa em modo de
  teste antes de publicar. Nenhuma edição manual de arquivo e nenhum fork: as atualizações chegam
  pelo `update.sh`.
- **O projeto:** passa a manter os adaptadores de dois provedores e a deriva das APIs deles. É o
  preço de a cobrança sobreviver à atualização.
- **Toda instalação, com ou sem cobrança:** ganha a suspensão que de fato suspende (D5).
- **Doutrina e documentos:** a doutrina de operação de agentes nomeia o eixo de cada proibição e
  troca a régua da brecha de faturamento por uma pergunta; a spec 19 diz que o console de agência
  segue sem faturamento; a VISION separa "nós não vendemos assinatura" de "quem instala pode cobrar
  os próprios clientes"; o catálogo de regras de negócio ganha o estado medido das regras de
  cobrança.

---

## Alternativas consideradas e recusadas

| Alternativa | Por que não | Reconsideraríamos se |
|---|---|---|
| **Fork, ou prompts que editam o código do revendedor** | A VPS baixa imagem pronta e o `update.sh` a regrava: a primeira atualização apaga a cobrança do fork, ou o fork deixa de receber atualização. É o que a doutrina de packaging proíbe exigir de quem opera | nunca: é o motivo de a capacidade morar no núcleo |
| **Sidecar** — um serviço de cobrança à parte, ao lado da instalação | Serviço que não é imagem publicada do compose nunca é atualizado (doutrina de packaging). E ele não alcança onde a cobrança precisa agir: as travas moram em gatilhos do núcleo, e a suspensão precisa de pontos de corte dentro da IA, do envio e da sessão; de fora, o sidecar só chamaria a rota de suspender, que hoje não suspende | o núcleo expor um contrato de corte por organização que um serviço externo possa acionar, com prova dos dois lados |
| **Extensão de pacote** | A lista fechada de capacidades de extensão deixa cobrança de fora, e pacote não traz SQL, credencial nem código ([`extensoes.md`](../doctrine/extensoes.md), não-negociável 2) | — |
| **Tabelas pela função provisionadora da ADR-0002, com gatilhos tolerando a ausência delas** | SQL dinâmico em gatilhos quentes de `user_organizations` e `channel_sessions` (seção "Relação com a ADR-0002") | as travas deixarem de morar em tabelas do núcleo |
| **Instância hospedada paga pelo projeto** (PR #307) | Inverte o eixo 1: contraria o "não vendemos assinatura" da VISION e a invariante 1 da doutrina de operação de agentes | decisão do dono de mudar o modelo do projeto — outra ADR, não esta |
| **Dois provedores aceitos ao mesmo tempo para assinatura nova** | Uma escolha a mais para o revendedor leigo e para o cliente final; trocar de provedor já não quebra quem assinou (D-8) | os revendedores pedirem, com o caso em mãos |

---

## O que esta ADR não decide

- **O faturamento do operador de agentes** (eixo 2): segue na proibição 2.
- **Preço de qualquer coisa:** planos e valores são do revendedor.
- **Nota fiscal, cupom, proração, Pix Automático e Mercado Pago:** fora da primeira entrega (§1.2 do
  desenho).
- **O endurecimento geral** do acesso de suporte só-leitura nas policies do banco e o fechamento da
  escrita direta ao banco por membro de empresa suspensa (riscos residuais 1 e 2 do desenho;
  decisão D-12).

## Aceite

**Aceita em 2026-09-29 pelo dono do produto**, com o desenho e as decisões D-1…D-14, todas pela
recomendação. O aceite não implementa nada. A ordem de construção está na §14 do desenho: a
suspensão que suspende; planos e limites; contrato, Stripe e régua; Asaas; o guia de instalação no
Coolify; o material para revendedores. Para ver o que já chegou à `main`:
`git log --oneline origin/main -- lib/cobranca lib/organizacao`.
```

- [ ] **Step 7: Pôr o número medido no lugar dos marcadores**

Troque, com o Edit, `{{PESO_LEGIVEL}}` pelo valor legível da última linha do Step 5 (ex.: `48 kB`) e `{{PESO_BYTES}}` pelos bytes (ex.: `49152`). Confira:

Run: `cd /Users/rafaelmelgaco/deskcomm-saas/spec || exit 1; grep -c '{{PESO' docs/adr/0004-cobranca-do-revendedor.md`
Expected: `0`

- [ ] **Step 8: Conferir que a ADR não chama a cobrança de "módulo"**

Run: `cd /Users/rafaelmelgaco/deskcomm-saas/spec || exit 1; grep -n -i 'módulo' docs/adr/0004-cobranca-do-revendedor.md`

Expected: toda linha impressa está (a) no cabeçalho ("tabelas de módulo" da ADR-0002), (b) na seção "Relação com a ADR-0002" nomeando o conceito da ADR-0002 ou módulos reais (comanda, honorários), (c) no caminho `lib/instalacao/modulos.ts`, ou (d) na linha da alternativa recusada da provisionadora. Nenhuma diz que a cobrança **é** um módulo. Se alguma disser, reescreva com "capacidade do núcleo com chave".

- [ ] **Step 9: Rodar o teste e ver passar**

Run: `cd /Users/rafaelmelgaco/deskcomm-saas/spec || exit 1; pnpm exec vitest run tests/unit/documentacao-aponta-para-o-que-existe.test.ts`
Expected: PASS, 4 testes. (Os links da ADR para `../superpowers/specs/...`, `../../VISION.md`, `../white-label.md`, `../doctrine/*.md` e `0002-…md`, e os caminhos em crase `app/api/v1/admin/tenants/[id]/suspend/route.ts`, `hostgator-setup-kit/update.sh` e `lib/instalacao/modulos.ts`, existem.)

- [ ] **Step 10: Commit**

```bash
cd /Users/rafaelmelgaco/deskcomm-saas/spec || exit 1
git add docs/adr/0004-cobranca-do-revendedor.md docs/index.md
git commit -F - <<'FIM'
docs(adr): ADR-0004 — cobrança do revendedor, o terceiro eixo de dinheiro

Registra que o dono de uma instalação pode cobrar as empresas que atende,
como capacidade do núcleo com chave da instalação, desligada por padrão.
Classifica a cobrança fora do caminho da provisionadora da ADR-0002 e
registra a revisão da condição 2 só para este caso (decisão D-1), com o
peso medido das duas tabelas vazias num Postgres 17 descartável.

O índice passa a listar a ADR-0003, que faltava, e a ADR-0004.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 2: A doutrina de operação de agentes diz de quem é cada proibição

**Files:**
- Modify: `docs/doctrine/operacao-de-agentes.md:29-33` (prosa da §0), `:96` (linha da brecha), `:103-108` (a régua), `:117-119` (proibições 2 e 3)
- Test: `tests/unit/documentacao-aponta-para-o-que-existe.test.ts`

**Interfaces:**
- Consumes: `docs/adr/0004-cobranca-do-revendedor.md` (Task 1), linkada como `../adr/0004-cobranca-do-revendedor.md`.
- Produces: a pergunta que substitui a régua da brecha "Faturamento e planos" — o Task 3 aponta para ela ("a régua está na brecha 'Faturamento e planos' da doutrina, §3").

- [ ] **Step 1: A sonda que falha**

Run:
```bash
cd /Users/rafaelmelgaco/deskcomm-saas/spec || exit 1
f=docs/doctrine/operacao-de-agentes.md
grep -c 'hoje devolve 0' $f; grep -c 'não existe nenhuma tabela de' $f; grep -c 'ADR-0004' $f
```
Expected (hoje): `2`, `1`, `0`. A meta do task é `0`, `0`, `5`.

- [ ] **Step 2: Prosa da §0 (linhas 29-33)**

old:
```markdown
A primeira linha foi fechada em 2026-09-13 e é a que destrava o resto: **retainer por cliente
operado**. O trabalho imediato passa a ser o console de agência
(`docs/specs/19-spec-console-de-agencia.md`), e não um medidor de consumo — cobrar por consumo
exigiria construir medidor → fatura antes do primeiro real, e hoje não existe nenhuma tabela de
plano, fatura ou assinatura no schema.
```

new:
```markdown
A primeira linha foi fechada em 2026-09-13 e é a que destrava o resto: **retainer por cliente
operado**. O trabalho imediato passa a ser o console de agência
(`docs/specs/19-spec-console-de-agencia.md`), e não um medidor de consumo — cobrar por consumo
exigiria construir medidor → fatura antes do primeiro real, e o schema não tem tabela que fature o
operador de agentes (a régua é a pergunta da brecha "Faturamento e planos", §3). A cobrança que o
**dono de uma instalação** faz das empresas que atende é outro eixo, decidido à parte na
[ADR-0004](../adr/0004-cobranca-do-revendedor.md), e não é esta linha.
```

- [ ] **Step 3: A linha da brecha (linha 96)**

Duas trocas dentro da mesma linha da tabela (substrings únicas; não mexa no preenchimento de espaços):

old:
```markdown
| **Faturamento e planos** — zero tabelas de plano, fatura ou assinatura no schema
```
new:
```markdown
| **Faturamento e planos do operador de agentes** (eixo 2, o retainer) — não há tabela que fature o operador; a cobrança do revendedor (eixo 3, [ADR-0004](../adr/0004-cobranca-do-revendedor.md)) é outra coisa e não fecha esta brecha
```

old:
```markdown
comando abaixo, que hoje devolve 0
```
new:
```markdown
a pergunta abaixo, respondida tabela a tabela
```

- [ ] **Step 4: A régua (linhas 103-108)**

old:
````markdown
A régua da primeira linha — **hoje devolve 0**, e continua devolvendo 0 até existir:

```bash
grep -oiE 'create table (if not exists )?public\.[a-z_]+' supabase/baseline.sql \
  | grep -icE 'invoice|^create table (if not exists )?public\.(billing|plans|subscriptions|quota|credits)$'
```
````

new:
````markdown
A régua da primeira linha é uma **pergunta**, não uma contagem. Liste as tabelas do schema com
cara de cobrança:

```bash
grep -oiE 'create table (if not exists )?"?public"?\."?[a-z_]+' supabase/baseline.sql \
  | tr -d '"' | grep -iE 'invoice|billing|fatura|plan|assinatura|subscription|cobranca|quota|credit'
```

e responda, para cada linha: **esta tabela fatura o retainer de um cliente operado?** A brecha só
fecha quando alguma responder "sim". Duas classes de linha respondem "não" e não fecham nada:

- tabela de outro domínio que casa o nome — `account_plans` é o plano de contas do caixa,
  `push_subscriptions` é inscrição de notificação;
- as tabelas `cobranca_*`, quando existirem: são a cobrança **do revendedor** (eixo 3,
  [ADR-0004](../adr/0004-cobranca-do-revendedor.md)) — o dono da instalação cobrando as empresas
  que atende, com plano fixo. Não medem nem faturam operação de agentes.

A régua anterior contava zero por dois motivos, e nenhum deles era "não existe": ela só via
`public.x` sem aspas — o trecho do dump, escrito `"public"."x"`, ficava fora — e só casava nomes em
inglês. As tabelas `cobranca_*` passariam por ela invisíveis, e o zero seguiria lido como "a brecha
está aberta" pelo motivo errado.
````

- [ ] **Step 5: Proibições 2 e 3 (linhas 117-119)**

old:
```markdown
2. **Não construir faturamento antes do primeiro operador que paga.** Sem cliente pagante, o
   desenho do medidor é adivinhação.
3. **Não cobrar por licença nem por assento** (invariantes 1 e 2).
```

new:
```markdown
2. **Não construir faturamento antes do primeiro operador que paga.** Sem cliente pagante, o
   desenho do medidor é adivinhação. Vale para o faturamento do **operador de agentes** (o
   retainer, §0), não para a cobrança do revendedor, que é outro eixo e tem decisão própria
   ([ADR-0004](../adr/0004-cobranca-do-revendedor.md)).
3. **Não cobrar por licença nem por assento** (invariantes 1 e 2). A proibição é do
   **mantenedor e do operador de agentes**. Quem instala e cobra as empresas da própria instalação
   escolhe planos, preço e limites — inclusive de pessoas — como configuração dele, e todo limite
   nasce nulo, isto é, sem teto, até ele definir um (ADR-0004).
```

- [ ] **Step 6: A sonda passa, e a régua nova vê o que deve ver**

Run:
```bash
cd /Users/rafaelmelgaco/deskcomm-saas/spec || exit 1
f=docs/doctrine/operacao-de-agentes.md
grep -c 'hoje devolve 0' $f; grep -c 'não existe nenhuma tabela de' $f; grep -c 'ADR-0004' $f
# a régua nova contra o baseline real
grep -oiE 'create table (if not exists )?"?public"?\."?[a-z_]+' supabase/baseline.sql \
  | tr -d '"' | grep -iE 'invoice|billing|fatura|plan|assinatura|subscription|cobranca|quota|credit'
# controle positivo: a régua enxerga cobranca_* nas duas grafias do dump
printf 'CREATE TABLE IF NOT EXISTS "public"."cobranca_planos" (\ncreate table if not exists public.cobranca_assinaturas (\n' \
  | grep -oiE 'create table (if not exists )?"?public"?\."?[a-z_]+' \
  | tr -d '"' | grep -iE 'invoice|billing|fatura|plan|assinatura|subscription|cobranca|quota|credit'
```
Expected: `0`, `0`, `5`; depois `create table if not exists public.push_subscriptions` e `create table if not exists public.account_plans` (as duas classes "não" que o texto nomeia); depois `CREATE TABLE IF NOT EXISTS public.cobranca_planos` e `create table if not exists public.cobranca_assinaturas`. Se a régua contra o baseline imprimir uma terceira tabela, classifique-a no texto antes de seguir.

- [ ] **Step 7: Rodar o gate de links**

Run: `cd /Users/rafaelmelgaco/deskcomm-saas/spec || exit 1; pnpm exec vitest run tests/unit/documentacao-aponta-para-o-que-existe.test.ts`
Expected: PASS, 4 testes.

- [ ] **Step 8: Commit**

```bash
cd /Users/rafaelmelgaco/deskcomm-saas/spec || exit 1
git add docs/doctrine/operacao-de-agentes.md
git commit -F - <<'FIM'
docs(doutrina): as proibições de faturamento dizem de quem são

A proibição 2 (faturamento antes do primeiro operador que paga) e a 3
(licença ou assento) passam a nomear o eixo: mantenedor e operador de
agentes. Planos e limites do revendedor são configuração dele (ADR-0004).

A régua da brecha "Faturamento e planos" era uma contagem que devolvia
zero por instrumento cego — só via public.x sem aspas e só nomes em
inglês — e continuaria zero com as tabelas cobranca_*. Vira uma pergunta
respondida tabela a tabela, que classifica essas tabelas como eixo 3.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 3: "Não cobramos" é promessa do projeto — spec 19, VISION e o plano da LP

**Files:**
- Modify: `docs/specs/19-spec-console-de-agencia.md:37-40` e `:91`
- Modify: `VISION.md:61` e `:79`
- Modify: `docs/growth/lp-plano.md:365`

**Interfaces:**
- Consumes: `docs/adr/0004-cobranca-do-revendedor.md` (Task 1); a pergunta da brecha (Task 2).
- Produces: nada que outro task consuma.

- [ ] **Step 1: A sonda que falha**

Run:
```bash
cd /Users/rafaelmelgaco/deskcomm-saas/spec || exit 1
grep -c 'não existe nenhuma tabela de plano, fatura ou' docs/specs/19-spec-console-de-agencia.md
grep -c 'ADR-0004' docs/specs/19-spec-console-de-agencia.md VISION.md docs/growth/lp-plano.md
grep -c 'Não vendemos assinatura\|não vendemos assinatura' VISION.md
```
Expected (hoje): `1`; `…:0` nos três; `1`. Meta: `0`; `1`, `2`, `1`; `1` (a promessa do projeto continua lá).

- [ ] **Step 2: Spec 19, decisão 1 (linhas 37-40)**

old:
```markdown
   imediato é **este console**, não um medidor de consumo — cobro por consumo exigiria construir
   medidor → fatura antes do primeiro real, e não existe nenhuma tabela de plano, fatura ou
   assinatura no schema.
```
new:
```markdown
   imediato é **este console**, não um medidor de consumo — cobro por consumo exigiria construir
   medidor → fatura antes do primeiro real, e o schema não tem tabela que fature o operador (a
   régua está na brecha "Faturamento e planos" da doutrina, §3).
```

- [ ] **Step 3: Spec 19, escopo (linha 91)**

old:
```markdown
**Fora (de propósito):** faturamento/planos/cotas (§1.2 decisão 1); console de revenda; SOC 2, ISO
```
new:
```markdown
**Fora (de propósito):** faturamento/planos/cotas do operador (§1.2 decisão 1) — o console segue
sem faturamento mesmo com a cobrança do revendedor
([ADR-0004](../adr/0004-cobranca-do-revendedor.md)), que é o dono da instalação cobrando as empresas
que atende e não fatura retainer; console de revenda; SOC 2, ISO
```

- [ ] **Step 4: VISION (linhas 61 e 79)**

old:
```markdown
- **O software é 100% open source (MIT), completo, sem versão paga.** Não vendemos assinatura. Não existe feature travada.
```
new:
```markdown
- **O software é 100% open source (MIT), completo, sem versão paga.** Nós não vendemos assinatura; quem instala pode cobrar os próprios clientes ([ADR-0004](docs/adr/0004-cobranca-do-revendedor.md)). Não existe feature travada.
```

old:
```markdown
*Última revisão: 2026-07-19 — reposicionamento e-commerce → multi-nicho / AI Sales OS.*
```
new:
```markdown
*Última revisão: 2026-09-29 — quem instala pode cobrar os próprios clientes (ADR-0004). Anterior: 2026-07-19 — reposicionamento e-commerce → multi-nicho / AI Sales OS.*
```

- [ ] **Step 5: Plano da LP, §11 (depois da linha 365)**

old:
```markdown
Sem tabela de planos — não temos planos. Um bloco só, honesto.
```
new:
```markdown
Sem tabela de planos — não temos planos. Um bloco só, honesto.

> ⚠️ **De quem é esta promessa.** "Não existe cobrança por usuário" e "não temos planos" são
> promessas **do projeto** sobre o software: nem o mantenedor nem uma versão paga cobram por
> pessoa. Quem instala e revende pode cobrar os próprios clientes com planos que limitam pessoas —
> é a instalação dele, não a nossa ([ADR-0004](../adr/0004-cobranca-do-revendedor.md)). Esta seção
> fala com quem instala para si; não estenda a promessa ao cliente final de um revendedor.
```

- [ ] **Step 6: A sonda passa**

Run: o mesmo bloco do Step 1.
Expected: `0`; `docs/specs/19-spec-console-de-agencia.md:1`, `VISION.md:2`, `docs/growth/lp-plano.md:1`; `1`.

- [ ] **Step 7: Os links resolvem**

Estes três arquivos não estão na lista `AUTORIDADE` do gate, então confira à mão:

Run:
```bash
cd /Users/rafaelmelgaco/deskcomm-saas/spec || exit 1
test -f docs/specs/../adr/0004-cobranca-do-revendedor.md && test -f docs/adr/0004-cobranca-do-revendedor.md \
  && test -f docs/growth/../adr/0004-cobranca-do-revendedor.md && echo links-ok
```
Expected: `links-ok`

- [ ] **Step 8: Commit**

```bash
cd /Users/rafaelmelgaco/deskcomm-saas/spec || exit 1
git add docs/specs/19-spec-console-de-agencia.md VISION.md docs/growth/lp-plano.md
git commit -F - <<'FIM'
docs: a promessa de não cobrar é do projeto, não de quem revende

A VISION separa "nós não vendemos assinatura" de "quem instala pode
cobrar os próprios clientes" (ADR-0004). A spec 19 diz que o console de
agência segue sem faturamento do operador, e troca a afirmação "não
existe tabela de plano ou assinatura", que envelheceria com as tabelas
da cobrança, pela régua da doutrina. O plano da LP marca "sem cobrança
por usuário" como promessa do projeto.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 4: Catálogo de regras — o estado medido de B-01, B-02 e B-04

**Files:**
- Modify: `docs/business-rules/00-business-rules-catalog.md:472-473` (B-01), `:480` (B-02), `:495` (B-04)

B-03 (retenção de mídia) e B-05 (sync inicial da Nuvemshop) **não** tratam de cobrança e não são tocadas.

**Interfaces:**
- Consumes: `docs/adr/0004-cobranca-do-revendedor.md` (Task 1).
- Produces: nada que outro task consuma.

- [ ] **Step 1: Medir o que as três regras afirmam (a sonda que "falha" contra o texto)**

Run:
```bash
cd /Users/rafaelmelgaco/deskcomm-saas/spec || exit 1
grep -c 'usage_events' supabase/baseline.sql                                  # B-01: a tabela
grep -rn 'usage_events' lib app workers components hooks scripts | grep -v database.types | wc -l
grep -rln 'internal_deskcomm' lib app workers scripts supabase/baseline.sql | wc -l   # B-02: o tenant
grep -n 'insert into llm_calls' lib/agent-engine/edge/llm/run-model-call.ts            # B-02: quem grava
grep -n 'create or replace function public.fn_gasto_de_ia_do_mes' supabase/baseline.sql
grep -rn 'rate_limit_rps\|rate_limit_config' lib app workers components hooks scripts | grep -v database.types | wc -l  # B-04
grep -n '"rate_limit_rps"' supabase/baseline.sql
grep -n 'export const TETO_\|export const JANELA_' lib/mcp/rate-limit.ts
grep -c '^- \*\*Estado\*\*' docs/business-rules/00-business-rules-catalog.md
```
Expected: `0`; `0`; `0`; duas linhas (`insert into llm_calls`, ~738 e ~925); uma linha (~13111); `0`; uma linha (`"rate_limit_rps" integer DEFAULT 100 NOT NULL`, ~1756); três linhas (`TETO_POR_ORGANIZACAO = 600`, `TETO_DE_ESCRITA = 30`, `JANELA_SEGUNDOS = 60`); `1` (só a B-03 tem linha de estado). Se algum número divergir, o texto abaixo precisa ser reescrito com o que foi medido — não publique o que não bate.

- [ ] **Step 2: B-01**

old:
```markdown
- **Enforcement**: Workers de cada subsistema (WhatsApp send/recv, IA invocation, storage upload).
- **Exceção**: Nenhuma.
```
new:
```markdown
- **Enforcement**: Workers de cada subsistema (WhatsApp send/recv, IA invocation, storage upload).
- **Exceção**: Nenhuma.
- **Estado**: **não construída.** A tabela `usage_events` não existe (`grep -c usage_events supabase/baseline.sql`). O custo por organização que existe é o de IA, em `llm_calls.cost_cents` (B-02). A cobrança do revendedor ([ADR-0004](../adr/0004-cobranca-do-revendedor.md)) cobra plano fixo, não consumo, e não depende desta regra; para o operador de agentes, a unidade decidida é retainer, não consumo (`docs/doctrine/operacao-de-agentes.md` §0).
```

- [ ] **Step 3: B-02**

old:
```markdown
- **Exceção**: Custos administrativos da plataforma (super-admin testando, suporte) são debitados ao tenant `internal_deskcomm`.
```
new:
```markdown
- **Exceção**: Custos administrativos da plataforma (super-admin testando, suporte) são debitados ao tenant `internal_deskcomm`.
- **Estado**: cumprida por outro mecanismo. Não há evento de billing vindo do Gateway nem worker de billing: o próprio runtime grava o custo de cada chamada em `llm_calls.cost_cents`, com o `organization_id` de onde ela roda (`lib/agent-engine/edge/llm/run-model-call.ts`, `lib/ai/log-invocation.ts`), em centavos de **dólar**, e `fn_gasto_de_ia_do_mes` é a única soma (vigiada por `tests/unit/orcamento-uma-regua-de-gasto.test.ts`). A exceção não existe: não há tenant `internal_deskcomm` (`grep -rn internal_deskcomm lib app workers supabase/baseline.sql`). É essa soma que o teto de IA do plano do revendedor consome ([ADR-0004](../adr/0004-cobranca-do-revendedor.md)).
```

- [ ] **Step 4: B-04**

old:
```markdown
- **Override**: Cliente enterprise pode contratar plano com RPS maior; ajuste em `tenants.rate_limit_config`.
```
new:
```markdown
- **Override**: Cliente enterprise pode contratar plano com RPS maior; ajuste em `tenants.rate_limit_config`.
- **Estado**: **não cumprida como escrita.** A coluna `organizations.rate_limit_rps` (padrão 100) existe no schema e nada a lê; `tenants.rate_limit_config` não existe; nenhum teto de 100 RPS por organização é aplicado. O teto real da API é de escrita, por token e por organização, numa janela fixa (`grep -n 'TETO_\|JANELA_' lib/mcp/rate-limit.ts`), aplicado às rotas com Bearer por `lib/api/auth-dual.ts`. A cobrança do revendedor ([ADR-0004](../adr/0004-cobranca-do-revendedor.md)) não vende nem limita RPS; o desenho dela prevê remover a coluna sem leitor (`grep -n rate_limit_rps supabase/baseline.sql` diz se ela ainda existe).
```

- [ ] **Step 5: A sonda passa**

Run:
```bash
cd /Users/rafaelmelgaco/deskcomm-saas/spec || exit 1
f=docs/business-rules/00-business-rules-catalog.md
grep -c '^- \*\*Estado\*\*' $f; grep -c 'ADR-0004' $f
test -f docs/business-rules/../adr/0004-cobranca-do-revendedor.md && echo link-ok
git diff --stat -- $f
```
Expected: `4`; `3`; `link-ok`; `1 file changed, 3 insertions(+)` (só acréscimos; B-03 e B-05 intactas).

- [ ] **Step 6: Commit**

```bash
cd /Users/rafaelmelgaco/deskcomm-saas/spec || exit 1
git add docs/business-rules/00-business-rules-catalog.md
git commit -F - <<'FIM'
docs(regras): estado medido das regras de cobrança B-01, B-02 e B-04

B-01: usage_events nunca existiu. B-02: o rateio de IA por organização é
cumprido pelo runtime em llm_calls.cost_cents e somado por
fn_gasto_de_ia_do_mes, sem worker de billing nem tenant interno. B-04: a
coluna rate_limit_rps não tem leitor e o teto real da API é por token e
por organização. B-03 e B-05 não tratam de cobrança e ficam como estão.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 5: Doutrina de extensões — a máquina da ADR-0002 já está construída

**Files:**
- Modify: `docs/doctrine/extensoes.md:159`
- Test: `tests/unit/documentacao-aponta-para-o-que-existe.test.ts`

**Interfaces:**
- Consumes: nada dos tasks anteriores.
- Produces: nada.

- [ ] **Step 1: Medir (a sonda que falha)**

Run:
```bash
cd /Users/rafaelmelgaco/deskcomm-saas/spec || exit 1
grep -c 'ainda não construída' docs/doctrine/extensoes.md
grep -n 'create or replace function public.fn_modulo_instalar' supabase/baseline.sql
grep -n 'create or replace function public.fn_[a-z_]*_provisionar' supabase/baseline.sql
grep -n '^-- ---- módulo instalado: instalar e reaplicar\|^-- ---- honorários: primeiro módulo oficial' supabase/baseline.sql
```
Expected: `1`; uma linha (~33108); uma linha (`fn_honorarios_provisionar`, ~36796); duas linhas de rótulo, com `(migration 0340)` e `(migration 0480)`. Se `fn_modulo_instalar` não aparecer, **não** edite: a afirmação da doutrina segue verdadeira e o task acaba aqui.

- [ ] **Step 2: Trocar a afirmação por fato e comando**

old:
```markdown
[ADR-0002](../adr/0002-tabelas-de-modulo-num-banco-so.md), **aceita em 17/09/2026, ainda não construída**; dados de extensão de terceiro: marco 4 (PROG-017 §8) |
```
new:
```markdown
[ADR-0002](../adr/0002-tabelas-de-modulo-num-banco-so.md), **aceita em 17/09/2026 e construída** — a instalação e a reaplicação vieram na migration 0340 e o primeiro módulo a usá-las foi `honorarios` (migration 0480); as provisionadoras em vigor: `grep -n 'create or replace function public.fn_[a-z_]*_provisionar' supabase/baseline.sql`; dados de extensão de terceiro: marco 4 (PROG-017 §8) |
```

- [ ] **Step 3: A sonda passa e o gate segue verde**

Run:
```bash
cd /Users/rafaelmelgaco/deskcomm-saas/spec || exit 1
grep -c 'ainda não construída' docs/doctrine/extensoes.md
pnpm exec vitest run tests/unit/documentacao-aponta-para-o-que-existe.test.ts
```
Expected: `0`; PASS, 4 testes.

- [ ] **Step 4: Commit**

```bash
cd /Users/rafaelmelgaco/deskcomm-saas/spec || exit 1
git add docs/doctrine/extensoes.md
git commit -F - <<'FIM'
docs(extensoes): a máquina da ADR-0002 já está construída

"Aceita, ainda não construída" era nota de pendência vencida: a
instalação e a reaplicação de módulo vieram na migration 0340 e os
honorários (0480) já usam a provisionadora. A afirmação vira fato mais o
comando que lista as provisionadoras em vigor.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
FIM
```

---

### Task 6: A suíte inteira, a ausência de fragmento e o PR

**Files:**
- Nenhum arquivo novo. Test: `pnpm test:unit` (a suíte inteira, sem caminho).

**Interfaces:**
- Consumes: os commits dos Tasks 1–5.
- Produces: o PR 0.

- [ ] **Step 1: Os gates que varrem documentos, isolados**

Run:
```bash
cd /Users/rafaelmelgaco/deskcomm-saas/spec || exit 1
pnpm exec vitest run tests/unit/documentacao-aponta-para-o-que-existe.test.ts \
  tests/unit/traducao-nao-defasa.test.ts tests/unit/evidencia-citada.test.ts \
  tests/unit/evidencia-no-caminho-versionado.test.ts tests/unit/handoff-na-raiz-nao-volta.test.ts
```
Expected: `Test Files  5 passed (5)`. (O selo de tradução guarda só `docs/white-label.md`, que este PR não toca; os de evidência varrem `docs/superpowers/specs/` — onde a spec desta branch está — atrás do caminho de evidência que o `.gitignore` ignora e de imagem não versionada: a spec cita `evidence/`, que é o caminho certo.)

- [ ] **Step 2: A suíte inteira, com a saída guardada**

Run:
```bash
cd /Users/rafaelmelgaco/deskcomm-saas/spec || exit 1
pnpm test:unit > /tmp/vt-pr0.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/vt-pr0.log | tail -2
r=$(grep -aE "^ *Tests " /tmp/vt-pr0.log | tail -1 | grep -oE "[0-9]+ failed" | head -1)
g=$(grep -acE "^ *FAIL " /tmp/vt-pr0.log)
echo "rodapé: ${r:-0 failed} | grep contou: $g"
grep -aE "^ *FAIL " /tmp/vt-pr0.log | sed 's/ > .*//' | sort | uniq -c
```
Expected: `exit=0`, rodapé sem `failed`, `rodapé: 0 failed | grep contou: 0`. Exceção conhecida e não sua: `lib/ai/dispatcher/rate-limit.test.ts` falha em 5 casos quando o `.env.local` tem `UPSTASH_REDIS_REST_URL`/`TOKEN` apontando para um Redis que não está de pé (CLAUDE.md, "Vermelho local que NÃO é seu"). Qualquer outro vermelho: este PR só mexe em `.md`, então rode `git stash`-free o diferencial — `git switch --detach origin/main && pnpm exec vitest run <arquivo> ; git switch -` — antes de atribuí-lo a este PR. Se as duas linhas do rodapé e do `grep` não baterem, rode de novo com `--reporter=verbose` em vez de concluir pelo silêncio.

- [ ] **Step 3: Nenhum fragmento, nenhum arquivo fora de `docs/` e `VISION.md`**

Run:
```bash
cd /Users/rafaelmelgaco/deskcomm-saas/spec || exit 1
git diff --name-only origin/main...HEAD
```
Expected, exatamente:
```
VISION.md
docs/adr/0004-cobranca-do-revendedor.md
docs/business-rules/00-business-rules-catalog.md
docs/doctrine/extensoes.md
docs/doctrine/operacao-de-agentes.md
docs/growth/lp-plano.md
docs/index.md
docs/specs/19-spec-console-de-agencia.md
docs/superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md
```
Nada em `.changes/`: PR só de documentação não muda comportamento visível a quem opera uma VPS (DoD 17), e o CI valida a forma dos fragmentos, não a presença.

- [ ] **Step 4: Push e PR (ação externa — PARE e peça confirmação explícita ao dono antes)**

```bash
cd /Users/rafaelmelgaco/deskcomm-saas/spec || exit 1
git push -u origin docs/spec-cobranca-do-revendedor
gh pr create --base main --head docs/spec-cobranca-do-revendedor \
  --title "docs(adr): ADR-0004 — cobrança do revendedor, e a spec que a detalha" \
  --body-file - <<'FIM'
## O que é

PR 0 da cobrança do revendedor, só documentação. Traz juntas a spec aprovada
(`docs/superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md`) e a
ADR-0004, que registra o terceiro eixo de dinheiro do produto: o dono de uma
instalação cobra as empresas que atende, como capacidade do núcleo com chave da
instalação, desligada por padrão.

## O que muda na doutrina

- ADR-0004: classificação fora do caminho da provisionadora da ADR-0002, com o
  peso medido das duas tabelas vazias; revisão da condição 2 da ADR-0002 só
  para este caso (decisão D-1 do dono); alternativas recusadas (fork, sidecar,
  extensão, provisionadora com `to_regclass`, a instância hospedada do #307).
- `operacao-de-agentes.md`: proibições 2 e 3 nomeiam o eixo (mantenedor e
  operador de agentes); a régua da brecha "Faturamento e planos" deixa de ser
  uma contagem cega e vira uma pergunta respondida tabela a tabela.
- Spec 19, VISION e o plano da LP: "não cobramos" é promessa do projeto; o
  console de agência segue sem faturamento.
- Catálogo de regras: estado medido de B-01, B-02 e B-04 (B-03 e B-05 não são
  de cobrança).
- `extensoes.md`: a máquina da ADR-0002 já está construída (0340, 0480).
- Índice: ADR-0003 (faltava) e ADR-0004.

## Prova

- `pnpm test:unit` inteiro: rodapé colado abaixo.
- `tests/unit/documentacao-aponta-para-o-que-existe.test.ts`: verde (a ADR e a
  doutrina só apontam para o que existe).
- Sem fragmento `.changes/`: nada muda para quem opera uma VPS.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
FIM
```

Depois de criado, cole no PR, como comentário, as duas linhas do rodapé do Step 2 (`grep -aE "Test Files|Tests " /tmp/vt-pr0.log | tail -2`) e o valor do peso medido no Task 1, com o SHA do commit da ADR (`git rev-parse --short HEAD`).

Expected: `gh` imprime a URL do PR.
