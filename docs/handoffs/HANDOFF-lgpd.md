# HANDOFF — LGPD · achados e estado

> Documento separado por decisão do Rafael (2026-07-24): *"LGPD deixe em um doc de handoff,
> resolvemos depois"*. **Nuvemshop foi desligada — os webhooks dela são irrelevantes.**
>
> Estes achados surgiram **durante** a entrega CRM Vivo (ver `HANDOFF-crm-vivo.md`), porque a
> migration `0071` acrescentou colunas à `crm_lead_activities` e isso obrigou a olhar o cascade de
> anonimização. **Nenhum é regressão nossa** — todos já existiam.

---

## Resumo executivo

**O fluxo de LGPD do titular individual não funcionava em nenhuma etapa.**

| Etapa | Antes | Estado |
|---|---|---|
| **Criar** pedido pela API | ❌ o app enviava `customer_redact`; o banco só aceita `redact` → violava a constraint | ✅ corrigido (`090c59e`) |
| **Encontrar** na lista | ❌ filtro devolvia vazio, **em silêncio** | ✅ corrigido |
| **Aprovar** pela tela | ❌ a página caía no error boundary | ✅ corrigido |
| **Processar** no worker | ❌ o worker **recusava** o tipo comum com `wrong_request_type` | ✅ corrigido |
| **Executar** o cascade | ❌ abortava na 1ª etapa: escrevia em coluna **gerada** | ✅ corrigido (`f33119b`) |

Havia SLA legal (D+15) apontando para um caminho que **não completava em nenhum ponto**.

---

## Achado 1 — o cascade abortava (corrigido)

`contacts.email_normalized` é `GENERATED ALWAYS AS (lower(trim(email))) STORED`, e
`fn_lgpd_cascade_redact_contact` fazia `email_normalized = null`. O Postgres recusa (*"column can
only be updated to DEFAULT"*), a função **abortava na etapa 1** e **nada era anonimizado**.

**Correção:** remover a atribuição — a coluna deriva de `email`, e o mesmo `UPDATE` já faz
`email = null`.

**Premissa validada em banco real antes de aceitar:** havia hipótese de a expressão produzir
**string vazia** em vez de `null`, o que manteria o e-mail normalizado **legível** após a
anonimização — trocaríamos um bug que estoura por um que **vaza calado**. Confirmado que zera.

**Por que ficou escondido:** o teste existente **mockava o RPC** — provava que a chamada acontece,
não que funciona.

---

## Achado 2 — divergência de vocabulário em 3 camadas (corrigido)

| Camada | Falava | Banco aceita |
|---|---|---|
| Tipo TS (**3 declarações** diferentes) | `customer_redact`, `customer_data_request` | `redact`, `data_request` |
| UI (5 mapas de rótulo locais) | idem | idem |
| **Workers** | aceitavam só `store_redact` | — |

**Provado com `INSERT` lado a lado + rollback:** `customer_data_request` **viola** a constraint;
`data_request` entra.

### 🔴 O nível mais grave — um pedido real recusado em silêncio

O `lgpd-redact-worker` **recusava** `redact` (anonimizar UM cliente, o caso comum) com
`wrong_request_type`. **Há uma linha `redact` parada no banco há tempo: um pedido de titular que
entrou e o processador rejeitou.** Ninguém soube.

> Não é bug de tela nem de tipo. É um titular exercendo um direito, e o sistema dizendo *"não
> entendi"* **para si mesmo**, em silêncio, com o prazo correndo.

**Correção:** os dois hooks passam a reexportar o tipo canônico de `lib/lgpd/types.ts`; o rótulo
em pt-BR sai de `LGPD_REQUEST_TYPE_LABELS` na mesma fonte (no lugar de 5 mapas locais). 13
arquivos de UI/rotas/cron + 2 workers alinhados.

---

## ⚠️ Débito NÃO corrigido — mesma classe, pronto para estourar

`lib/lgpd/types.ts` ainda declara valores que o banco rejeita:

| Campo | Tipo declara | Banco aceita |
|---|---|---|
| `source` | `admin_panel` | `nuvemshop`, `manual`, `api`, `support` |
| `status` | `pending_review` | `received`, `processing`, `completed`, `failed`, `expired` |

**Mesma mecânica do Achado 2:** um `INSERT` com esses valores viola a constraint. Não foi tocado
por decisão de escopo.

---

## Outros achados registrados

1. **A lista mostra o titular como `ctt:5b37994e`**, não pelo nome — quem opera um fluxo com prazo
   legal não reconhece o titular sem abrir cada item.
2. **Não existe runner por handler.** `processLgpdRedact` é função pura sem `main`; o único script
   é o worker **genérico**, que carrega todos os handlers (inclusive envio). Consequência
   operacional real: **não dá para processar uma classe de evento isoladamente, nem reprocessar um
   evento específico após incidente** — num sistema que promete SLA de LGPD.
3. **`nuvemshop_callback_not_implemented`** emitido pelo worker (irrelevante agora: integração
   desligada).

---

## O que ficou PROVADO e serve ao CRM Vivo

Ensaio completo em tenant descartável, **9/9**, com worker em escopo cirúrgico (só
`lgpd.redact_received` daquela org, com guarda recusando outro tipo/org):

**Some, como deve:** contato anonimizado (`Cliente Anonimizado #877bfe4f`) · `activity.reason` →
`NULL` (era texto com telefone) · `payload`/`metadata` → `{}`.

**Sobrevive, como deve:** **`activity.evidence`** (`run_ids`/`trace_ids` idênticos antes/depois) ·
**`activity.actor_kind`** (`ai` → `ai`) · `created_at`.

> **Isto valida a decisão de doutrina do CORE 2:** a timeline continua auditável depois de um
> pedido de anonimização. Se o `evidence` sumisse junto, teríamos trocado vazamento de PII por
> **destruição de trilha**, e a promessa de *"toda afirmação da IA tem lastro"* morreria no
> primeiro redact.

**Nota útil para quem retomar:** `redact` é **contact-scoped** — toca só o contato alvo. Não
precisa de tenant separado para testar. O tenant B só foi necessário porque `store_redact` é
**tenant-wide** (na org de teste atingiria 55 contatos, 132 mensagens e 51 leads,
irreversivelmente).

---

## Commits desta frente (locais, sem envio ao remoto)

| Commit | O quê |
|---|---|
| `f33119b` | a anonimização volta a executar — e o teste passa a provar o ciclo |
| `090c59e` | o LGPD passa a falar o vocabulário do banco |

**Ativo reutilizável criado:** `scripts/seed-e2e-tenant-b.ts` — org completa, admin com TOTP,
pipeline, lead e titular. Serve para o negativo de realtime (já usado), ensaios destrutivos e
testes de isolamento. Idempotente.

**Pendente:** `tests/capture-lgpd-redact.ts` está pronto e para exatamente onde o ciclo do tipo
`redact` era bloqueado. Com o vocabulário alinhado, ele deve rodar e provar os dois lados **mais**
o filtro encontrando.
