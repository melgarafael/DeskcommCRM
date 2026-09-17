# Lote 12 · G2 — sabotagens com previsão escrita antes de rodar

SHA medido: ver `git log -1` do commit que traz este arquivo. Árvore limpa
(`git status --porcelain` vazio) antes de cada sabotagem e depois de cada
reversão — conferido nas 19 rodadas.

**Base verde**, 13 arquivos que tocam os módulos do grupo (os 6 alterados, mais
os 4 que importam `CRMSidePanel`/`useUpdateContact`/`crm-summary` e os 3 guardas
de i18n, porque um dos consertos troca uma chave de tradução):

```
 Test Files  13 passed (13)
      Tests  75 passed (75)
```

A previsão de cada linha foi escrita ANTES da rodada. A coluna "medido" é o
rodapé do vitest, que é a autoridade; os nomes vieram das linhas `FAIL`.

| # | PR | mecanismo sabotado | previsto | medido | bate |
|---|---|---|---|---|---|
| S1 | 909 | rótulo do botão volta a `t("Lead")` | 1/6 | `1 failed \| 5 passed (6)` | sim |
| S2 | 909 | o clique deixa de abrir o diálogo (`onClick={() => {}}`) | 1/6 | `1 failed \| 5 passed (6)` | sim |
| **S2c** | 909 | **CONTROLE** — a MESMA sabotagem S2 sobre o estado da integração (produto e teste restaurados de `origin/integracao/triagem-15set-l12`) | **0/6** | `6 passed (6)` | sim |
| S3 | 944 | `crm_pipelines!inner(` → `crm_pipelines(` | 1/2 | `1 failed \| 1 passed (2)` | sim |
| S4 | 944 | embed `crm_stages(name)` fora do `select` | 1/2 | `1 failed \| 1 passed (2)` | sim |
| S5 | 944 | `.eq` do funil arquivado movido para DEPOIS do `.limit(3)` | 1/2 | `1 failed \| 1 passed (2)` | sim |
| S6 | 944 | `line-clamp-2` volta a `truncate` | 1/5 | `1 failed \| 4 passed (5)` | sim |
| S6b | 944 | `title={ondeEstaOLead(...)}` removido dos dois pontos | 1/5 | `1 failed \| 4 passed (5)` | sim |
| S7 | 944 | a tela crava "Ganho"/"Perdido" em vez de ler o funil | 1/5 | `1 failed \| 4 passed (5)` | sim |
| S8 | 944 | `vocabulary` fora do embed da rota | 1/2 | `1 failed \| 1 passed (2)` | sim |
| S9 | 946 | filtro do chip volta a `!tags.includes(v)` (sem normalizar) | 2/4 | `2 failed \| 2 passed (4)` | sim |
| S10 | 946 | dedupe do `add()` volta a `tags.includes(tag)` | 1/4 | `1 failed \| 3 passed (4)` | sim |
| S11 | 946 | a rota para de normalizar o que devolve | 1/6 | `1 failed \| 5 passed (6)` | sim |
| S12 | 946 | URL do hook → `/api/v1/conversation-tags` | 1/4 | `1 failed \| 3 passed (4)` | sim |
| S13 | 946 | `.order("updated_at", { ascending: false })` removido | 1/6 | `1 failed \| 5 passed (6)` | sim |
| S14 | 946 | `.limit(CONTATOS_LIDOS)` removido | 1/6 | `1 failed \| 5 passed (6)` | sim |
| S15 | 946 | `.slice(0, TETO_DE_TAGS)` removido | 1/6 | `1 failed \| 5 passed (6)` | sim |
| S16 | 946 | volta a mandar `error.message` do Postgres ao navegador | 1/6 | `1 failed \| 5 passed (6)` | sim |
| S17 | 946 | `invalidateQueries(["contact-tag-vocabulary"])` removido | 1/2 | `1 failed \| 1 passed (2)` | sim |

**18 previsões de linha, 18 exatas.** Uma ressalva sobre o meu próprio resumo: a
soma que escrevi na folha de previsão dizia 20 casos vermelhos no total, e o
medido é 19 — erro de aritmética meu ao somar a coluna, não divergência de
nenhuma linha.

## O que o S2c comprova

A revisão afirmou que o teste do #909 guardava o RÓTULO e não o PONTO DE USO, e
que trocar o `onClick` por um no-op não reprovaria nada no repositório inteiro.
Isso foi MEDIDO aqui, e é verdade: no estado da integração a sabotagem deixa os
6 casos verdes. Com o caso novo — que clica no botão e espera o diálogo — a mesma
sabotagem produz 1 vermelho (S2). O buraco existia e está fechado.

O caso novo só é possível porque o mock de `useDefaultPipeline` passou a devolver
um funil de verdade: com `data: null` o `<NewLeadDialog>` nunca entra na árvore,
então um teste que clicasse não teria o que encontrar.

## Sabotagens que a revisão previu como inócuas e agora mordem

- **S12** (URL do hook): a revisão previu "0 casos vermelhos em toda a suíte, e
  `typecheck` e `eslint` também passam". Com a asserção nova sobre o argumento do
  `get`, dá 1 vermelho.
- **S3** (`!inner`): o dublê resolve `crm_pipelines.is_archived` por caminho
  dentro da linha, com ou sem `!inner`. Quem reprova agora é a espionagem da
  string do `select`.
