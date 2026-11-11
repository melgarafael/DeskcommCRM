# Auditoria — contribuições multiempresa da instalação (#3983)

**Data:** 2026-11-07 · **Medido contra:** `origin/main` @ `0d1c3faced66243b5d2673952e0dae85d988e368`

**Escopo:** classificar, item por item da tabela da issue #3983, o que já está na `main`,
o que segue em PR aberto e o que ficou de fora. **Nenhuma mudança de produto, nenhum
fechamento de PR ou issue por conta desta auditoria.** O que se decide aqui é o veredito
medido, com a evidência que o mede.

**Método:** para cada PR citado: `gh pr view N --json state,mergeable,mergedAt,mergeCommit`
e, quando `MERGED`, `git merge-base --is-ancestor <merge_sha> origin/main` (o merge estar
em `main` é a parte que "Incorporado" afirma). Em seguida, `git grep -n` do símbolo que o
PR criou, **no arquivo que ele não apenas tocou mas acrescentou linha**. O estado da coluna
"Estado" da issue é o que ela dizia em 2026-11-04; a coluna "Medido" é o que o repositório
responde hoje. Onde as duas divergem, vale a medido — e a divergência está anotada.

**Resultado:** 22 PRs medidos (21 da tabela + #4025, citado no complemento) ·
**14 incorporados** · **7 abertos** · **1 fora (fechado sem merge)** ·
0 PRs com merge que não esteja em `origin/main`.

---

## Como usar este documento

**Cada linha traz o comando que a mede. É o comando que vale, não o veredito.** Este
relatório é uma fotografia de 2026-11-07 e envelhece como qualquer outra: antes de agir
sobre uma linha, rode o comando de novo. Para reclassificar tudo de uma vez:

```bash
gh pr view <N> -R melgarafael/DeskcommCRM --json state,mergeable,mergedAt,mergeCommit
git merge-base --is-ancestor <merge_sha> origin/main && echo SIM
```

---

## Tabela final

### Incorporados (14)

Todos com merge commit ancestral de `origin/main` — verificado por
`git merge-base --is-ancestor`, 14/14 `YES`.

| PR | Recorte | Estado na issue | Evidência na `main` (arquivo:linha) | Recomendação |
|---|---|---|---|---|
| [#3883](https://github.com/melgarafael/DeskcommCRM/pull/3883) | fix(rbac): reutilize o papel nos helpers de visibilidade | Incorporado | `supabase/migrations/20261103032500_9090_visibilidade_papel_unico.sql:13` (`with actor as materialized`) · merge `7ecb7908a3` | Nada a fazer. |
| [#3979](https://github.com/melgarafael/DeskcommCRM/pull/3979) | fix(admin): some todo o período no painel de uso e custo | Incorporado | `lib/admin/usage-pages.ts:2` (`lerPaginasDeUso`) · merge `4d052ccc71` | Nada a fazer. |
| [#3982](https://github.com/melgarafael/DeskcommCRM/pull/3982) | fix(funil): preserve o prazo da releitura entre redesenhos | Incorporado | `hooks/kanban/useBoard.ts:62` (`chaveDoQuadro`) · merge `632f5cd7c6` | Nada a fazer. |
| [#3987](https://github.com/melgarafael/DeskcommCRM/pull/3987) | fix(admin): explicite a relação entre empresas e conversas | Incorporado | `app/api/v1/admin/tenants/_lista.ts:104` (`conversations_count`) · merge `63f4094404` | Nada a fazer. |
| [#3989](https://github.com/melgarafael/DeskcommCRM/pull/3989) | fix(onboarding): exija a empresa indicada na própria aba | PR de código aberto | `app/actions/onboarding/acceptWelcome.ts:25` (`organization_changed`) · merge `74b2d3f62d` | Atualizar a linha da issue: já entrou. |
| [#3990](https://github.com/melgarafael/DeskcommCRM/pull/3990) | fix(avatar): confira o acesso humano antes de assinar a foto | PR de código aberto | `app/api/v1/contacts/[id]/avatar/route.ts:111` (`navegador = true`) · merge `a57e9e1db4` | Atualizar a linha da issue: já entrou. |
| [#3994](https://github.com/melgarafael/DeskcommCRM/pull/3994) | fix(uso): identifique dólar e chamadas sem preço no painel e CSV | PR de código aberto | `app/api/v1/admin/usage/route.ts:35` (`ai_unpriced_count`) · merge `25c9b47c21` | Atualizar a linha da issue: já entrou. |
| [#3996](https://github.com/melgarafael/DeskcommCRM/pull/3996) | feat(mcp): leia derivados de mídia com permissão explícita no token | PR de código aberto | `docs/mcp/derivados-do-historico.md:1` + escopo no token · merge `40413e32da` | Atualizar a linha da issue: já entrou. |
| [#3997](https://github.com/melgarafael/DeskcommCRM/pull/3997) | fix(negocio): identifique o card antes de confirmar a perda | PR de código aberto | `components/kanban/LoseLeadDialog.tsx:52` (`leadLabel`) · merge `f8851cb62d` | Atualizar a linha da issue: já entrou. |
| [#4001](https://github.com/melgarafael/DeskcommCRM/pull/4001) | fix(radar): tire da revisão propostas de negócios encerrados | PR de código aberto | `lib/leads/radar-de-risco.ts:524` (`candidatosARevisao`) · merge `d326fa6eee` | Atualizar a linha da issue: já entrou. |
| [#4002](https://github.com/melgarafael/DeskcommCRM/pull/4002) | fix(build): preserve os bindings canvas instalados no standalone | PR de código aberto | `Dockerfile:76` (`cp -a node_modules/.pnpm/@napi-rs+canvas* …standalone`) · merge `7446ad90b2` | Atualizar a linha da issue: já entrou. |
| [#4003](https://github.com/melgarafael/DeskcommCRM/pull/4003) | fix(worker): respeite a parada durante a reconciliação de sessões | PR de código aberto | `lib/agent-engine/edge/crm/session-reconciler.ts:606` (`reconcileSessions(pool, cfg, log, signal)`) · merge `bfc9bd2f2e` | Atualizar a linha da issue: já entrou. |
| [#4011](https://github.com/melgarafael/DeskcommCRM/pull/4011) | fix(funil): exija organização e etapa do mesmo funil no banco | PR de código aberto | `supabase/migrations/20261104171703_9111_integridade_organizacao_funil_etapa.sql:18` (`crm-integridade-funil-etapa-v1`) · merge `67df76a7bb` | Atualizar a linha da issue: já entrou. |
| [#4025](https://github.com/melgarafael/DeskcommCRM/pull/4025) | feat(contato): preencha os campos configurados já no cadastro | complemento da issue | `components/contacts/NewContactDialog.tsx:29` (`camposPorEscopo`) · merge `ef6bd51ceb` | Promover do complemento para a tabela principal. |

### Abertos (7)

| PR | Recorte | Estado medido | Evidência | Recomendação |
|---|---|---|---|---|
| [#3993](https://github.com/melgarafael/DeskcommCRM/pull/3993) | fix(build): complete os módulos dinâmicos do Sentry no standalone | `OPEN` · `MERGEABLE` · checks verdes · `mergeStateStatus=CLEAN` | `gh pr checks 3993` sem falhas; head `fix/standalone-runtime-sentry` | **Único PR desta frente pronto para revisão.** Pedir revisão do mantenedor; não reescrever. |
| [#3998](https://github.com/melgarafael/DeskcommCRM/pull/3998) | feat(handoff): atribua pela fila com aviso externo opcional e recibos | `OPEN` · `CONFLICTING` | `gh pr view 3998 --json mergeable` | Precisa atualizar sobre a `main` (conflito). Re-portar o delta; sem rebase nesta auditoria. |
| [#4007](https://github.com/melgarafael/DeskcommCRM/pull/4007) | feat(atendimento): separe contexto comercial e escopos por opção | `OPEN` · `CONFLICTING` | idem | idem; é a base do #4010 (empilhado). Atualizar este primeiro. |
| [#4009](https://github.com/melgarafael/DeskcommCRM/pull/4009) | feat(catalogo): envie fotos inéditas em lotes por opção | `OPEN` · `CONFLICTING` | idem | idem. |
| [#4010](https://github.com/melgarafael/DeskcommCRM/pull/4010) | feat(avisos): recupere episódios com sessão e recibo autorizados | `OPEN` · `CONFLICTING` | idem | idem; depende do #4007 — atualizar depois dele, sem presumir duplicidade de privacidade. |
| [#4015](https://github.com/melgarafael/DeskcommCRM/pull/4015) | feat(contato): crie e vincule a pessoa pelo negócio atomicamente | `OPEN` · `CONFLICTING` · migration `9112` | head `feat/contato-criado-pelo-negocio`; baseline com bloco novo | idem; renumerar a migration no merge (ver §1). |
| [#4016](https://github.com/melgarafael/DeskcommCRM/pull/4016) | feat(assistente): generalize o piloto interno de consulta optativa | `OPEN` · `CONFLICTING` · migration `9113` | head `feat/assistente-interno-optativo` | idem; renumerar a migration no merge (ver §1). |

### Fora (1)

| PR | Recorte | Estado medido | Evidência | Recomendação |
|---|---|---|---|---|
| [#4017](https://github.com/melgarafael/DeskcommCRM/pull/4017) | feat(inbox): exponha prontidão adicional sem trocar o comando rápido | `CLOSED` em 2026-11-05T04:31:21Z, **sem merge** | `gh pr view 4017 --json state,mergedAt` → `CLOSED`/`null`; `supabase/migrations/20261104174030_9114_…` **não existe** em `origin/main` (a faixa salta de `9111` para `9206`) | **Decisão do mantenedor**: manter fechado ou reabrir com migration renumerada (`92xx`) e re-porte sobre a `main`. Não reabrir como está: o número `9114` está atrasado em relação à `main` (`9241`). |

---

## Divergências que impedem a atualização limpa

### 1. Numeração de migration (`<timestamp>_<NNNN>_<slug>`)

O nome carrega **duas** ordenações e elas não coincidem. Medido em `origin/main`
(`0d1c3face`, 651 migrations):

```bash
git ls-tree --name-only origin/main supabase/migrations/ | sed 's#.*/##' | grep -E '^[0-9]+_[0-9]+_'
```

| Medida | Resultado |
|---|---|
| NNNN duplicado na base | **0** |
| Pares em que o NNNN cresce e o timestamp **diminui** | **64** |
| Pontos em que a ordem de arquivo traz um NNNN **maior antes** de um menor | **68** |

Exemplos medidos: `20260718120000_0037` vem antes de `20260717190001_0038`;
`20261103163315_9097` vem antes de `20261103150000_9098`. Ou seja: **a ordem de
aplicação é o timestamp do nome; o NNNN é rótulo, não ordem.** Por isso "o próximo
número" não se lê na listagem — quem mede é `pnpm checar:colisao-de-migration`
(o script declara a régua: colisão reprova, atraso não).

Nesta frente, os três PRs portados carregam `9112` (#4015), `9113` (#4016) e `9114`
(#4017), enquanto a `main` já está em `9241`. Não há colisão hoje (medido: `9112`, `9113`
e `9114` não existem em `origin/main`; a faixa salta de `9111` para `9206`), mas os
arquivos entrariam na cadeia **entre `9111` e `9206`**, fora da ordem em que foram
escritos, e o apêndice do baseline derivado deles nasce nessa posição.
Recomendação: **renumerar para `92xx` no merge**, com uma migration por PR, sem tocar
em migration já aplicada.

### 2. Bloco de baseline depois da varredura de `anon` (o defeito recorrente)

O `baseline.sql` é *dump + apêndice*, aplicado inteiro em todo `update.sh`, em autocommit.
A varredura de privilégios por tabela termina em `$grants_9037$;`
(`supabase/baseline.sql:73139` na `main`), e o bloco seguinte declara-se o último:

```
supabase/baseline.sql:73141  -- ---- travas do modo somente leitura do suporte, depois de toda tabela (migration 0274) ----
```

O próprio arquivo diz a regra: *"ESTA CHAMADA É O ÚLTIMO BLOCO DO ARQUIVO. Tabela nova,
coluna `organization_id` nova, RLS ligada ou grant a `authenticated` entram ANTES dela."*
Bloco novo **depois** da varredura não é coberto por ela: a tabela/coluna chega depois do
`revoke all … from anon` e depois das travas, e o `update.sh` fica com um estado
intermediário diferente do final. A régua que cobra isso vive em
`tests/unit/apendice-do-baseline-espelha-a-migration.test.ts` (*"vive no meio do baseline,
antes do último bloco de varredura"*) e em
`tests/invariants/grants-explicitos-das-tabelas-do-apendice.test.ts` (tabela do apêndice
sem `grant` próprio reprova).

Medido em dois PRs abertos **de hoje** (hunk final do `git diff merge-base..head -- supabase/baseline.sql`,
contra a linha da varredura no mesmo head):

| PR | `$grants_9037$;` no head | Bloco novo entra em | Objetos acrescentados | Situação |
|---|---|---|---|---|
| [#4239](https://github.com/melgarafael/DeskcommCRM/pull/4239) | 73153 | **76598** (fim do arquivo, total 76634) | `alter table public.channel_sessions` + `create unique index channel_sessions_olx_account_id_ativo_unique` | **depois** da varredura e das travas |
| [#4249](https://github.com/melgarafael/DeskcommCRM/pull/4249) | 73142 | **76588** (fim do arquivo, total 76603) | `alter table public.contacts` | **depois** da varredura e das travas |
| [#4256](https://github.com/melgarafael/DeskcommCRM/pull/4256) | 73161 | 71838 | `alter table public.recurring_entries` + índice | antes — conforme |

O terceiro caso da frota citado no despacho **não foi identificado por medição** nesta
auditoria (ver "O que não foi verificado"). Correção para os dois medidos: mover o bloco
para **antes** de `$grants_9037$;`, mantendo-o idempotente, e reaplicar o baseline em
`install` e `update`.

### 3. A tabela da issue está atrasada em relação ao repositório

17 linhas dizem "PR de código aberto"; **9 delas já têm merge na `main`** (#3989, #3990,
#3994, #3996, #3997, #4001, #4002, #4003, #4011). #4025 está só no complemento, apesar de
incorporado. A atualização da issue é do mantenedor; esta auditoria entrega a evidência,
não edita a issue.

---

## Recomendações (nenhuma executada por esta auditoria)

1. **#3993** é o único pronto: `MERGEABLE`, checks verdes, `CLEAN`. Pedir revisão.
2. **#3998, #4007, #4009, #4010, #4015, #4016** precisam de atualização sobre a `main`.
   Ordem: #4007 antes de #4010 (empilhamento declarado); #4015/#4016 renumeram a migration
   para `92xx` no mesmo movimento. Não usar rebase nem `--force`.
3. **#4017** segue fechado sem merge e sem equivalente na `main`. Reabrir só com número
   novo e re-porte; decisão do mantenedor.
4. **#4239 e #4249**: mover o bloco de baseline para antes de `$grants_9037$;` antes de
   qualquer merge — é o mesmo defeito que trava a fila de PRs de schema.
5. Atualizar a tabela da issue com sha de merge e promover #4025 — quando o mantenedor
   quiser; esta auditoria não altera a issue.

---

## O que não foi verificado

- **Nenhum banco foi aplicado**: não rodei `pnpm test:db` nem `install.sh`/`update.sh`;
  os vereditos de schema são leitura de arquivo + `git grep`, não execução.
- **Nenhum CI foi reexecutado**. O estado de checks vem de `gh pr checks` no momento da
  leitura (2026-11-07), não de um run novo.
- **O terceiro PR travado pelo bloco de baseline** citado no despacho não foi
  identificado: medi os PRs abertos de hoje com `supabase/baseline.sql` na lista de
  arquivos e achei dois (#4239, #4249); o terceiro pode ser de outra frente ou já ter
  sido corrigido.
- **Renomeação/renumeração não foi testada**: não executei `pnpm checar:colisao-de-migration`
  sobre os heads dos PRs abertos (o script mede o diff do PR contra `origin/main`; rodá-lo
  exigiria um checkout por PR).
- **O motivo do fechamento do #4017** não está nos comentários do PR (só o corpo); a
  classificação "fechado sem merge" é medida, a intenção não.
- **Conteúdo de `#3996`**: verifiquei o documento e o merge; não reexecutei a matriz de
  permissões do token.

---

## Sabotagem de classificação

Três incorporados provados por `git grep -n` (log completo em `/tmp/dk-g713-sabot.log`,
fora do repositório): **#3883** (`with actor as materialized`) → achou em
`…_9090_visibilidade_papel_unico.sql:13`; **#3982** (`chaveDoQuadro`) → achou em
`hooks/kanban/useBoard.ts:62`; **#4011** (`crm-integridade-funil-etapa-v1`) → achou em
`…_9111_integridade_organizacao_funil_etapa.sql:18`. **3/3 ACHOU**; nenhum veredito foi
rebaixado. Controle adicional: 14/14 merges são ancestrais de `origin/main`.
