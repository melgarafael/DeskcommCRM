# Nuvemshop · E1 — Sincronização de pedidos e pedidos na ficha

**Data:** 2026-10-08 · **Status:** design aprovado em conversa, aguardando revisão da spec
**Destino (DoD 18):** núcleo — a integração Nuvemshop já é distribuída no núcleo; esta entrega a faz funcionar. "Se nenhuma organização conectar uma loja, a operação comum continua inteira?" Sim: tudo aqui só roda para organização com `tenant_integrations.provider='nuvemshop'`.

## 1. Problema (medido em 2026-10-08, `upstream/main` c564c6419)

O EPIC-07 está marcado `status: completed`, mas só entregou OAuth + recepção de webhooks:

- `app/api/v1/webhooks/nuvemshop/[event]/route.ts` valida HMAC, grava `webhook_events_log` e emite `nuvemshop.order_created|order_updated|order_paid|order_cancelled|product_*|app_uninstalled` no `event_log` — **nenhum handler consome esses tipos** (anti-pattern 3, evento sem consumer).
- Não existe backfill: `NuvemshopApiClient` só tem `getStore`, `listWebhooks`, `createWebhook`, `deleteWebhook`.
- `public.orders` existe, tem RLS e é **lida** pela ficha (`app/api/v1/contacts/[id]/crm-summary/route.ts`) e pela tool MCP `crm_list_contact_orders` (`lib/mcp/tools/comercio.ts`) — mas **ninguém escreve** nela fora mescla de contatos e redact LGPD.
- Não existem `sync_progress`, `contact_external_ids`, `resolveContact`, `EcommercePlatformAdapter` que o EPIC-07 descreve.

Consequência para quem conecta uma loja hoje: pedidos não aparecem no contato, o agente não sabe dos pedidos, e os webhooks viram só log bruto podado em 90 dias.

## 2. Objetivo e critério de sucesso

Ao conectar uma loja Nuvemshop:

1. Os pedidos dos **últimos 12 meses** são importados para `orders`, ligados a contatos.
2. Pedidos novos/alterados chegam em `orders` em segundos (webhook) e, se o webhook falhar, em ≤30 min (reconciliação).
3. A ficha do contato mostra os pedidos; o agente os consulta via `crm_list_contact_orders`.
4. O admin vê na tela de integração quantos pedidos foram sincronizados, o estado e o último erro, e pode pedir "Sincronizar agora".

Sucesso medido: loja de teste com N pedidos em 12 meses → `select count(*) from orders where external_provider='nuvemshop'` = N após o backfill; alterar status de um pedido na Nuvemshop → `orders.status` reflete em <1 min; derrubar o webhook (URL errada) → reconciliação corrige em ≤30 min.

## 3. Fora de escopo (entregas seguintes)

