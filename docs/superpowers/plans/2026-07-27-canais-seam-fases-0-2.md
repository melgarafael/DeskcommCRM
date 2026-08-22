# Seam de Canais (Fases 0–2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Abrir o seam de canal no SonghaiCRM — capabilities declarativas, WAHA como primeiro adapter, `provider` no schema e lint anti-vazamento — **sem alterar um único comportamento visível ao usuário**.

**Architecture:** Features param de conhecer providers e passam a perguntar **capacidades** (`lib/channels/capabilities.ts`). O WAHA vira o primeiro `ChannelAdapter`; toda a lógica de negócio (pacing, janela, gates) fica fora dos adapters. A cadeia `before_send` já existente ganha consciência de capability sem mudar de ordem nem de versão de comportamento. Ver a doutrina em `docs/doctrine/restricao-de-canal.md`.

**Tech Stack:** Next.js 16 App Router, TypeScript 6 estrito, Vitest (`npm run test:unit`), Playwright (`npm run test:e2e`), Supabase/Postgres com RLS.

## Global Constraints

- **Zero mudança de comportamento nas Fases 0–2.** Toda saída observável (mensagem enviada, ordem dos gates, veredito, linha no banco) é idêntica antes e depois. Isto é o critério de aceite, não uma meta.
- **Baseline de regressão gravado ANTES da Task 1** e re-conferido ao fim de cada task (ver Task 0).
- Nenhum arquivo fora de `lib/channels/` pode conter as strings `waha`, `WAHA`, `graph.facebook.com` ou `meta_cloud` após a Task 7. Exceções: migrations, `lib/database.types.ts`, testes de canal, e o próprio `lib/waha/` enquanto existir.
- Toda mudança de schema sai como migration versionada em `supabase/migrations/` **+** apêndice idempotente em `supabase/baseline.sql` **+** linha em `supabase/migrations/MANIFEST.md` (doutrina de migrations, `CLAUDE.md`).
- Commits atômicos por task. Nenhuma task começa com a anterior não provada.
- Toda task alimenta `HANDOFF-canais-oficial.md` na raiz — o que mudou, o que provei, o que quebrou.
- `pnpm typecheck` e `pnpm lint` zerados ao fim de cada task. **Nunca validar com `| tail`** (o exit code vira o do `tail` — falso verde). Use `set -o pipefail` + `$?`; **nunca `${PIPESTATUS[0]}`**, que no zsh expande para string vazia.
- **Filtrar teste com `pnpm run test:unit -- <nome>` é FALSO VERDE.** Medido: `pnpm run test:unit -- arquivo-que-nao-existe-xyz` → `1046 passed, exit 0`. O `--` do pnpm faz o vitest ignorar o filtro e rodar a suíte inteira — ou seja, o step "rode e veja falhar" do TDD reportaria PASS com o arquivo inexistente. Use sempre **`pnpm exec vitest run <filtro>`**.

