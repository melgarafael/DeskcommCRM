# Contexto de autorização por consulta: o que foi medido (issue #3882)

**Data:** 2026-11-07 · **Base:** `origin/main` `9fa6e0016a` · **Postgres:** `pgvector/pgvector:pg15`
**Escopo:** medição e análise. **Nenhum código comercial da instalação derivada foi portado.**

## O que este documento é (e o que ele não é)

A #3882 propõe compartilhar com o núcleo uma otimização de contexto de
autorização aplicada numa instalação derivada, e deixa explícito que só a parte
genérica interessa. Este documento entrega três coisas medidas aqui, na árvore
da `main`: quanto a RLS atual custa **por linha**, o que o recorte já merged
(`#3883`, `supabase/migrations/20261103032500_9090_visibilidade_papel_unico.sql`) economiza
de fato, e qual fatia ainda faria sentido no núcleo — com a decisão para o
mantenedor.

**Não medido aqui:** a instalação de origem. Os números dela (seção 4) são os
publicados na issue, com o método declarado por quem os mediu; não foram
reproduzidos nesta árvore e não entram em nenhuma conclusão de ganho.

## Como foi medido

1. Container descartável `pgvector/pgvector:pg15`; prelude de stubs do Supabase
   extraído de `scripts/test-db.sh` (linhas 199–378) e `supabase/baseline.sql`
   aplicado com `ON_ERROR_STOP=1` — o mesmo caminho do gate `invariants`.
2. Dataset sintético, duas organizações, `settings.visibility_mode =
   'own_and_unassigned'`: 5.000 contatos + 5.000 conversas por organização e
   5.000 negócios na organização A; depois +15.000 de cada na organização A
   (20.000 linhas) para medir **escala**.
3. Sessão real de RLS: `set role authenticated` + `set_config('request.jwt.claims',
   '{"sub":"<uuid do atendente>"}')` — é o mesmo contrato do `auth.uid()`
   (`supabase/baseline.sql`, stub em `scripts/test-db.sh:368`).
4. Cada consulta rodou **5 vezes**; a tabela traz mediana, mínimo e máximo de
   `Execution Time` do `EXPLAIN (ANALYZE)`. Scripts: `/tmp/g695-seed-base.sh`,
   `/tmp/g695-medir.sh` (worktree `wt-695-ajuda`), log `/tmp/dk-g695-medir.log`.

## 1. A RLS é avaliada por LINHA — e o `LIMIT` não a limita

Plano de `select count(*) from public.conversations` como `agent` (20.000
linhas na organização), `EXPLAIN (ANALYZE, costs off)`:

```
Aggregate (actual time=102.863..102.878 rows=1 loops=1)
  InitPlan 1 (returns $0)
    ->  Result (actual time=0.621..0.622 rows=1 loops=1)
  ->  Seq Scan on conversations (actual time=56.749..101.885 rows=20000 loops=1)
        Filter: ($0 OR (hashed SubPlan 2) OR ... OR ((assigned_to_user_id IS NULL) AND (hashed SubPlan 4)) ...)
        Rows Removed by Filter: 5000
```

Duas leituras, e as duas importam para a #3882:

- **O que já é por consulta:** `fn_is_platform_admin()` virou `InitPlan 1` e as
  chamadas a `fn_conversation_scope()` viraram `hashed SubPlan` — ou seja, o
  desenho "contexto uma vez por consulta" **já existe** nesta policy, e é por
  isso que o custo de `count(*)` cresce pouco com o número de linhas.
- **O que continua por linha:** `assigned_to_user_id = auth.uid()`,
  `assigned_to_user_id is null` e os demais predicados são avaliados em cada uma
  das 20.000 linhas (`Rows Removed by Filter: 5000`). Um `LIMIT 25` **não**
  reduz esse trabalho: a qual é aplicada antes de ordenar e limitar.

| Consulta (agent, `own_and_unassigned`) | 5.000 linhas | 20.000 linhas (4×) |
|---|---:|---:|
| `contacts` ordenado por `last_activity_at`, `limit 25` | 79,19 ms | 87,93 ms |
| `count(*)` em `conversations` | 96,32 ms | 124,13 ms |
| `crm_leads`, `limit 50` | 29,45 ms | 30,06 ms |