- **E2** produtos → `catalog_products` (`origem='nuvemshop'`) + correção do evento do RAG (`nuvemshop.product_synced` nunca é emitido).
- **E3** pedido vira lead no funil "Pedidos".
- **E4** relatórios de receita.
- Carrinho abandonado; clientes sem pedido; pedidos de outras plataformas (issue #2442, vizinha).

## 4. Arquitetura

### 4.1 Unidade de trabalho: uma página por evento

```
callback OAuth ─┐
cron 30 min ────┼─▶ emit nuvemshop.sync_page {run_id, janela_ini, janela_fim, alvo_fim, pagina}
"Sincronizar" ──┘                 │
                                  ▼
                handler nuvemshop-sync.v1
                GET /orders?updated_at_min=janela_ini&updated_at_max=janela_fim
                           &page=pagina&per_page=200
                → gravarPedido() para cada item
                → página cheia? emite pagina+1
                  senão janela_fim < alvo_fim? emite próxima janela, pagina=1
                  senão fecha o run: cursor_updated_at = alvo_fim, status=idle

webhook order/* ─▶ nuvemshop.order_* (já emitido) ─▶ handler nuvemshop-pedido.v1
                                                     GET /orders/{id} → gravarPedido()
webhook app/uninstalled ─▶ nuvemshop.app_uninstalled ─▶ handler nuvemshop-desinstalacao.v1
                                                        tenant_integrations.status='disconnected'
```

Por que assim: o `event_log` já dá retry com backoff (`lib/event-log/drain.ts`, `MAX_ATTEMPTS=5`), `retry` com `retry_at` que **não conta tentativa** (ideal para 429), detecção de evento preso e aviso de evento morto na Central. Um handler longo (loop de todas as páginas) cairia na detecção de preso e recomeçaria do zero.

### 4.2 Janelas

- **Backfill** (no callback): `alvo_fim = instante da conexão`; janelas **mensais** de `alvo_fim − 12 meses` até `alvo_fim`.
- **Reconciliação** (cron) e **"Sincronizar agora"**: uma janela `[cursor_updated_at, now()]`, `alvo_fim = now()`.
- **Teto de 10.000 itens por consulta** (documentado pela Nuvemshop): com `per_page=200`, a página 50 cheia significa que a janela pode ter mais. Regra: ao receber a página 50 cheia, o handler **divide a janela ao meio** (`janela_fim = meio`, `pagina = 1`) e reemite. As páginas já gravadas são regravadas sem efeito (upsert idempotente, §5.1). A cadeia segue do meio até `alvo_fim` normalmente.
- **Janela fixa durante a paginação.** Um pedido alterado no meio da paginação sai da janela (seu `updated_at` passa de `janela_fim`) e pode deslocar páginas; ele é recuperado pela próxima reconciliação, porque `updated_at > janela_fim ≥ cursor`. O cursor só avança quando o run termina.

### 4.3 Concorrência

- `integration_sync_state.run_id` + `status='running'` + `trava_ate` (now + 15 min, renovada a cada página).
- Evento `sync_page` cujo `run_id` não é o run corrente → `skipped` (`run_obsoleto`).
- Novo run só começa com `status='idle'`, `status='error'` com causa não-auth, ou `trava_ate < now()` (run morto).
- "Sincronizar agora" com run ativo → 409 `sync_em_andamento` (UI mostra "já está sincronizando").
- Webhooks **não** respeitam a trava: o upsert "mais novo vence" (§5.1) é seguro em paralelo com o backfill.

### 4.4 Ritmo e erros da API

| Resposta | Ação |
|---|---|
| 429 | `retry`, `retry_at = now + x-rate-limit-reset` (ms; default 2 s se ausente). Não conta tentativa. |
| 401 / 403 | `tenant_integrations.status='error'`, `integration_sync_state.status='error'` com `ultimo_erro='auth'`, aviso na Central (`integracao_desautorizada`, §7) "Reconecte a Nuvemshop"; reconciliação pula a org até reconectar. Handler retorna `error` sem retry. |
| 404 em `GET /orders/{id}` | `skipped` (`pedido_inexistente`). |
| 5xx / rede | `error` → backoff do drain; esgotado, evento `dead` + aviso já existente. |
| Pedido que falha em `traduzirPedido` (dado inesperado) | registra no `ultimo_erro`, conta em `pedidos_com_erro`, **segue a página** (um pedido ruim não trava a loja). |

Os nomes exatos dos cabeçalhos de rate limit são confirmados contra a API real no plano (tarefa de verificação), antes de codificar.

### 4.5 Handlers (registro em `lib/event-log/register-handlers.ts`)

| key | events | naOrgParada | motivo |
|---|---|---|---|
| `nuvemshop-sync.v1` | `nuvemshop.sync_page` | `pula` | chama API externa |
| `nuvemshop-pedido.v1` | `nuvemshop.order_created`, `nuvemshop.order_updated`, `nuvemshop.order_paid`, `nuvemshop.order_cancelled` | `pula` | chama API externa |
| `nuvemshop-desinstalacao.v1` | `nuvemshop.app_uninstalled` | `roda` | escrita interna |

Todos carregam a integração por `organization_id` do evento (fonte confiável: o webhook resolveu a org por `store_id` + HMAC; o callback por `state` assinado; o cron pela própria tabela). Admin client sempre com `.eq("organization_id", ...)` explícito (anti-pattern 10).

### 4.6 Cron de reconciliação

`app/api/v1/cron/nuvemshop-reconcile/route.ts`, agendado no `scheduler` a cada 30 min (mesmo mecanismo dos demais crons; sem edição manual na VPS — doutrina de packaging). Para cada integração `status='healthy'` cujo sync está `idle` e `cursor_updated_at < now() − 25 min`: inicia run e emite o primeiro `sync_page`. **Audita só quando emitiu algo** (`tests/unit/cron-audita-so-quando-ha-efeito.test.ts`).

## 5. Dados

### 5.1 `orders` — escrita "mais novo vence"

Função SQL `public.fn_gravar_pedido_externo(p_organization_id uuid, p_pedido jsonb) returns uuid`:

```sql
insert into public.orders (...) values (...)
on conflict (organization_id, external_provider, external_id) do update
  set ... = excluded....
  where orders.updated_at_remote is null
     or excluded.updated_at_remote >= orders.updated_at_remote
returning id;
```

- `security definer`, `revoke execute ... from public, anon; grant execute ... to service_role;` (doutrina de migrations item 9 — as duas origens).
- Não toca `is_anonymized=true`: pedido anonimizado não é reescrito (`where ... and not orders.is_anonymized`).
- Upsert pela PostgREST não expressa o `where` condicional; por isso função.

### 5.2 `traduzirPedido()` — puro, em `lib/nuvemshop/sync/traduzir-pedido.ts`

| `orders` | origem Nuvemshop (API 2025-03) |
|---|---|
| `external_provider` | `'nuvemshop'` |
| `external_id` | `String(id)` |
| `status` | `status='cancelled'` ou `payment_status='voided'` → `cancelled`; `payment_status in ('refunded')` → `refunded`; `shipping_status='delivered'` → `delivered`; `shipping_status='shipped'` → `shipped`; `payment_status in ('paid','partially_refunded')` → `paid`; demais (`pending`, `authorized`, `partially_paid`, `abandoned`) → `pending`. Ordem de avaliação é a da lista. |
| `fulfillment_status` | `unpacked`→`unpacked`; `partially_packed`/`partially_fulfilled`/`unshipped`→`packed`; `shipped`→`shipped`; `delivered`→`delivered`; outro/nulo → `null` |
| `total_cents` | `total` (string decimal) → centavos por parsing de string, **nunca** `parseFloat * 100` |
| `currency` | `currency` (ISO-4217; fallback `'BRL'`) |
| `payment_method` | `gateway` (texto livre) |
| `tracking_code` | `shipping_tracking_number` |
| `ordered_at` | `created_at` |
| `updated_at_remote` | `updated_at` |
| `customer_external_id` | `customer.id` |
| `payload` | **projeção**, não o pedido bruto (§5.4) |

Valor desconhecido nunca chega ao CHECK: cai no default da linha e o bruto fica em `payload.origem`.

### 5.3 Contato — `lib/nuvemshop/sync/contato-do-pedido.ts`

Chaves extraídas do pedido:

- telefone: `contact_phone` ?? `customer.phone` ?? `customer.billing_phone` → `normalizePhoneBR` (`lib/webhooks/inbound.ts`)
- e-mail: `contact_email` ?? `customer.email` → `lower(trim())`
- CPF: `contact_identification` ?? `customer.identification`, só se 11 dígitos após `normalizeCpf` → `hashCpf` / `encryptCpfSql` (`lib/contacts/cpf.ts`)
- nome: `contact_name` ?? `customer.name`

Decisão (função pura `decidirContato(chaves, candidatos)` + efeito separado):

1. Busca ativos (`is_merged_into is null and not is_anonymized`) na org por telefone, depois e-mail, depois `cpf_hash`. Primeiro acerto vence — **telefone tem precedência** (WhatsApp é o canal primário).
2. Achou: completa **só campos vazios** (nome, e-mail, CPF). Colisão `23505` num índice único (`uniq_contacts_org_email`/`_cpf`) → pula esse enriquecimento, não falha.
3. Não achou e há ao menos uma chave: cria com `source='nuvemshop'`, `source_metadata={store_id, customer_id}`, consentimento default (vazio — não entra em campanha). Corrida `23505` no insert → re-seleciona o vencedor (padrão de `app/api/v1/webhooks/in/[token]/route.ts`).
4. Nenhuma chave: pedido gravado com `contact_id = null`.

`is_blocked` (STOP) nunca é alterado pela sincronização.

### 5.4 Projeção do `payload` (minimização LGPD + espaço em VPS)

Guarda: `number`, `status`, `payment_status`, `shipping_status`, `gateway`, `channels`, `subtotal`, `discount`, `shipping_cost_customer`, `products: [{product_id, variant_id, name, quantity, price}]`, `shipping_option`, `landing_url`, `utm` (se presente) e `origem` (valores brutos de status). **Não** guarda endereço, documento, IP, nota do cliente. Motivo: o pedido bruto passa de 5 KB e repete PII que já vive em `contacts`; 12 meses de uma loja média caberiam mal na cota de um self-host. `products` fica porque a E4 (recompra/ticket) precisa.

### 5.5 Migration nova — `integration_sync_state`

```sql
create table if not exists public.integration_sync_state (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (provider in ('nuvemshop')),
  resource text not null check (resource in ('orders')),
  status text not null default 'idle' check (status in ('idle','running','error')),
  run_id uuid,
  run_origem text check (run_origem in ('conexao','reconciliacao','manual')),
  trava_ate timestamptz,
  cursor_updated_at timestamptz,
  janela_atual_ini timestamptz,
  janela_atual_fim timestamptz,
  alvo_fim timestamptz,
  pedidos_gravados integer not null default 0,
  pedidos_com_erro integer not null default 0,
  ultimo_erro text,
  ultimo_run_fim timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider, resource)
);
```

- `provider`/`resource` como `text + check` (convenção). E2 amplia `resource` com `'products'` — CHECK fechado é seguro aqui porque nenhum clone tem linha legada.
- RLS `tenant_isolation_integration_sync_state_all` via `fn_user_org_ids()`; escrita só por service role (handlers/cron) — policy de leitura para `authenticated`, sem policy de escrita.
- Trigger `fn_set_updated_at`.
- A mesma migration acrescenta `integracao_desautorizada` ao CHECK de `agent_inbox_items.kind` (§7).
- Migration versionada + `-- manifest:` + apêndice idempotente no `baseline.sql` + `notify pgrst, 'reload schema'`. Número `NNNN` alocado no plano com `pnpm checar:colisao-de-migration`.

## 6. Tela

`app/app/integrations/nuvemshop/page.tsx`, cartão "Conectado", ganha bloco **Pedidos**:

- `Pedidos sincronizados: <count de orders da org/provider>` · `Última sincronização: <ultimo_run_fim>`
- Estado: `Importando: mês X de 12` (backfill, derivado de `janela_atual_ini` vs `alvo_fim`) · `Sincronizando…` · `Em dia` · `Erro: <motivo legível>` (mapa de `ultimo_erro` → frase; `auth` → "A loja revogou o acesso. Desconecte e conecte de novo.")
- Botão **Sincronizar agora** (admin; `requireSupportWrite` antes do efeito; audit `nuvemshop.sync_requested`).
- Textos via `traduzir()` (pt-BR/en/es), como o resto da página.

A seção de pedidos da ficha já existe (lê `orders`); o plano verifica pela tela que ela renderiza os pedidos sincronizados.

## 7. Auditoria e observabilidade

- Audit: `nuvemshop.sync_requested` (manual), `nuvemshop.sync_completed` (fim de run com `pedidos_gravados > 0`, com contagens), `nuvemshop.sync_failed` (auth), `nuvemshop.uninstalled`. Vocabulário em `lib/audit/actions.ts`.
- Sem `console.log`; logger estruturado. Nenhum token/secret em log ou audit.
- Aviso na Central para erro de auth: **kind novo `integracao_desautorizada`** em `agent_inbox_items` (medido: nenhum dos 40+ kinds atuais cobre integração). Entra **no bloco único** de `agent_inbox_items_kind_check` do baseline — reconstruir a constraint em bloco novo quebra o `update.sh` (vigiado por `tests/unit/baseline-constraint-reconstruida.test.ts`). `ref_id` = id da `tenant_integrations`; um aviso aberto por integração.

## 8. Living System Checklist (DoD 13)

- **Entrada:** callback OAuth, webhooks `order/*` e `app/uninstalled`, cron `nuvemshop-reconcile`, botão manual.
- **Saída:** `orders` → ficha (`crm-summary`) e tool `crm_list_contact_orders`; `contacts` novos.
- **Log:** `integration_sync_state`, `api_audit_log`, `event_log`.
- **Tela:** cartão Nuvemshop; ficha do contato. **Porta:** `/app/integrations/nuvemshop` já está em `lib/navigation/catalogo.ts`.
- **Anti-morte:** reconciliação de 30 min cobre webhook desativado pela Nuvemshop; run morto expira por `trava_ate`.
- **Laço de retorno (invariante 7):** erro de auth → aviso na Central + estado na tela → admin reconecta → próxima reconciliação retoma do cursor.
- **Mapa vivo:** `docs/architecture/` ganha peça `nuvemshop-sync` com arestas webhook/cron → `orders` → ficha/MCP.

## 9. Testes

**Unit (vitest, co-localizados):**
- `traduzirPedido`: tabela com cada combinação de status/pagamento/envio; centavos (`"0.10"`, `"1234.5"`, `"99"`, vírgula ausente); moeda ausente; status desconhecido não vaza para o CHECK.
- `decidirContato`: telefone vence e-mail divergente; só e-mail; só CPF; nenhuma chave; candidato anonimizado/mesclado ignorado.
- Janelas: 12 janelas mensais; divisão ao bater página 50 cheia; encadeamento até `alvo_fim`.
- Handler `nuvemshop-sync.v1` com `fetch` simulado: 429 → `retry` com `retry_at`; 401 → `error` + estado `auth`; página cheia → emite próxima; `run_id` obsoleto → `skipped`.
- Handler `nuvemshop-pedido.v1`: 404 → `skipped`; sucesso chama `gravarPedido`.
- Cron: só audita quando emitiu.

**`pnpm test:db` (invariantes):**
- `integration_sync_state` isolada entre 2 orgs (RLS).
- `fn_gravar_pedido_externo`: mais novo vence; mais velho não sobrescreve; anonimizado intocado; não executável por `anon`/`authenticated` (cobre também `hardening-definer-varredura`).

**Prova pela tela (DoD 12):**
- E2E em ambiente fresco (baseline + bootstrap-owner) com **receiver HTTP que imita a API Nuvemshop** (`/apps/authorize/token`, `/{store}/webhooks`, `/{store}/orders`): conectar → backfill → cartão mostra N pedidos → ficha do contato mostra o pedido. Evidência em `evidence/nuvemshop-sync-e1/`.
- Prova manual com o app real (43409) numa loja de teste antes de declarar pronto.

## 10. Entregáveis de governança

- Fragmento `.changes/` com `capacidade_nova` (texto é nota pública do changelog).
- `.env.example`: nenhuma env nova prevista (credenciais já existem). Se o intervalo do cron virar knob, entra em `lib/env.ts` + `.env.example`.
- Atualizar `docs/current-state.md` (Nuvemshop deixa de ser só conexão) e marcar no `EPIC-07` o que esta entrega cumpre e o que segue aberto (afirmação de estado — DoD 16).

## 11. Riscos

| Risco | Mitigação |
|---|---|
| Loja enorme (>10k pedidos/mês) | divisão de janela ao meio, recursiva |
| Webhook desativado pela Nuvemshop após 5 falhas | reconciliação 30 min |
| Contato duplicado por telefone em formato inesperado | `normalizePhoneBR` + índice único + re-select no 23505 |
| Volume de banco | projeção do payload (§5.4) |
| Cabeçalhos de rate limit diferentes do esperado | tarefa de verificação contra a API real antes de codificar; fallback 2 s |
| Secret do app trocado depois da conexão invalida HMAC | fora do escopo; documentado na tela de ajuda como "desconecte e conecte" |