> ✅ **`tests/invariants/` VOLTOU a gatear o CI — corrigido na `main` durante a execução deste plano.**
>
> Histórico, porque a mudança de premissa importa: em `0ea9f4b` (base desta branch) o
> `ci.yml` rodava só `typecheck` + `lint` + `test:unit`, e **nenhum** workflow invocava
> `test:db` — 56 arquivos de invariante, incluindo `rls-isolation.test.ts`, ficavam fora
> do gate de PR. Isso foi medido e reportado. Outra frente consertou em `ce93ab0`
> ("CI prova o isolamento RLS") + `696f083` ("projeto exige Node 22 — a suíte de
> invariantes nunca rodou no 20"), já integrados aqui via merge.
>
> Estado atual: o CI tem **dois jobs obrigatórios** — `verify` (typecheck/lint/test:unit)
> e `invariants` (`pnpm test:db`, que sobe Postgres, aplica o `baseline.sql` em install e
> update, e roda os invariantes).
>
> Consequência para este plano: a **Task 6 pode e deve ficar em `tests/invariants/`** — é
> invariante de banco de verdade e agora gateia PR. As Tasks 1–5, que testam constante e
> função pura, seguem em `tests/unit/` porque não precisam de Postgres e rodam em segundos.
> **Ao fechar a Task 6, rode `pnpm test:db` localmente** — é o único caminho que exercita
> o `baseline.sql` que o self-hoster aplica de verdade.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `lib/channels/capabilities.ts` | **Criar.** Descritor declarativo por provider. Único arquivo que conhece a diferença entre os mundos. |
| `lib/channels/types.ts` | **Criar.** `ChannelAdapter`, `OutboundEnvelope`, `InboundEvent`, `ChannelProvider`. |
| `lib/channels/index.ts` | **Criar.** `getAdapter(provider)` — resolução fail-closed. |
| `lib/channels/adapters/waha.ts` | **Criar.** Implementa `ChannelAdapter` delegando ao `lib/waha/*` existente. Sem regra de negócio. |
| `lib/agent-engine/pacing/engine.ts` | **Modificar.** `decidePacing` passa a receber `banRisk` e desarmar só o que é anti-ban. |
| `app/api/v1/messages/_handler.ts` | **Modificar.** Passa a resolver o adapter em vez de `getWahaClient()` direto. |
| `scripts/lint-channels.ts` | **Criar.** Reprova nome de provider fora de `lib/channels/`. |
| `tests/unit/channel-capability-matrix.test.ts` | **Criar.** Matriz exaustiva capability × provider. **Em `tests/unit/`, não `tests/invariants/`** — ver aviso abaixo. |
| `tests/unit/pacing-cortesia-vs-antiban.test.ts` | **Criar.** O invariante 3 da doutrina. |

---

## Task 0: Baseline de regressão — a foto do "antes"

**Files:**
- Create: `HANDOFF-canais-oficial.md`
- Create: `evidence/canais/baseline/` (screenshots + traces)

**Interfaces:**
- Consumes: nada (é o primeiro).
- Produces: `evidence/canais/baseline/` — a referência contra a qual **toda** task posterior se compara.

> **Por que primeiro:** as Fases 0–2 não criam nenhum botão. Provar "não regrediu" exige a foto do antes. Sem ela, "está igual" é afirmação, não medição.

- [ ] **Step 1: Subir o ambiente fresco estilo VPS**

Receita da doutrina de QA Visual (`CLAUDE.md`). Postgres pg17 com `supabase/baseline.sql`, **não** as migrations:

```bash
cd ~/SonghaiCRM-canais
npm install
npx supabase start                 # config.toml já em major_version = 17
psql "$DATABASE_URL" -f supabase/baseline.sql
npx tsx scripts/bootstrap-owner.ts
npx tsx scripts/seed-e2e-credentials.ts   # gera .e2e-creds.json (gitignored)
```

- [ ] **Step 2: Subir WAHA local e a app em modo produção**

`next dev` não serve — compila lento e o Turbopack quebra `cookies()`.

```bash
docker compose up -d          # WAHA na 3030
npm run build && npm run start &
```

- [ ] **Step 3: Rodar a suíte inteira e gravar o resultado**

Sem `set -o pipefail`, `$?` depois de um pipe é o exit do `tee` — a receita original
registrava `exit=0` com a suíte vermelha, e o falso verde da baseline contaminaria as 7
tasks seguintes. **Não use `${PIPESTATUS[0]}` aqui:** essa variável é do bash, e no zsh
(shell padrão do Mac do time) ela expande para **string vazia** — medido, gravou `exit=`
no `unit.txt`. Com `pipefail`, `$?` é o exit da suíte nos dois shells.

E a e2e roda **em série**: com 5 workers sobre fixtures compartilhadas o log não distingue
flake de defeito (medido na Task 0.1: 15 vermelhos em paralelo, 4 em série).

```bash
set -o pipefail

pnpm run test:unit 2>&1 | tee evidence/canais/baseline/unit.txt
echo "exit=$?" >> evidence/canais/baseline/unit.txt

# E2E_PORT: o config usa reuseExistingServer:false de propósito; se a 3001 estiver
# ocupada por outro worktree a suíte aborta inteira em vez de testar o build errado.
E2E_PORT=3007 pnpm exec playwright test --workers=1 2>&1 | tee evidence/canais/baseline/e2e.txt
echo "exit=$?" >> evidence/canais/baseline/e2e.txt
```

Expected: ambos verdes. **Se algo já está vermelho na `main`, PARE** — conserte ou registre no HANDOFF antes de seguir; senão você não sabe se quebrou depois.

- [ ] **Step 4: Viver a jornada WAHA como usuário e gravar**

Playwright dirigindo o frontend com a conta real de `.e2e-creds.json`. Screenshot em cada parada:

1. login → `evidence/canais/baseline/01-login.png`
2. conectar WhatsApp (QR aparece) → `evidence/canais/baseline/02-qr.png`
3. inbox com conversa → `evidence/canais/baseline/03-inbox.png`
4. enviar texto pelo inbox → `evidence/canais/baseline/04-texto-enviado.png`
5. enviar áudio → `evidence/canais/baseline/05-audio-enviado.png`
6. agendar follow-up → `evidence/canais/baseline/06-followup.png`
7. Radar de Risco carregado → `evidence/canais/baseline/07-radar.png`

- [ ] **Step 5: Gravar o trace da cadeia before_send**

`before_send_traces.trace` é um **array jsonb** de `{gate, verdict, code?, detail?}` — não colunas. E a tabela exige `job_id` de `job_queue`: **só grava em turno de agente de IA**, nunca em envio manual pelo inbox. Portanto a jornada do Step 4 **precisa incluir um turno do agente respondendo** (mandar um inbound e deixar a IA responder), senão este CSV sai vazio e não prova nada.

```bash
psql "$DATABASE_URL" -c "\copy (select e->>'gate' as gate, e->>'verdict' as verdict, coalesce(e->>'code','') as code from before_send_traces t, jsonb_array_elements(t.trace) e order by t.created_at, (e->>'gate')) to 'evidence/canais/baseline/gates.csv' csv header"
wc -l evidence/canais/baseline/gates.csv
```

Expected: **mais que 1 linha** (o header). Se vier só o header, o agente não rodou — volte ao Step 4 e provoque um turno de IA antes de seguir. Um baseline vazio passa em qualquer `diff` e não prova nada.

Este CSV é a prova mais dura do plano: **a sequência de gates avaliados não pode mudar** nas Fases 0–2.

- [ ] **Step 6: Escrever o HANDOFF inicial**

`HANDOFF-canais-oficial.md` com: data, SHA base (`git rev-parse --short HEAD`), o que a baseline cobre, o que ficou de fora e por quê.

- [ ] **Step 7: Commit**

```bash
git add HANDOFF-canais-oficial.md evidence/canais/baseline/
git commit -m "test(canais): baseline de regressão da jornada WAHA antes do seam"
```

---

## Task 1: Cortesia deixa de ser anti-ban

**Files:**
- Modify: `lib/agent-engine/pacing/engine.ts` (`decidePacing`, `PacingInput`)
- Test: `tests/unit/pacing-cortesia-vs-antiban.test.ts`

**Interfaces:**
- Consumes: `PacingKnobs` de `lib/agent-engine/pacing/defaults.ts` (inalterado).
- Produces: `PacingInput` ganha o campo **opcional** `banRisk?: boolean` (default `true`). Task 5 passa `caps.banRisk` aqui.

> **Decisão de desenho:** não separamos `PacingKnobs` em dois tipos. Um flag em `decidePacing` + o teste abaixo entrega o mesmo invariante com 1/5 do diff — e diff menor é menos conflito com as outras sessões ativas no repo. O invariante é o teste, não a forma (ver `docs/doctrine/restricao-de-canal.md`, invariante 3).

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/unit/pacing-cortesia-vs-antiban.test.ts
import { describe, expect, it } from 'vitest';
import { decidePacing } from '@/lib/agent-engine/pacing/engine';
import { PACING_DEFAULTS } from '@/lib/agent-engine/pacing/defaults';

// Assinatura REAL (conferida em lib/agent-engine/pacing/engine.ts:23):
//   PacingInput = { now, knobs, state: PacingState, crmDailyLimit, rng? }
//   PacingState = { lastSentAt, sentToday, numberActivatedAt }   ← ANINHADO
//   PacingDecision = { allow: true, waitMs } | { allow: false, code, nextAllowedAt, reason }
// Repare: o campo é `allow`, não `allowed`. `code` só existe no ramo de veto.

const MADRUGADA = new Date('2026-07-28T06:00:00Z');       // 03h BRT — fora da janela 7h–22h
const COMERCIAL = new Date('2026-07-28T13:00:00Z');       // 10h BRT — terça, dentro da janela

function input(over: { now: Date; banRisk?: boolean; sentToday?: number }) {
  return {
    now: over.now,
    knobs: PACING_DEFAULTS,
    banRisk: over.banRisk,
    state: {
      lastSentAt: null,
      sentToday: over.sentToday ?? 0,
      numberActivatedAt: null,   // idade 0 = degrau mais conservador (cap 20)
    },
    crmDailyLimit: null,
    rng: () => 0,
  };
}

describe('cortesia não é anti-ban', () => {
  it('sem risco de ban, o horário comercial CONTINUA armado', () => {
    const d = decidePacing(input({ now: MADRUGADA, banRisk: false }));
    expect(d.allow).toBe(false);
    if (d.allow) throw new Error('inalcançável');   // estreita o tipo p/ ler .code
    expect(d.code).toBe('outside_window');
  });

  it('sem risco de ban, o cap de warm-up DESARMA', () => {
    const d = decidePacing(input({ now: COMERCIAL, banRisk: false, sentToday: 999 }));
    expect(d.allow).toBe(true);
  });

  it('COM risco de ban, o cap de warm-up continua vetando (comportamento atual)', () => {
    const d = decidePacing(input({ now: COMERCIAL, banRisk: true, sentToday: 999 }));
    expect(d.allow).toBe(false);
    if (d.allow) throw new Error('inalcançável');
    expect(d.code).toBe('warmup_cap');
  });

  it('omitir banRisk preserva o comportamento atual (default = true)', () => {
    const d = decidePacing(input({ now: COMERCIAL, sentToday: 999 }));
    expect(d.allow).toBe(false);   // nenhum chamador existente muda de resultado
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
pnpm exec vitest run pacing-cortesia-vs-antiban
```

Expected: **FAIL, e especificamente no 2º caso** (`o cap de warm-up DESARMA`) — hoje o cap veta mesmo sem risco de ban. Os casos 1, 3 e 4 devem passar já de cara, porque descrevem o comportamento atual.

Se o 2º caso **passar** de primeira, o teste não está provando nada: `banRisk` está sendo ignorado silenciosamente (campo extra num objeto não gera erro em runtime). Verifique que `PacingInput` realmente ganhou o campo antes de seguir — um teste que nunca ficou vermelho não é prova.

- [ ] **Step 3: Implementar o mínimo**

Em `lib/agent-engine/pacing/engine.ts`, adicionar `banRisk?: boolean` a `PacingInput` e, dentro de `decidePacing`, curto-circuitar **só** as regras anti-ban:

```ts
const banRisk = input.banRisk ?? true;   // default preserva o comportamento atual
// ... a checagem de janela/domingo roda SEMPRE, antes disto ...
if (banRisk) {
  // throttle, jitter, warm-up cap, cap diário do CRM — bloco inalterado
}
```

Ordem importa: a checagem de janela **não pode** ficar dentro do `if`.

- [ ] **Step 4: Rodar e confirmar que passa**

```bash
pnpm exec vitest run pacing-cortesia-vs-antiban   # 3 passed
npm run test:unit                                  # suíte inteira, sem regressão
npm run typecheck && npm run lint
```

- [ ] **Step 5: Provar na tela que nada mudou**

Re-rodar a jornada da Task 0 (passos 4 e 5). Comparar `gates.csv` novo com a baseline: **devem ser idênticos** (`diff`). Screenshots visualmente iguais.

- [ ] **Step 6: HANDOFF + commit**

```bash
git add lib/agent-engine/pacing/engine.ts tests/unit/pacing-cortesia-vs-antiban.test.ts HANDOFF-canais-oficial.md
git commit -m "fix(canais): horário comercial deixa de ser desarmado junto com o anti-ban"
```

---

## Task 2: O descritor de capabilities

**Files:**
- Create: `lib/channels/types.ts`
- Create: `lib/channels/capabilities.ts`
- Test: `tests/invariants/channel-capability-matrix.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `ChannelProvider = 'waha' | 'meta_cloud'`; `ChannelCapabilities`; `CHANNEL_CAPABILITIES: Record<ChannelProvider, ChannelCapabilities>`; `capabilitiesOf(provider): ChannelCapabilities` (lança em provider desconhecido — fail-closed).

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/invariants/channel-capability-matrix.test.ts
import { describe, expect, it } from 'vitest';
import { CHANNEL_CAPABILITIES, capabilitiesOf, type ChannelProvider } from '@/lib/channels/capabilities';

const PROVIDERS: ChannelProvider[] = ['waha', 'meta_cloud'];
const CAPABILITIES = [
  'freeformOutsideWindow', 'requiresTemplates', 'banRisk',
  'minIntervalMs', 'voiceNote', 'groups', 'costPerMessage',
] as const;

describe('matriz capability × provider é exaustiva', () => {
  it('todo provider declara TODA capability', () => {
    for (const p of PROVIDERS) {
      for (const c of CAPABILITIES) {
        expect(CHANNEL_CAPABILITIES[p], `${p} não declara ${c}`).toHaveProperty(c);
      }
    }
  });

  it('nenhuma capability é declarada sem estar na lista (código morto)', () => {
    for (const p of PROVIDERS) {
      for (const key of Object.keys(CHANNEL_CAPABILITIES[p])) {
        expect(CAPABILITIES as readonly string[]).toContain(key);
      }
    }
  });

  it('resolução é fail-closed — provider desconhecido lança', () => {
    expect(() => capabilitiesOf('telegram' as ChannelProvider)).toThrow(/unknown_channel_provider/);
  });

  it('as duas famílias de restrição são mutuamente exclusivas por provider', () => {
    // auto-restrição (banRisk) e hetero-restrição (requiresTemplates) nunca coexistem:
    // é o que a doutrina restricao-de-canal.md afirma sobre a física dos canais.
    for (const p of PROVIDERS) {
      const c = CHANNEL_CAPABILITIES[p];
      expect(c.banRisk && c.requiresTemplates, `${p} declara as duas famílias`).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
pnpm exec vitest run channel-capability-matrix
```

Expected: FAIL com "Cannot find module '@/lib/channels/capabilities'".

- [ ] **Step 3: Implementar**

```ts
// lib/channels/types.ts
export type ChannelProvider = 'waha' | 'meta_cloud';

export interface ChannelCapabilities {
  /** Pode enviar texto livre a qualquer momento? false = exige template fora da janela. */
  freeformOutsideWindow: boolean;
  /** A plataforma hospeda definições de mensagem que precisam de aprovação prévia. */
  requiresTemplates: boolean;
  /** Há risco de banimento por volume/padrão → arma throttle, warm-up e cap. */
  banRisk: boolean;
  /** Intervalo mínimo imposto PELA PLATAFORMA entre msgs ao mesmo destinatário (ms). */
  minIntervalMs: number | null;
  /** 'server-convert' = o canal converte áudio; 'opus-only' = precisamos entregar ogg/opus. */
  voiceNote: 'server-convert' | 'opus-only';
  groups: 'full' | 'limited' | 'none';
  /** Mensagem entregue gera custo → decisões de envio precisam considerar orçamento. */
  costPerMessage: boolean;
}
```

```ts
// lib/channels/capabilities.ts
import type { ChannelCapabilities, ChannelProvider } from './types';
export type { ChannelProvider, ChannelCapabilities };

export const CHANNEL_CAPABILITIES: Record<ChannelProvider, ChannelCapabilities> = {
  // Auto-restrição: falo quando quiser, mas o WhatsApp me bane se eu abusar.
  waha: {
    freeformOutsideWindow: true,
    requiresTemplates: false,
    banRisk: true,
    minIntervalMs: null,
    voiceNote: 'server-convert',
    groups: 'full',
    costPerMessage: false,
  },
  // Hetero-restrição: não me banem, mas a Meta me proíbe e me cobra.
  meta_cloud: {
    freeformOutsideWindow: false,
    requiresTemplates: true,
    banRisk: false,
    minIntervalMs: 6000,
    voiceNote: 'opus-only',
    groups: 'limited',
    costPerMessage: true,
  },
};

export function capabilitiesOf(provider: ChannelProvider): ChannelCapabilities {
  const caps = CHANNEL_CAPABILITIES[provider];
  if (!caps) throw new Error(`unknown_channel_provider: ${provider}`);
  return caps;
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

```bash
pnpm exec vitest run channel-capability-matrix   # 4 passed
npm run typecheck && npm run lint
```

- [ ] **Step 5: HANDOFF + commit**

```bash
git add lib/channels/ tests/invariants/channel-capability-matrix.test.ts HANDOFF-canais-oficial.md
git commit -m "feat(canais): descritor de capabilities por provider, fail-closed"
```

---

## Task 3: `ChannelAdapter` e o WAHA como primeira implementação

**Files:**
- Create: `lib/channels/adapters/waha.ts`
- Create: `lib/channels/index.ts`
- Modify: `lib/channels/types.ts` (acrescenta as interfaces de transporte)
- Test: `tests/unit/channel-adapter-waha.test.ts`

**Interfaces:**
- Consumes: `ChannelProvider` (Task 2); `getWahaClient`, `wahaSendPlanFor`, `resolveWahaChatId`, `parseWahaMessageId` de `lib/waha/*`.
- Produces:
  - `OutboundEnvelope = { sessionRef: string; to: string; kind: 'text'|'image'|'video'|'audio'|'file'; body?: string; media?: OutboundMedia }` — `OutboundMedia` é reusado de `lib/waha/media-send.ts`, não redefinido.
  - `RecipientInput = { isGroup: boolean; groupChatId: string | null; phoneNumber: string | null | undefined; waIdentity: string | null | undefined }` — espelha `ResolveWahaChatIdInput` (`lib/waha/send.ts:20`) para que o adapter possa repassar sem adaptar. Defina-o em `types.ts`; **não** o importe de `lib/waha/` (o seam não pode depender do provider).
  - `ChannelAdapter = { provider; send(env): Promise<{ externalId: string | null }>; resolveRecipient(input): string | null }`
  - **`InboundEvent` NÃO entra nesta task.** Ele só ganha consumidor na Fase 3b (parse de webhook da Meta); criá-lo agora é tipo especulativo. A tabela "Estrutura de arquivos" o menciona como destino final de `types.ts`, não como escopo da Task 3.
  - `getAdapter(provider: ChannelProvider): ChannelAdapter` — lança em provider desconhecido.

> O adapter é **burro de propósito**. Se você sentir vontade de escrever um `if` sobre janela de 24h ou cap diário aqui dentro, o desenho vazou — essa regra pertence à cadeia `before_send`.

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/unit/channel-adapter-waha.test.ts
import { describe, expect, it } from 'vitest';
import { getAdapter } from '@/lib/channels';

describe('adapter WAHA', () => {
  it('resolve destinatário 1:1 por telefone', () => {
    const a = getAdapter('waha');
    expect(a.resolveRecipient({
      isGroup: false, groupChatId: null, phoneNumber: '+5531999998888', waIdentity: null,
    })).toBe('5531999998888@c.us');
  });

  it('resolve destinatário por lid quando não há telefone', () => {
    const a = getAdapter('waha');
    expect(a.resolveRecipient({
      isGroup: false, groupChatId: null, phoneNumber: null, waIdentity: 'lid:12345',
    })).toBe('12345@lid');
  });

  it('resolução de adapter é fail-closed', () => {
    // @ts-expect-error provider inexistente é erro de tipo E de runtime
    expect(() => getAdapter('telegram')).toThrow(/unknown_channel_provider/);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
pnpm exec vitest run channel-adapter-waha
```

Expected: FAIL com "Cannot find module '@/lib/channels'".

- [ ] **Step 3: Implementar**

`lib/channels/adapters/waha.ts` delega tudo — **não reescreva a lógica**, reuse `lib/waha/*`:

```ts
import { getWahaClient } from '@/lib/waha/client';
import { wahaSendPlanFor } from '@/lib/waha/media-send';
import { parseWahaMessageId } from '@/lib/waha/message-id';
import { resolveWahaChatId } from '@/lib/waha/send';
import type { ChannelAdapter, OutboundEnvelope, RecipientInput } from '../types';

export const wahaAdapter: ChannelAdapter = {
  provider: 'waha',
  resolveRecipient: (input: RecipientInput) => resolveWahaChatId(input),
  async send(env: OutboundEnvelope) {
    const client = getWahaClient();
    if (!client) return { externalId: null };   // não configurado = noop, não erro
    const res = env.media
      ? await client.sendMedia(env.sessionRef, env.to, wahaSendPlanFor(env.kind, env.media))
      : await client.sendMessage(env.sessionRef, env.to, env.body ?? '');
    return { externalId: parseWahaMessageId(res) };
  },
};
```

```ts
// lib/channels/index.ts
import { wahaAdapter } from './adapters/waha';
import type { ChannelAdapter, ChannelProvider } from './types';

const ADAPTERS: Record<ChannelProvider, ChannelAdapter | null> = {
  waha: wahaAdapter,
  meta_cloud: null,   // Fase 3b
};

export function getAdapter(provider: ChannelProvider): ChannelAdapter {
  const a = ADAPTERS[provider];
  if (!a) throw new Error(`unknown_channel_provider: ${provider}`);
  return a;
}
export type { ChannelAdapter, ChannelProvider } from './types';
```

- [ ] **Step 4: Rodar e confirmar que passa**

```bash
pnpm exec vitest run channel-adapter-waha    # 3 passed
npm run test:unit && npm run typecheck && npm run lint
```

- [ ] **Step 5: HANDOFF + commit**

```bash
git add lib/channels/ tests/unit/channel-adapter-waha.test.ts HANDOFF-canais-oficial.md
git commit -m "feat(canais): ChannelAdapter com WAHA como primeira implementação"
```

---

## Task 4: O handler de envio passa a usar o adapter

**Files:**
- Modify: `app/api/v1/messages/_handler.ts:219-305`
- Test: reusa `tests/invariants/automation-send-whatsapp.test.ts` (não deve mudar de resultado)

**Interfaces:**
- Consumes: `getAdapter` (Task 3), `capabilitiesOf` (Task 2).
- Produces: `ChannelAdapter` ganha `isConfigured(): boolean` e `codes: { notConfigured: string; sendFailed: string }` (ver "Correção de contrato" abaixo). Fora isso, nada novo. **Esta task é invisível de fora — esse é o ponto.**

### Correção de contrato (achada na Task 3, obrigatória antes de codar)

`send()` devolvendo `{ externalId: null }` **colapsa dois desfechos que o handler trata de forma diferente**:

| Situação | Comportamento atual (`_handler.ts`) |
|---|---|
| `getWahaClient()` devolve `null` | mensagem fica **`queued`** + `metadata.queued_reason = 'waha_not_configured'`. **Nada é enviado.** |
| Enviou, mas `parseWahaMessageId` não achou id | `status: 'sent'`, `external_id: null`, `ack: 0` |

Com o contrato original, a primeira viraria `sent` sem ter saído. Isso é perda de mensagem, não refactor.

**A correção:** o adapter expõe o estado *antes* do envio, espelhando o `if (!waha)` de hoje um-para-um — e **carrega seus próprios códigos de erro**:

```ts
// lib/channels/types.ts — acrescentar a ChannelAdapter
isConfigured(): boolean;
/**
 * Códigos que o handler grava em metadata/status. Vivem NO ADAPTER porque
 * carregam nome de provider ('waha_not_configured'), e o lint da Task 7
 * proíbe esse nome fora de lib/channels/. O handler escreve o que o adapter
 * disser — comportamento byte-idêntico, zero vazamento.
 */
readonly codes: { notConfigured: string; sendFailed: string };
```

```ts
// lib/channels/adapters/waha.ts
isConfigured: () => getWahaClient() !== null,
codes: { notConfigured: 'waha_not_configured', sendFailed: 'waha_error' },
```

Repare que isto **não é um estado novo**: é o mesmo pre-check que o handler já faz, movido para trás do seam. E resolve de antemão o conflito que a Task 7 teria com os literais `waha_not_configured` / `waha_error` em `_handler.ts`.

Escreva o teste do `isConfigured` (com `vi.stubEnv` nos dois estados) **antes** de tocar no handler.

> Esta é a task de maior risco do plano: é o caminho de produção de todo envio. O critério não é "os testes passam", é "o `gates.csv` e as telas batem com a baseline".

> ⚠️ **Esta task foi decomposta em 5 sub-tasks (4a–4e), uma substituição por vez.**
>
> Motivo, medido: o **único** teste que exercita `sendMessageHandler` é
> `tests/invariants/automation-send-whatsapp.test.ts`, que (a) está numa pasta excluída
> do CI e (b) importa `sql`/`seedGov` de `./gov-helpers`, ou seja **exige Postgres real**.
> O caminho de envio central do produto não tem hoje nenhuma rede que gateie um PR.
>
> Refatorar caminho crítico sem rede é apostar. A rede vem **primeiro** (4a), e só então
> cada chamada é trocada isoladamente — para que, se algo quebrar, o culpado seja
> um `git diff` de 5 linhas e não de 50.

### Os 6 desfechos do handler (enumerados do código, `_handler.ts:219-318`)

A **ordem** entre eles é parte do comportamento: sem WAHA configurado e sem telefone, o
resultado é `waha_not_configured`, **não** `missing_phone_number`.

| # | Condição | Resultado no banco |
|---|---|---|
| 1 | `getWahaClient()` → null | `status` continua `queued`; `metadata.queued_reason = 'waha_not_configured'` |
| 2 | sem `chatId` resolvível | `status: 'failed'`, `error_code: 'missing_phone_number'` |
| 3 | sessão ausente ou `status !== 'WORKING'` | `queued`; `metadata.queued_reason = 'channel_session_not_working'` |
| 4 | tem `media_storage_path` → `sendMedia` | `status: 'sent'`, `external_id`, `ack: 0` |
| 5 | sem mídia → `sendMessage` | `status: 'sent'`, `external_id`, `ack: 0` |
| 6 | envio lança | `status: 'failed'`, `error_code: 'waha_error'` \| `'storage_sign_failed'` |

---

- [ ] **Task 4a — a rede de segurança (nenhuma linha de produção muda)**

Criar `tests/unit/messages-handler-desfechos.test.ts` com **um caso por desfecho acima**, escritos contra o código **atual**, com um fake de `SupabaseClient` próprio e enxuto.

Não reuse o fake de `automation-send-whatsapp.test.ts`: ele arrasta `gov-helpers` e Postgres real. Duplicar scaffolding de teste é o preço certo por um teste que roda no CI em 2 segundos.

Asserte o **estado final da linha** (`status`, `error_code`, `metadata.queued_reason`, `external_id`, `ack`) — não a sequência de chamadas internas. Teste que asserta chamadas trava o refactor que ele deveria proteger.

```bash
pnpm exec vitest run messages-handler-desfechos
```

Expected: **6 passed** contra o código atual, sem tocar em `_handler.ts`.
Depois, **sabote cada desfecho** (troque um `error_code`, inverta a ordem dos `if`) e confirme que o caso certo vermelhece. Rede que não pega nada não é rede.

Commit: `test(canais): fixa os 6 desfechos do handler de envio antes do refactor`

- [ ] **Task 4b — trocar SÓ `resolveWahaChatId`**

Uma substituição: `resolveWahaChatId({...})` → `adapter.resolveRecipient({...})`.
Nada mais. `getWahaClient()`, `sendMedia`, `sendMessage`, `parseWahaMessageId` ficam intocados.

```bash
pnpm exec vitest run messages-handler-desfechos   # 6 passed
pnpm run test:unit && pnpm run typecheck && pnpm run lint
```

Commit próprio.

- [ ] **Task 4c — trocar SÓ o pre-check de configuração**

`const waha = getWahaClient(); if (!waha)` → `if (!adapter.isConfigured())`, e o literal
`"waha_not_configured"` → `adapter.codes.notConfigured`.

**Atenção ao desfecho 4/5:** o corpo do `else` ainda usa a variável `waha`. Mantenha o
`getWahaClient()` vivo por enquanto (é a Task 4d que o remove) ou o TypeScript acusa —
e resista a "aproveitar e já trocar", que é como micro-passo vira macro-passo.

```bash
pnpm exec vitest run messages-handler-desfechos   # 6 passed
pnpm run test:unit && pnpm run typecheck && pnpm run lint
```

Commit próprio.

- [ ] **Task 4d — trocar o envio propriamente dito**

`waha.sendMedia(...)` / `waha.sendMessage(...)` + `parseWahaMessageId(...)` → `adapter.send({...})`, e `"waha_error"` → `adapter.codes.sendFailed`. Aqui `getWahaClient()` sai do handler.

`storage_sign_failed` **continua literal no handler** — é falha de Storage nossa, não do canal, e a URL assinada é montada antes de qualquer coisa tocar o adapter.

> **Alerta da Task 4a que NÃO procede — não "conserte" isto.** A 4a observou que
> `WahaClient.sendMedia` inclui o corpo da resposta na mensagem de erro (`waha_500: boom`)
> e `sendMessage` não (`waha_500`), e concluiu que a 4d teria de escolher uma das duas.
> **Não tem.** Conferido em `lib/channels/adapters/waha.ts`: o `send` do adapter **preserva
> o branch** — chama `client.sendMedia` ou `client.sendMessage` exatamente como o handler
> faz hoje. O erro sobe do mesmo método, com a mesma mensagem. A assimetria atravessa o
> seam intacta, que é o desejado nas Fases 0–2. Uniformizar seria a mudança de
> comportamento que este plano proíbe.

```bash
pnpm exec vitest run messages-handler-desfechos   # 6 passed
pnpm run test:unit && pnpm run typecheck && pnpm run lint
```

Commit próprio.

- [ ] **Task 4e — a prova no mundo real**

Só agora a jornada. Antes disto, nada saiu de `vitest`.

```bash
CANAIS_EVIDENCE_DIR=evidence/canais/task4 pnpm exec playwright test --config tests/journeys/playwright.config.ts
# regravar gates.csv com o filtro do turno da vez (ver README de evidence/canais)
diff evidence/canais/baseline/gates.csv evidence/canais/task4/gates.csv
```

Expected: **`diff` vazio** e a jornada verde. Qualquer linha diferente = regressão: pare, ache a causa raiz e **não commite por cima**.

Confira também, no banco, que uma mensagem enviada pela tela chegou com `status='sent'` e `external_id` não-nulo — o `gates.csv` não cobre o caminho manual do inbox.

Commit final: `refactor(canais): handler de envio fala com ChannelAdapter, não com WAHA`

---

## Task 5: Capability desarma o pacing (liga Task 1 na Task 2)

**Files:**
- Modify: `lib/agent-engine/guardrails/before-send.ts` (gate `pacing`)
- Test: `tests/unit/gate-pacing-capability.test.ts`

**Interfaces:**
- Consumes: `capabilitiesOf` (Task 2), `banRisk` em `decidePacing` (Task 1).
- Produces: veredito de gate ganha `skipped: 'not_applicable'` como terceiro estado, ao lado de `pass` e veto; `GateContext` ganha `provider: ChannelProvider`.

### Três premissas do plano original que estavam ERRADAS (conferidas no código)

1. **`pacingGate` não é exportado.** `before-send.ts:304` é `const pacingGate: Gate = {`, sem `export` — diferente de `lgpdGate`, `promiseGate` e os outros, que são exportados. Você precisa **exportá-lo** para testá-lo direto (é o que os irmãos já fazem, então não é exceção de estilo), ou testar através de `BEFORE_SEND_GATES`. Prefira exportar: teste de gate isolado é o padrão do repo (`tests/invariants/case-guardrail.test.ts`).

2. **`GateContext` não tem `provider`.** Confira o shape real em `before-send.ts:62-...`: tem `now`, `body`, `optedOut`, `pacing`, `spinning`, `promise`, `semanticPromise`, `disclosure`. Você precisa **acrescentar** `provider: ChannelProvider`.

3. **O construtor de produção do ctx fica no mesmo arquivo, por volta de `before-send.ts:507`** (`spinning: { knobs: spinningKnobs, window }`). É lá que `provider` precisa ser preenchido — e, como a coluna `channel_sessions.provider` só chega na **Task 6**, fixe `'waha'` com comentário, exatamente como a Task 4b fez em `_handler.ts:220`. A Task 6 troca o literal pelo valor do banco.

**Consequência importante:** em produção o provider continua `'waha'`, logo `banRisk` continua `true` e **nada muda de comportamento** — o `gates.csv` tem que sair idêntico à baseline de novo. O ramo `banRisk: false` é exercitado só pelos testes desta task, injetando `provider: 'meta_cloud'` no ctx. Isso é esperado e é o desenho: o canal que o desarma de verdade nasce na Fase 3b.

- [ ] **Step 1: Escrever o teste que falha**

O repo **não tem fixture compartilhada** de `GateContext` — cada teste de gate monta a sua (ver `tests/invariants/case-guardrail.test.ts:32`). Siga o mesmo padrão:

```ts
// tests/unit/gate-pacing-capability.test.ts
import { describe, expect, it } from 'vitest';
import { pacingGate, type GateContext } from '@/lib/agent-engine/guardrails/before-send';
import { PACING_DEFAULTS } from '@/lib/agent-engine/pacing/defaults';
import { SPINNING_DEFAULTS } from '@/lib/agent-engine/spinning/defaults';

// Espelha o baseCtx de tests/invariants/case-guardrail.test.ts:32 — copie de lá os
// campos obrigatórios do GateContext vigente e sobrescreva só o que o caso exige.
function baseCtx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    body: 'oi',
    provider: 'waha',
    pacing: { knobs: PACING_DEFAULTS, sentToday: 0, lastSentAt: null, numberActivatedAt: null },
    spinning: { knobs: SPINNING_DEFAULTS, window: [] },
    lgpd: null,
    promise: { table: null },
    ...overrides,
  } as GateContext;
}

describe('gate de pacing respeita a capability do canal', () => {
  it('em canal SEM risco de ban, o gate registra skipped — não pass silencioso', () => {
    const v = pacingGate.evaluate(baseCtx({ provider: 'meta_cloud' }));
    expect(v.pass).toBe(true);
    expect(v.skipped).toBe('not_applicable');   // a doutrina exige o registro
  });

  it('em canal COM risco de ban, o gate avalia normalmente', () => {
    const v = pacingGate.evaluate(baseCtx({ provider: 'waha' }));
    expect(v.skipped).toBeUndefined();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
pnpm exec vitest run gate-pacing-capability
```

Expected: FAIL — `skipped` ainda não existe no tipo do veredito.

- [ ] **Step 3: Implementar**

Adicionar `skipped?: 'not_applicable'` ao tipo de veredito, e no `pacingGate`:

```ts
const caps = capabilitiesOf(ctx.provider);
if (!caps.banRisk) return { pass: true, skipped: 'not_applicable' };
```

Propagar `skipped` até a escrita em `before_send_traces` — um gate que não se aplica **aparece no trace**, não some dele (invariante 4 da doutrina).

- [ ] **Step 4: Rodar e confirmar que passa**

```bash
pnpm exec vitest run gate-pacing-capability   # 2 passed
npm run test:unit && npm run typecheck && npm run lint
```

- [ ] **Step 5: Provar que o WAHA não mudou**

Rejogar a jornada; `diff` do `gates.csv` contra a baseline. Como nenhuma sessão é `meta_cloud` ainda, o CSV tem que ser **idêntico**.

- [ ] **Step 6: HANDOFF + commit**

```bash
git add lib/agent-engine/guardrails/before-send.ts tests/unit/gate-pacing-capability.test.ts HANDOFF-canais-oficial.md
git commit -m "feat(canais): pacing desarma por capability e registra skipped no trace"
```

---

## Task 6: `provider` no schema

**Files:**
- Create: `supabase/migrations/<timestamp>_00NN_channel_provider.sql`
- Modify: `supabase/baseline.sql` (apêndice idempotente no fim)
- Modify: `supabase/migrations/MANIFEST.md`
- Modify: `lib/database.types.ts` (regenerar)
- Test: `tests/invariants/channel-provider-schema.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `channel_sessions.provider` (`'waha' | 'meta_cloud'`, default `'waha'`), `meta_phone_number_id`, `meta_waba_id`, `meta_token_encrypted`.

- [ ] **Step 1: Descobrir o próximo número sequencial**

```bash
ls supabase/migrations/ | tail -3
```

- [ ] **Step 2: Escrever a migration**

```sql
alter table public.channel_sessions
  add column if not exists provider text not null default 'waha',
  add column if not exists meta_phone_number_id text,
  add column if not exists meta_waba_id text,
  add column if not exists meta_token_encrypted bytea;

alter table public.channel_sessions alter column waha_session_name drop not null;

do $$ begin
  alter table public.channel_sessions add constraint channel_sessions_provider_check
    check (provider in ('waha','meta_cloud'));
exception when duplicate_object then null; end $$;

-- tagged union: cada provider exige o SEU identificador
do $$ begin
  alter table public.channel_sessions add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha'       and waha_session_name    is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null)
  );
exception when duplicate_object then null; end $$;

-- um número vive em UM provider: migrar p/ Cloud API desconecta do app.
create unique index if not exists channel_sessions_org_phone_uniq
  on public.channel_sessions (organization_id, phone_number)
  where phone_number is not null;
```

- [ ] **Step 3: Escrever o teste de invariante**

```ts
// tests/invariants/channel-provider-schema.test.ts — roda via npm run test:db
it('sessão meta_cloud sem phone_number_id é rejeitada pelo banco', async () => {
  await expect(insertSession({ provider: 'meta_cloud', meta_phone_number_id: null }))
    .rejects.toThrow(/channel_sessions_provider_ref_check/);
});

it('duas sessões com o mesmo telefone na mesma org são rejeitadas', async () => {
  await insertSession({ provider: 'waha', phone_number: '+5531999998888' });
  await expect(insertSession({ provider: 'meta_cloud', phone_number: '+5531999998888' }))
    .rejects.toThrow(/channel_sessions_org_phone_uniq/);
});
```

- [ ] **Step 4: Aplicar e provar que sessões existentes sobreviveram**

```bash
psql "$DATABASE_URL" -c "select count(*) from channel_sessions"          # ANTES
npx supabase db push
psql "$DATABASE_URL" -c "select provider, count(*) from channel_sessions group by 1"  # DEPOIS
npm run test:db
```

Expected: toda linha pré-existente com `provider='waha'`; contagem total **inalterada**.

- [ ] **Step 5: Espelhar no baseline e provar num Postgres descartável**

Acrescentar o mesmo SQL ao apêndice do `supabase/baseline.sql` com o rótulo `-- ---- channel provider (migration 00NN) ----`, e validar os dois caminhos do kit self-host:

```bash
docker run -d --name pgtest -e POSTGRES_PASSWORD=x -p 55432:5432 pgvector/pgvector:pg17
psql "postgres://postgres:x@localhost:55432/postgres" -v ON_ERROR_STOP=1 -f supabase/baseline.sql  # install
psql "postgres://postgres:x@localhost:55432/postgres" -f supabase/baseline.sql                     # update (re-aplica)
```

Expected: ambos sem erro. **Este passo não é opcional** — migration que não chega ao baseline não chega aos self-hosters.

- [ ] **Step 6: MANIFEST + regenerar tipos + commit**

```bash
npm run typecheck && npm run lint
git add supabase/ lib/database.types.ts tests/invariants/channel-provider-schema.test.ts HANDOFF-canais-oficial.md
git commit -m "feat(canais): provider em channel_sessions + tagged union e unicidade de número"
```

---

## Task 7: O lint que impede o vazamento

**Files:**
- Create: `scripts/lint-channels.ts`
- Modify: `package.json` (script `lint:channels`, e incluir em `gov:verify`)

**Interfaces:**
- Consumes: nada.
- Produces: `npm run lint:channels` — exit 1 se um nome de provider aparecer fora de `lib/channels/`.

> É este lint que garante o invariante 1 da doutrina **daqui para frente**, sem depender de ninguém lembrar. O repo ainda não tem nenhum lint desse tipo — o `scripts/lint-pacing.ts` citado no comentário de `lib/agent-engine/pacing/defaults.ts` **não existe aqui** (ficou no repo do harness). Este é o primeiro.

- [ ] **Step 1: Escrever o lint**

`.nvmrc` fixa node 20, onde `fs.globSync` não existe — por isso a varredura é um walk recursivo de 8 linhas em vez de glob. Sem dependência nova.

```ts
// scripts/lint-channels.ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN = /\b(waha|WAHA|meta_cloud|graph\.facebook\.com)\b/;
const ROOTS = ['app', 'lib', 'components', 'workers'];
const ALLOWED = [
  /^lib\/channels\//, /^lib\/waha\//,          // lib/waha some quando a Fase 3 absorver
  /^lib\/database\.types\.ts$/,
];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

const offenders = ROOTS.flatMap(walk)
  .filter((f) => !ALLOWED.some((re) => re.test(f)))
  .filter((f) => FORBIDDEN.test(readFileSync(f, 'utf8')));

if (offenders.length) {
  console.error('Nome de provider fora de lib/channels/ (doutrina restricao-de-canal, invariante 1):');
  for (const f of offenders) console.error(`  ${f}`);
  process.exit(1);
}
console.log('lint-channels: ok');
```

- [ ] **Step 2: Rodar e ver a lista real de infratores**

```bash
npx tsx scripts/lint-channels.ts
```

Expected: FALHA, listando os arquivos que ainda vazam (esperados: `lib/ai/runtime/agent.ts`, `app/api/v1/channel-sessions/*`, `app/onboarding/connect-whatsapp/page.tsx`, `lib/agent-engine/edge/crm/session-reconciler.ts`). **Anote a lista no HANDOFF** — ela é o escopo exato do próximo passo.

- [ ] **Step 3: Limpar cada infrator**

Um por vez, rodando o lint entre cada um. Trocar import direto de `lib/waha/*` por `getAdapter()` / `capabilitiesOf()`. Onde for texto de UI ("conectar WhatsApp"), trocar por cópia neutra de canal.

- [ ] **Step 4: Verde e ligado ao CI**

```bash
npx tsx scripts/lint-channels.ts            # ok
npm run test:unit && npm run typecheck && npm run lint
```

Acrescentar a `package.json`: `"lint:channels": "tsx scripts/lint-channels.ts"` e incluir em `gov:verify`.

- [ ] **Step 5: A prova final da Fase — jornada completa + diff contra a baseline**

Repetir Task 0 passos 3–5 inteiros. Critério de aceite da Fase 0–2:
- `unit.txt` e `e2e.txt`: mesmos testes verdes (mais os novos)
- `gates.csv`: **idêntico** à baseline
- screenshots: visualmente iguais

- [ ] **Step 6: HANDOFF de fechamento + commit**

```bash
git add scripts/lint-channels.ts package.json evidence/canais/fase2/ HANDOFF-canais-oficial.md
git commit -m "feat(canais): lint reprova nome de provider fora de lib/channels"
```

---

## Living System Checklist — Seam de Canais (Fases 0–2)

```
[ ] Quem me alimenta?  channel_sessions.provider (banco) → capabilitiesOf()
[ ] Quem eu alimento?  before_send (gate pacing), _handler (envio), Console de knobs
[ ] Que atividade/log eu emito?  before_send_traces com skipped:'not_applicable'
[ ] Onde eu apareço na tela?  N/A NESTA FASE — justificado: refactor sem superfície nova.
    A superfície (seletor de canal, tela de templates) é entregável obrigatório da Fase 3a,
    e o invariante 6 do sistema vivo é cobrado LÁ. Nenhuma configuração nova nasce aqui.
[ ] Qual meu mecanismo anti-morte?  lint-channels no gov:verify — o seam não se degrada sozinho
[ ] Qual a continuidade IA↔humano?  N/A nesta fase (nenhum handoff novo)
[ ] Atualizei o mapa vivo?  docs/architecture/*.json ganha o nó "channels" com arestas
    → before_send e → messages/_handler (Task 7, antes do commit final)
```

---

## Fases seguintes (planos próprios)

Cada uma vira seu próprio arquivo em `docs/superpowers/plans/`, escrito **depois** que a anterior estiver verde e vivida:

- **Fase 3a** — `deriveTemplateContract` + sync por webhook + tela de templates. *Bloqueia a 3b: o contrato tem que existir antes do sender.*
- **Fase 3b** — adapter Meta Cloud (send + webhook + mídia), credenciais BYO coladas à mão. **Requer recurso externo:** App Meta + número de teste + URL pública de webhook.
- **Fase 4** — gate `messaging-window`, fallback de template no follow-up, proposta de template pelo agente.
- **Fase 5 — credencial por sessão, com tela** (NÃO Embedded Signup; ver `docs/doctrine/restricao-de-canal.md`, seção "Embedded Signup não cabe em self-host").