Crescer 4× a tabela custou entre **+2%** e **+29%**, e não 4×: o grosso do
trabalho é constante por consulta. Onde cresce de verdade é no que a issue
original chama de "helpers de canal/carteira/contato" — que na `main` **não
existem** com aqueles corpos.

## 2. A/B do recorte que JÁ está no núcleo (`#3883` / migration `9090`)

O PR #3883 (merged em `7ecb7908a3`) trocou as duas chamadas de
`fn_user_role_in_org(p_org)` por um `with actor as materialized` em
`fn_can_view_lead` e `fn_can_view_conversation`. Medindo o corpo **anterior**
(duas chamadas) contra o **da main** (uma), no mesmo banco e mesmo dataset de
20.000 linhas:

| Consulta | Corpo anterior (2 chamadas) | Corpo da main (1 chamada) | Δ |
|---|---:|---:|---:|
| `crm_leads`, `limit 50` | 56,60 ms (min 55,40 · máx 61,09) | 27,07 ms (min 26,14 · máx 29,28) | **−52%** |
| `count(*)` em `conversations` | 119,71 ms (min 112,59 · máx 137,35) | 116,96 ms (min 113,21 · máx 122,83) | −2,3% (dentro do ruído) |

**Leitura honesta:** a deduplicação por chamada paga onde o helper cai no filtro
por linha (negócios: −52%, estável em 5 execuções); em `conversations`, onde a
policy já resolve o contexto por `InitPlan`/`hashed SubPlan`, ela não muda nada
mensurável. Ganho de "contexto por consulta" **não** vem deste recorte — vem de
o predicado deixar de ser por linha, que é exatamente o que a proposta original
descreve e o que a `main` ainda não tem.

## 3. Fatia genérica mínima que faria sentido no núcleo

1. **Papel resolvido uma vez por avaliação de policy** — já entregue por #3883;
   nada a fazer.
2. **Contexto (ator, membership, suporte, escopos) separado das decisões por
   atributo de linha**, exposto como subconsulta não correlacionada por policy
   (`InitPlan`), sem GUC controlável pelo cliente e sem cache entre instruções.
   É a parte que falta — e a que precisa de revisão de mantenedor, porque muda
   a forma de **todas** as policies que a usarem.
3. **Invariante que mede recálculo, não latência** (como
   `tests/invariants/visibilidade-papel-unico.sql` já faz com spies
   transacionais): sem ele, uma regressão futura volta a avaliação por linha e
   nenhum teste de comportamento percebe.

Fora da fatia mínima, de propósito: qualquer helper de canal, carteira ou
contato da instalação derivada, e qualquer troca por `service_role`, remoção
de RLS ou aumento de timeout.

## 4. Números da instalação de origem (publicados na #3882, não reproduzidos aqui)

Método declarado por quem mediu: TTFB observado pelo Network/CDP de um navegador
autenticado, **três GETs sequenciais por endpoint**, sem cache de disco
reportado e sem build concorrente. Não é tempo total de pintura.

| Caminho | Histórico 30/10 | Mediana em 03/11 (3 amostras) |
|---|---:|---:|
| `contacts?order_by=last_activity_at&order_dir=desc&limit=25` | 8.019,857 ms | 490,863 ms |
| `pipelines/:id/board` | 9.993,225 / 8.096,240 ms | 1.154,487 ms |
| `conversations?comando=aguardando&limit=50` | 5.310 ms | 644,389 ms |
| `conversations/counts` | HTTP 500 em ~8,6–9,3 s | 2.613,403 ms |

Contraponto que a própria issue registra e que vale repetir: no reload real da
Inbox, com requisições auxiliares concorrentes, a lista levou **2.940,893 ms**.
Ou seja, 644 ms é a melhor amostra, não o comportamento garantido.

## 5. Pergunta objetiva ao mantenedor

> A `main` aceitaria uma fatia que mova o contexto de autorização (ator,
> membership, suporte, escopos) para uma subconsulta não correlacionada por
> policy — `InitPlan` — mantendo os predicados por atributo de linha e as
> policies compostas como estão hoje, com um invariante que prova a avaliação
> única por consulta (e não latência)? Se sim, o recorte é uma policy de
> referência + invariante, para revisão antes de tocar as demais.

Se a resposta for "não agora", esta issue fecha como medição: o recorte
portável já entrou (#3883), o resto depende de decisão de arquitetura de RLS
que não cabe a uma contribuição externa decidir sozinha.
