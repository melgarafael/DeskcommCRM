# INBOX.md — escalação pro humano (formato + regras)

A inbox é o "escalate to human only what's stuck" do Loop Engineering: o loop
resolve o que consegue, e o que não consegue chega ao dono **mastigado** — nunca
um erro cru.

**Escopo**: esta inbox é EXCLUSIVA do **gov-loop** (loop de construção do épico de
governança). Alertas de runtime do produto seguem os canais do próprio DeskcommCRM
(Sentry, audit log) — misturar os dois canais é defeito.

**Onde vive**: `loop/inbox.items.md` — não `loop/inbox.md`, porque em filesystem
case-insensitive (o APFS default do macOS do dono) `loop/inbox.md` e
`loop/INBOX.md` são o MESMO arquivo. É um arquivo **operacional, fora do git**
(gitignored): a resposta do humano não pode sujar o working tree — a guarda de
chão limpo do LOOP.md §0.6 stasharia a resposta como orphan. A auditabilidade vem
da cópia dos itens abertos no relatório de checkpoint (regra 6) e do progress.md.
Editam: o loop (abrir/incrementar/fechar) e o humano (responder).

## Formato de item (append no fim de `loop/inbox.items.md`)

```markdown
## [INBOX-003] G2-02 — papel de membro editável pós-convite
- status: open            <!-- open | answered | closed -->
- tipo: needs_human       <!-- needs_human | transient | human_input -->
- opened: 2026-07-20T03:10-03:00 (sessão s07)
- sessions_seen: 1
- bloqueio: o acceptance pede audit do PATCH de role, mas a spec 13 §4 não define
  se manager pode promover para admin ou só admin promove.
- tentei: (1) implementei o endpoint + RLS — PASS parcial; (2) busquei a decisão
  na spec 13 e nas respostas de G1-06 — ausente. Findings do gov-verifier:
  acceptance 2/3 ok, 3º ambíguo.
- stash: "G2-02 failed-verify 2026-07-20T03:10-03:00" — recupere com
  `git stash list | grep G2-02` (NUNCA por índice stash@{N}: o índice desloca a
  cada stash novo, inclusive os orphan da guarda de chão limpo).
- preciso do humano: manager pode promover até que role? (A) só admin promove;
  (B) manager promove até manager.
- resposta do humano:     <!-- o dono escreve AQUI e muda status pra answered -->
```

Campos obrigatórios: id sequencial, feature, status, tipo, opened, sessions_seen,
bloqueio (1-3 linhas), tentei (o que foi feito de verdade, com refs de commit/
findings), stash (a MENSAGEM do stash, se houver), preciso do humano (pergunta
objetiva, idealmente com opções A/B).

## Regras de operação

1. **Feature com item `open` está CONGELADA** — nenhuma sessão a escolhe. O
   congelamento é imediato para `needs_human` e `human_input`.
2. **`transient`** (rede caiu, provider 429, docker indisponível, recurso
   temporariamente fora): a PRÓXIMA sessão pode re-tentar UMA vez (e incrementa
   `sessions_seen`). Esta é a exceção ÚNICA ao congelamento — e está escrita também
   no LOOP.md §1.4, pra sessão que segue o prompt canônico à risca não deixar
   transients apodrecerem.
3. **Anti-apodrecimento**: item com `sessions_seen > 2` (viu 3+ sessões passarem)
   fica congelado INCONDICIONALMENTE — inclusive `transient`. O loop não re-tenta,
   não "dá mais uma chance", não recria item duplicado pra mesma feature. Racional:
   re-tentativa sem informação nova é o loop queimando orçamento pra falhar igual.
   Cada sessão que abre a inbox e vê o item aberto incrementa `sessions_seen` (só isso).
4. **Só o humano destrava**: escreve em `resposta do humano`, muda `status: answered`.
   A próxima sessão que ler um item `answered` aplica a resposta —
   **o gancho operacional está no LOOP.md §1.7**: ANTES de implementar, ler a
   resposta do humano, recuperar o stash pela mensagem (`git stash list | grep
   '<FEATURE-ID>'`), incorporar a instrução no briefing do gov-implementer, tentar
   a feature de novo (com direito ao ciclo normal implementer→verifier) e, ao
   concluir, mudar o item pra `status: closed` com uma linha de desfecho. Se a
   resposta exigir mudança de acceptance → isso é ato humano (commit com
   `DESKCOMM_GOV_PLAN_EDIT=1`), e o item fica `answered` até o features.json
   refletir a mudança.
5. **Um item por feature por bloqueio.** Bloqueio NOVO na mesma feature = item novo
   referenciando o anterior.
6. **Checkpoint lista a inbox**: todo relatório de fase COPIA os itens `open` —
   a aprovação de fase é também o momento natural do dono zerar a inbox (e a cópia
   no relatório é o registro auditável em git, já que a inbox é operacional).
7. **PII nunca entra na inbox.** Os 7 eixos do backlog vieram de feedbacks reais já
   abstraídos por tema — dado de usuário/contato é referenciado por caminho/id,
   jamais colado (LGPD, restrição de 1ª ordem do repo).
8. **Feature nova/alterada também passa por aqui**: o loop não muda o plano —
   proposta vira item `needs_human`; o humano aprova e commita com
   `DESKCOMM_GOV_PLAN_EDIT=1`.
