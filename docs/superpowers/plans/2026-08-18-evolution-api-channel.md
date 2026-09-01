# Evolution API como quarto canal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar Evolution API (WhatsApp não-oficial, self-hosted, open source) como um
quarto `ChannelProvider` no SonghaiCRM, ao lado de WAHA/Meta Cloud/Zernio, apontando para
uma instância já em produção do dono do produto (URL + API key, sem provisionar container
novo neste repo).

**Architecture:** Segue o seam existente em `lib/channels/` — um `ChannelAdapter` novo em
`lib/channels/adapters/evolution.ts` delega para `lib/evolution/*` (transporte puro, mirror
de `lib/waha/*`). A ingestão de webhook reusa a rota genérica já provider-agnostic
(`app/api/v1/webhooks/channel/[token]/route.ts` → `lib/channels/inbound.ts`), no mesmo
padrão que o Zernio usa hoje — **não** nasce uma quarta família de rotas com o nome do
provider na URL. Reusa as RPCs de banco já compartilhadas entre canais
(`fn_upsert_wa_contact`, `fn_upsert_wa_conversation`, `fn_mark_conversation_message`).

**Tech Stack:** Next.js 16 Route Handlers, TypeScript estrito, Supabase (Postgres + RLS),
Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-18-evolution-api-channel-design.md`

## Global Constraints

- Nenhum arquivo fora de `lib/channels/` ou `lib/evolution/` pode conter a string
  `"evolution"` referindo-se ao provider (doutrina de restrição de canal, invariante 1 —
  `pnpm lint:channels`).
- Toda mudança de schema sai em tripla: migration versionada em `supabase/migrations/` +
  apêndice **idempotente** no `supabase/baseline.sql` + linha no
  `supabase/migrations/MANIFEST.md`.
- Sem container/serviço novo em `docker-compose.yml`/`docker-compose.prod.yml` — a
  instância Evolution API é externa, configurada só por `EVOLUTION_API_BASE_URL` +
  `EVOLUTION_API_KEY`.
- Env nova é sempre **opcional** no schema Zod (`lib/env.ts`) — ausência não pode quebrar
  instalação de quem não usa este canal.
- v1 não implementa `fetchProfilePictureUrl`, `resolvePhoneForIdentity`, `templates`,
  `sendTemplate` — todos são métodos opcionais de `ChannelAdapter`; ficam de fora.
- v1 conecta pelo fluxo já existente de "Conexões" (`POST /api/v1/channel-sessions` +
  `GET /api/v1/channel-sessions/[id]/qr`) — as rotas de `app/api/v1/onboarding/whatsapp/*`
  e `app/api/v1/channel-sessions/[id]/reconnect/route.ts` continuam WAHA-only nesta v1;
  ficam como follow-up.
- Próxima migration é `0161` (última hoje: `0160_ai_budgets_so_escreve_pela_rota`, ver
  `supabase/migrations/MANIFEST.md`).

---

### Task 1: `ChannelProvider` ganha `"evolution"` + capabilities

**Files:**
- Modify: `lib/channels/types.ts:12` (`export type ChannelProvider = "waha" | "meta_cloud" | "zernio";`)
- Modify: `lib/channels/capabilities.ts`
- Test: `lib/channels/capabilities.test.ts` (criar se não existir; verificar antes com `Glob`)

**Interfaces:**
- Produces: `ChannelProvider` inclui `"evolution"`; `CHANNEL_CAPABILITIES.evolution`;
  `CHANNEL_PROVIDER_EVOLUTION: ChannelProvider = "evolution"` exportado de
  `lib/channels/capabilities.ts`.

- [ ] **Step 1: Checar se já existe teste de matriz de capabilities**

Rode `Glob` por `lib/channels/*capabilit*test*` e leia o arquivo se existir, para seguir o
formato de asserção já usado (provavelmente itera `Object.keys(CHANNEL_CAPABILITIES)` e
confere presença de cada capability).

- [ ] **Step 2: Escrever o teste (falhando) da nova capability**

Se o arquivo de teste já existir, adicione um caso para `"evolution"`. Se não existir, crie
`lib/channels/capabilities.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { CHANNEL_CAPABILITIES, CHANNEL_PROVIDER_EVOLUTION, capabilitiesOf } from "./capabilities";

describe("capabilities do Evolution API", () => {
  it("tem o mesmo perfil de auto-restrição do WAHA (QR, sem WABA)", () => {
    const caps = capabilitiesOf(CHANNEL_PROVIDER_EVOLUTION);
    expect(caps.freeformOutsideWindow).toBe(true);
    expect(caps.requiresTemplates).toBe(false);
    expect(caps.canManageTemplates).toBe(false);
    expect(caps.banRisk).toBe(true);
    expect(caps.groups).toBe("full");
    expect(caps.costPerMessage).toBe(false);
  });

  it("está na matriz para todo ChannelProvider", () => {
    expect(Object.keys(CHANNEL_CAPABILITIES).sort()).toEqual(
      ["evolution", "meta_cloud", "waha", "zernio"].sort(),
    );
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `pnpm vitest run lib/channels/capabilities.test.ts`
Expected: FAIL — `"evolution"` não existe em `ChannelProvider` (erro de tipo) e
`CHANNEL_PROVIDER_EVOLUTION` não está exportado.

- [ ] **Step 3: Adicionar o provider ao tipo**

Em `lib/channels/types.ts:12`:

```ts
export type ChannelProvider = "waha" | "meta_cloud" | "zernio" | "evolution";
```

- [ ] **Step 4: Adicionar a capability e a constante nomeada**

Em `lib/channels/capabilities.ts`, dentro do objeto `CHANNEL_CAPABILITIES` (depois da
entrada `zernio`):

```ts
  // Mesma natureza do WAHA: engine Baileys não-oficial, QR code, sem WABA por
  // trás. A instância é externa (não gerenciada por este repo), mas o
  // vocabulário de risco é idêntico — auto-restrição, não hetero-restrição.
  evolution: {
    freeformOutsideWindow: true,
    requiresTemplates: false,
    canManageTemplates: false,
    banRisk: true,
    minIntervalMs: null,
    voiceNote: "server-convert",
    groups: "full",
    costPerMessage: false,
  },
```

E, junto das outras constantes nomeadas (depois de `CHANNEL_PROVIDER_ZERNIO`):

```ts
export const CHANNEL_PROVIDER_EVOLUTION: ChannelProvider = "evolution";
```

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `pnpm vitest run lib/channels/capabilities.test.ts`
Expected: PASS

- [ ] **Step 6: Typecheck do projeto inteiro**

Run: `pnpm typecheck`
Expected: PASS — nenhum `switch` exaustivo sobre `ChannelProvider` deve quebrar aqui ainda,
porque nenhum outro arquivo foi tocado; se algum `switch` sem `default` quebrar, anote o
arquivo — ele entra nas próximas tasks.

- [ ] **Step 7: Commit**

```bash
git add lib/channels/types.ts lib/channels/capabilities.ts lib/channels/capabilities.test.ts
git commit -m "feat(channels): adiciona evolution como ChannelProvider + capabilities"
```

---

### Task 2: Migration 0161 — coluna, CHECKs e baseline

**Files:**
- Create: `supabase/migrations/20260818120000_0161_evolution_channel.sql`
- Modify: `supabase/baseline.sql` (apêndice, fim do arquivo)
- Modify: `supabase/migrations/MANIFEST.md`

**Interfaces:**
- Produces: coluna `channel_sessions.evolution_instance_name text`; CHECKs
  `channel_sessions_provider_check` e `channel_sessions_provider_ref_check` atualizados
  para os 4 providers.

- [ ] **Step 1: Escrever a migration**

```sql
-- 20260818120000_0161_evolution_channel.sql
-- Adiciona o Evolution API como quarto ChannelProvider. Mesmo padrão da
-- 0131/0132 (que adicionou o Zernio como terceiro): coluna nasce nullable,
-- CHECKs são recriados por inteiro (drop + add), nunca "duplicate_object" —
-- um clone que já rodou update.sh anterior tem a constraint com 3 valores, e
-- engolir o create deixaria o Evolution API sempre recusado ali, com o
-- update.sh saindo verde.

alter table public.channel_sessions
  add column if not exists evolution_instance_name text;

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
  check (provider = any (array['waha'::text, 'meta_cloud'::text, 'zernio'::text, 'evolution'::text]));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha'       and waha_session_name       is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id    is not null) or
    (provider = 'zernio'     and zernio_account_id       is not null) or
    (provider = 'evolution'  and evolution_instance_name is not null)
  );

comment on column public.channel_sessions.evolution_instance_name is
  'Nome da instância na Evolution API (instância externa, não gerenciada por este repo). Endereça envio e webhook. Espelhado em lib/channels/session-ref.ts.';
```

- [ ] **Step 2: Aplicar a migration num Postgres descartável e provar idempotência**

Run:
```bash
docker run -d --name pg-evo-test -e POSTGRES_PASSWORD=postgres -p 55432:5432 pgvector/pgvector:pg17
sleep 3
PGPASSWORD=postgres psql -h localhost -p 55432 -U postgres -f supabase/baseline.sql
PGPASSWORD=postgres psql -h localhost -p 55432 -U postgres -f supabase/migrations/20260818120000_0161_evolution_channel.sql
PGPASSWORD=postgres psql -h localhost -p 55432 -U postgres -c "\d channel_sessions" | grep -E "evolution|provider_check|provider_ref_check"
```
Expected: a coluna `evolution_instance_name` aparece, e os dois CHECKs listam os 4
providers.

Rode a migration UMA SEGUNDA VEZ contra o mesmo banco (idempotência):
```bash
PGPASSWORD=postgres psql -h localhost -p 55432 -U postgres -f supabase/migrations/20260818120000_0161_evolution_channel.sql
```
Expected: nenhum erro (todo `if not exists`/`drop ... if exists` re-aplica limpo).

- [ ] **Step 3: Adicionar o apêndice idempotente no `baseline.sql`**

No fim de `supabase/baseline.sql`, depois do último bloco existente, adicione (copiando
literalmente o SQL da migration, com o mesmo comentário de contexto):

```sql
-- ---- vocabulário do quarto canal: Evolution API (migration 0161) ----
-- Espelho idempotente da 0161. Mesmo racional da 0131/0132 (Zernio): os dois
-- CHECKs são recriados (drop + add) em vez de `duplicate_object`, porque um
-- clone que já rodou o update.sh anterior já os tem com 3 valores, e engolir
-- o create deixaria o Evolution API sempre recusado ali, com o script saindo
-- verde — a falha-em-verde que a doutrina do self-host proíbe.
alter table public.channel_sessions
  add column if not exists evolution_instance_name text;

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
  check (provider = any (array['waha'::text, 'meta_cloud'::text, 'zernio'::text, 'evolution'::text]));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha'       and waha_session_name       is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id    is not null) or
    (provider = 'zernio'     and zernio_account_id       is not null) or
    (provider = 'evolution'  and evolution_instance_name is not null)
  );

comment on column public.channel_sessions.evolution_instance_name is
  'Nome da instância na Evolution API (instância externa, não gerenciada por este repo). Endereça envio e webhook. Espelhado em lib/channels/session-ref.ts.';
```

- [ ] **Step 4: Validar o baseline num banco fresco (install) e num banco já populado (update)**

Run (banco novo — simula `install.sh`):
```bash
docker rm -f pg-evo-test
docker run -d --name pg-evo-test -e POSTGRES_PASSWORD=postgres -p 55432:5432 pgvector/pgvector:pg17
sleep 3
PGPASSWORD=postgres psql -h localhost -p 55432 -U postgres -v ON_ERROR_STOP=1 -f supabase/baseline.sql
```
Expected: exit 0, sem erro.

Run (mesmo banco de novo — simula `update.sh`, sem `ON_ERROR_STOP`):
```bash
PGPASSWORD=postgres psql -h localhost -p 55432 -U postgres -f supabase/baseline.sql
docker rm -f pg-evo-test
```
Expected: reaplica sem quebrar o schema (erros esperados de `create table`/`create type`
já existentes são o comportamento normal do baseline reaplicado, documentado no
`CLAUDE.md` — confirme que a contagem de erros não é MAIOR que a de uma reaplicação sem
esta mudança; se você tiver dúvida sobre a contagem baseline, rode a mesma reaplicação
numa cópia do banco SEM a Task 2 e compare).

- [ ] **Step 5: Registrar no MANIFEST**

Adicione uma linha à tabela "Applied" em `supabase/migrations/MANIFEST.md`, seguindo o
formato das entradas anteriores:

```markdown
| `20260818120000` | `0161_evolution_channel` | **Evolution API entra como quarto `ChannelProvider`.** Mesmo padrão da 0131/0132 (Zernio): coluna `evolution_instance_name` nasce nullable, os dois CHECKs de provider (`channel_sessions_provider_check`, `channel_sessions_provider_ref_check`) são recriados por inteiro incluindo o 4º valor. A instância Evolution API é EXTERNA — não há serviço novo em nenhum compose deste repo, só configuração (`EVOLUTION_API_BASE_URL`/`EVOLUTION_API_KEY`). Aditiva e idempotente; validada num pg17 descartável nos dois caminhos (install fresco `ON_ERROR_STOP=1` e reaplicação sem a flag). |
```

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260818120000_0161_evolution_channel.sql supabase/baseline.sql supabase/migrations/MANIFEST.md
git commit -m "feat(db): migration 0161 — evolution_instance_name + CHECKs do 4º provider"
```

---

### Task 3: Configuração — `lib/env.ts` e `.env.example`

**Files:**
- Modify: `lib/env.ts:68-74` (bloco de vars do WAHA, para seguir o padrão logo acima/abaixo)
- Modify: `.env.example:44-54` (bloco `WAHA_*`)

**Interfaces:**
- Produces: `env.EVOLUTION_API_BASE_URL: string`, `env.EVOLUTION_API_KEY: string` (ambas
  strings vazias por default — schema `.optional().default("")`, mesmo padrão de
  `WAHA_HMAC_SECRET`).

- [ ] **Step 1: Ler o bloco de vars do WAHA em `lib/env.ts` para confirmar o padrão exato**

Leia `lib/env.ts:60-80` antes de editar (o arquivo pode ter mudado desde a exploração
desta plan). Confirme se `required(...)` ou `.optional().default("")` é usado para
`WAHA_API_BASE_URL`/`WAHA_API_KEY` — vars do WAHA são `required()` porque o WAHA é o
provider padrão instalado por todo `install.sh`; **Evolution API NÃO é** (é opt-in), então
suas vars devem ser `.optional().default("")`, nunca `required()`.

- [ ] **Step 2: Adicionar as vars ao schema Zod**

Logo após o bloco de vars do WAHA em `lib/env.ts`:

```ts
  // Evolution API — instância EXTERNA (não gerenciada por este repo). Opcional
  // de propósito: ausente = canal não configurado, sem quebrar quem não usa.
  EVOLUTION_API_BASE_URL: z.string().optional().default(""),
  EVOLUTION_API_KEY: z.string().optional().default(""),
```

- [ ] **Step 3: Adicionar ao `.env.example`**

Logo após o bloco `WAHA_*` em `.env.example`:

```
# Evolution API (open source, self-hosted) — canal QR alternativo ao WAHA.
# Instância EXTERNA: este repo não sobe container nenhum para ela. Deixe em
# branco se você não usa este canal.
EVOLUTION_API_BASE_URL=
EVOLUTION_API_KEY=
```

- [ ] **Step 4: Rodar typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/env.ts .env.example
git commit -m "feat(config): env vars opcionais do Evolution API (instância externa)"
```

---

### Task 4: `lib/evolution/client.ts` — transporte REST

**Files:**
- Create: `lib/evolution/client.ts`
- Test: `lib/evolution/client.test.ts`

**Interfaces:**
- Consumes: nada de outras tasks deste plano (é a base).
- Produces: `class EvolutionClient` com `createInstance`, `getConnectionState`, `getQr`,
  `deleteInstance`, `sendText`, `sendMedia`, `configureWebhook`; função
  `getEvolutionClient(): EvolutionClient | null`.

⚠️ **Contrato REST assumido (Evolution API v2), a confirmar contra a instância real do
dono do produto antes de considerar a task fechada** — ver Step 6.

- [ ] **Step 1: Escrever o teste (falhando) do parsing de resposta e do `getEvolutionClient`**

```ts
// lib/evolution/client.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { EvolutionClient, getEvolutionClient } from "./client";

describe("getEvolutionClient", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("retorna null sem EVOLUTION_API_BASE_URL", () => {
    vi.stubEnv("EVOLUTION_API_BASE_URL", "");
    vi.stubEnv("EVOLUTION_API_KEY", "abc");
    expect(getEvolutionClient()).toBeNull();
  });

  it("retorna null sem EVOLUTION_API_KEY", () => {
    vi.stubEnv("EVOLUTION_API_BASE_URL", "http://localhost:8080");
    vi.stubEnv("EVOLUTION_API_KEY", "");
    expect(getEvolutionClient()).toBeNull();
  });

  it("retorna um client configurado com as duas vars presentes", () => {
    vi.stubEnv("EVOLUTION_API_BASE_URL", "http://localhost:8080");
    vi.stubEnv("EVOLUTION_API_KEY", "abc");
    expect(getEvolutionClient()).toBeInstanceOf(EvolutionClient);
  });
});

describe("EvolutionClient.sendText", () => {
  it("chama POST /message/sendText/{instance} com o header apikey", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ key: { id: "3EB0ABC", remoteJid: "5511999999999@s.whatsapp.net", fromMe: true } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new EvolutionClient("http://localhost:8080", "abc");
    const res = await client.sendText("org_1", "5511999999999@s.whatsapp.net", "oi");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/message/sendText/org_1",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ apikey: "abc" }),
      }),
    );
    expect(res).toEqual({ key: { id: "3EB0ABC", remoteJid: "5511999999999@s.whatsapp.net", fromMe: true } });
  });

  it("lança com o corpo do erro quando a resposta não é ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "number invalid" }),
    );
    const client = new EvolutionClient("http://localhost:8080", "abc");
    await expect(client.sendText("org_1", "invalid", "oi")).rejects.toThrow("evolution_400");
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `pnpm vitest run lib/evolution/client.test.ts`
Expected: FAIL — módulo `./client` não existe.

- [ ] **Step 3: Implementar `lib/evolution/client.ts`**

```ts
/**
 * Cliente REST mínimo da Evolution API (instância EXTERNA, não gerenciada por
 * este repo — só URL + API key). Mirror de `lib/waha/client.ts`: mesmo
 * formato de erro (`evolution_<status>: <corpo>`), mesmo padrão de
 * `getEvolutionClient()` devolvendo `null` quando o env não está configurado,
 * para quem chama renderizar "canal não configurado" em vez de quebrar.
 *
 * Contrato assumido da Evolution API v2 (não medido contra a instância real
 * do dono do produto nesta task — ver nota no plano). Se a instância dele
 * responder shape diferente, ajuste aqui; o resto do adapter não muda.
 */
export class EvolutionClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { apikey: this.apiKey, "Content-Type": "application/json", ...extra };
  }

  /**
   * Idempotente: 403/409 (instância já existe) são tratados como sucesso —
   * quem chama quer o efeito (instância pronta), não a transição.
   */
  async createInstance(instanceName: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/instance/create`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        instanceName,
        qrcode: true,
        integration: "WHATSAPP-BAILEYS",
      }),
    });
    if (!res.ok && ![403, 409].includes(res.status)) {
      const body = await res.text().catch(() => "");
      throw new Error(`evolution_${res.status}: ${body.slice(0, 200)}`);
    }
  }

  /** QR atual da instância. `base64` é uma data URL (`data:image/png;base64,...`). */
  async getQr(instanceName: string): Promise<{ base64: string | null; pairingCode: string | null }> {
    const res = await fetch(`${this.baseUrl}/instance/connect/${encodeURIComponent(instanceName)}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`evolution_${res.status}`);
    const body = (await res.json()) as { base64?: string; pairingCode?: string };
    return { base64: body.base64 ?? null, pairingCode: body.pairingCode ?? null };
  }

  /** Estado da conexão: `"open" | "connecting" | "close"`, ou `null` se não deu para ler. */
  async getConnectionState(instanceName: string): Promise<string | null> {
    const res = await fetch(
      `${this.baseUrl}/instance/connectionState/${encodeURIComponent(instanceName)}`,
      { headers: this.headers() },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { instance?: { state?: string } };
    return body.instance?.state ?? null;
  }

  /** Idempotente: 404 (instância desconhecida) conta como sucesso. */
  async deleteInstance(instanceName: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/instance/delete/${encodeURIComponent(instanceName)}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 404) {
      const body = await res.text().catch(() => "");
      throw new Error(`evolution_${res.status}: ${body.slice(0, 200)}`);
    }
  }

  /** Aponta o webhook da instância para o path token desta sessão. */
  async configureWebhook(instanceName: string, webhookUrl: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/webhook/set/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        webhook: {
          url: webhookUrl,
          enabled: true,
          webhook_by_events: false,
          events: ["MESSAGES_UPSERT", "CONNECTION_UPDATE"],
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`evolution_${res.status}: ${body.slice(0, 200)}`);
    }
  }

  async sendText(instanceName: string, number: string, text: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/message/sendText/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ number, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`evolution_${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  async sendMedia(
    instanceName: string,
    number: string,
    plan: { mediatype: "image" | "video" | "document" | "audio"; media: string; caption?: string; fileName?: string },
  ): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/message/sendMedia/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ number, ...plan }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`evolution_${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }
}

/**
 * Devolve um client configurado ou `null`. `null` = canal não configurado
 * (env ausente) — quem chama trata como noop, não como erro.
 */
export function getEvolutionClient(): EvolutionClient | null {
  const url = process.env.EVOLUTION_API_BASE_URL;
  const key = process.env.EVOLUTION_API_KEY;
  if (!url || !key) return null;
  return new EvolutionClient(url, key);
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `pnpm vitest run lib/evolution/client.test.ts`
Expected: PASS

- [ ] **Step 5: Adicionar `lib/evolution/` ao `ALLOWED` do lint de canais**

Em `scripts/lint-channels.ts`, no array `ALLOWED` (perto da linha 39-45), adicione:

```ts
const ALLOWED = [
  /^lib\/channels\//,
  // O transporte que o adapter embrulha; some quando a Fase 3 o absorver.
  /^lib\/waha\//,
  // Mesma natureza: transporte puro do Evolution API, embrulhado pelo adapter.
  /^lib\/evolution\//,
  // Saída de `supabase gen types`: os nomes são COLUNAS. Editar à mão é o defeito.
  /^lib\/database\.types\.ts$/,
];
```

Run: `pnpm lint:channels`
Expected: PASS (nenhum arquivo novo reprovado).

- [ ] **Step 6: Confirmar o contrato real da instância (não bloqueante para o commit, mas obrigatório antes de considerar o canal pronto para produção)**

Se você tiver acesso à instância Evolution API do dono do produto, rode:

```bash
curl -s -H "apikey: $EVOLUTION_API_KEY" "$EVOLUTION_API_BASE_URL/instance/connectionState/<uma-instancia-existente>"
```

Compare o shape da resposta com o assumido em `getConnectionState`. Se divergir, ajuste
`client.ts` e os testes desta task — o resto do plano não depende do shape exato, só desta
função.

- [ ] **Step 7: Commit**

```bash
git add lib/evolution/client.ts lib/evolution/client.test.ts scripts/lint-channels.ts
git commit -m "feat(evolution): cliente REST mínimo + libera lib/evolution/ no lint de canais"
```

---

### Task 5: `lib/evolution/send.ts` + `lib/evolution/message-id.ts`

**Files:**
- Create: `lib/evolution/send.ts`
- Create: `lib/evolution/message-id.ts`
- Test: `lib/evolution/send.test.ts`
- Test: `lib/evolution/message-id.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `resolveEvolutionChatId(input: ResolveEvolutionChatIdInput): string | null`;
  `parseEvolutionMessageId(raw: unknown): string | null`.

- [ ] **Step 1: Escrever os testes (falhando)**

```ts
// lib/evolution/send.test.ts
import { describe, expect, it } from "vitest";

import { resolveEvolutionChatId } from "./send";

describe("resolveEvolutionChatId", () => {
  it("grupo: usa o groupChatId direto", () => {
    expect(
      resolveEvolutionChatId({ isGroup: true, groupChatId: "123-456@g.us", phoneNumber: null }),
    ).toBe("123-456@g.us");
  });

  it("individual: telefone vira <digitos>@s.whatsapp.net", () => {
    expect(
      resolveEvolutionChatId({ isGroup: false, groupChatId: null, phoneNumber: "+55 11 99999-9999" }),
    ).toBe("5511999999999@s.whatsapp.net");
  });

  it("sem telefone e sem grupo: null", () => {
    expect(resolveEvolutionChatId({ isGroup: false, groupChatId: null, phoneNumber: null })).toBeNull();
  });
});
```

```ts
// lib/evolution/message-id.test.ts
import { describe, expect, it } from "vitest";

import { parseEvolutionMessageId } from "./message-id";

describe("parseEvolutionMessageId", () => {
  it("extrai key.id da resposta de envio", () => {
    expect(
      parseEvolutionMessageId({ key: { id: "3EB0ABC123", remoteJid: "5511999999999@s.whatsapp.net", fromMe: true } }),
    ).toBe("3EB0ABC123");
  });

  it("null quando não há key.id", () => {
    expect(parseEvolutionMessageId({})).toBeNull();
    expect(parseEvolutionMessageId(null)).toBeNull();
    expect(parseEvolutionMessageId("string crua")).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falham**

Run: `pnpm vitest run lib/evolution/send.test.ts lib/evolution/message-id.test.ts`
Expected: FAIL — módulos não existem.

- [ ] **Step 3: Implementar `lib/evolution/send.ts`**

```ts
/**
 * Endereço Evolution API de uma conversa — mirror de `lib/waha/send.ts`, sem
 * a complexidade de LID (fora de escopo da v1, ver spec).
 */
export interface ResolveEvolutionChatIdInput {
  isGroup: boolean;
  groupChatId: string | null;
  phoneNumber: string | null | undefined;
}

export function resolveEvolutionChatId(input: ResolveEvolutionChatIdInput): string | null {
  if (input.isGroup && input.groupChatId) return input.groupChatId;
  if (input.phoneNumber) return `${input.phoneNumber.replace(/\D/g, "")}@s.whatsapp.net`;
  return null;
}
```

- [ ] **Step 4: Implementar `lib/evolution/message-id.ts`**

```ts
/**
 * Extrai o id externo da resposta de envio / do payload de webhook da
 * Evolution API v2. Ao contrário do WAHA (shape varia por engine/versão), a
 * Evolution API sempre devolve `key.id` — sem os múltiplos formatos que
 * `parseWahaMessageId` precisa tratar.
 */
export function parseEvolutionMessageId(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as { key?: { id?: unknown } };
  if (typeof r.key === "object" && r.key !== null && typeof r.key.id === "string") {
    return r.key.id;
  }
  return null;
}
```

- [ ] **Step 5: Rodar e confirmar que passam**

Run: `pnpm vitest run lib/evolution/send.test.ts lib/evolution/message-id.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/evolution/send.ts lib/evolution/message-id.ts lib/evolution/send.test.ts lib/evolution/message-id.test.ts
git commit -m "feat(evolution): resolução de chatId e parsing de message id"
```

---

### Task 6: `lib/evolution/webhook.ts` — parser puro do payload

**Files:**
- Create: `lib/evolution/webhook.ts`
- Test: `lib/evolution/webhook.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `parseEvolutionInbound(payload: unknown): EvolutionInboundMessage | null`;
  `parseEvolutionConnectionUpdate(payload: unknown): { state: string } | null`; tipo
  `EvolutionInboundMessage`.

⚠️ Shape assumido do webhook `messages.upsert` da Evolution API v2 — mesma ressalva da
Task 4. Mensagens de texto trazem `data.message.conversation`; mensagens de mídia trazem
`data.message.<tipo>Message` (`imageMessage`, `videoMessage`, `audioMessage`,
`documentMessage`), cada uma com `caption?`/`mimetype`. A v1 **não baixa mídia inline no
webhook** — grava o tipo e deixa o worker de persistência pedir os bytes depois (mesmo
padrão do Zernio, ver Task 7); por isso este parser não precisa de URL de mídia.

- [ ] **Step 1: Escrever o teste (falhando)**

```ts
// lib/evolution/webhook.test.ts
import { describe, expect, it } from "vitest";

import { parseEvolutionConnectionUpdate, parseEvolutionInbound } from "./webhook";

const TEXTO = {
  event: "messages.upsert",
  instance: "org_abc123",
  data: {
    key: { remoteJid: "5511999999999@s.whatsapp.net", fromMe: false, id: "3EB0XYZ" },
    pushName: "Fulano",
    message: { conversation: "oi, tudo bem?" },
    messageType: "conversation",
    messageTimestamp: 1734000000,
  },
};

const IMAGEM = {
  event: "messages.upsert",
  instance: "org_abc123",
  data: {
    key: { remoteJid: "5511999999999@s.whatsapp.net", fromMe: false, id: "3EB0IMG" },
    pushName: "Fulano",
    message: { imageMessage: { caption: "olha isso", mimetype: "image/jpeg" } },
    messageType: "imageMessage",
    messageTimestamp: 1734000001,
  },
};

const ECO = {
  event: "messages.upsert",
  instance: "org_abc123",
  data: {
    key: { remoteJid: "5511999999999@s.whatsapp.net", fromMe: true, id: "3EB0OUT" },
    message: { conversation: "resposta do atendente" },
    messageType: "conversation",
    messageTimestamp: 1734000002,
  },
};

describe("parseEvolutionInbound", () => {
  it("mensagem de texto: direction inbound, body presente", () => {
    const msg = parseEvolutionInbound(TEXTO);
    expect(msg).toMatchObject({
      externalId: "3EB0XYZ",
      chatId: "5511999999999@s.whatsapp.net",
      direction: "inbound",
      body: "oi, tudo bem?",
      pushName: "Fulano",
      attachmentType: null,
    });
  });

  it("mensagem de imagem: attachmentType = image, body = caption", () => {
    const msg = parseEvolutionInbound(IMAGEM);
    expect(msg).toMatchObject({
      externalId: "3EB0IMG",
      attachmentType: "image",
      body: "olha isso",
    });
  });

  it("fromMe=true vira direction outbound (eco do próprio envio)", () => {
    const msg = parseEvolutionInbound(ECO);
    expect(msg?.direction).toBe("outbound");
  });

  it("evento de outro tipo: null", () => {
    expect(parseEvolutionInbound({ event: "qrcode.updated", data: {} })).toBeNull();
  });

  it("payload sem forma reconhecível: null, não lança", () => {
    expect(parseEvolutionInbound(null)).toBeNull();
    expect(parseEvolutionInbound("lixo")).toBeNull();
    expect(parseEvolutionInbound({})).toBeNull();
  });
});

describe("parseEvolutionConnectionUpdate", () => {
  it("extrai o state", () => {
    expect(
      parseEvolutionConnectionUpdate({
        event: "connection.update",
        instance: "org_abc123",
        data: { state: "open" },
      }),
    ).toEqual({ state: "open" });
  });

  it("null para outro evento", () => {
    expect(parseEvolutionConnectionUpdate({ event: "messages.upsert", data: {} })).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `pnpm vitest run lib/evolution/webhook.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar `lib/evolution/webhook.ts`**

```ts
/**
 * Leitura PURA do payload de webhook da Evolution API — decide, não escreve.
 * Mirror de `lib/channels/zernio/webhook.ts`: quem grava é `lib/evolution/ingest.ts`.
 */

export type EvolutionAttachmentType = "image" | "video" | "audio" | "document" | "sticker" | null;

export interface EvolutionInboundMessage {
  externalId: string;
  chatId: string;
  direction: "inbound" | "outbound";
  body: string | null;
  pushName: string | null;
  attachmentType: EvolutionAttachmentType;
  sentAt: string | null;
}

interface RawEnvelope {
  event?: unknown;
  instance?: unknown;
  data?: unknown;
}

const MEDIA_KEYS: Record<string, Exclude<EvolutionAttachmentType, null>> = {
  imageMessage: "image",
  videoMessage: "video",
  audioMessage: "audio",
  documentMessage: "document",
  stickerMessage: "sticker",
};

export function parseEvolutionInbound(payload: unknown): EvolutionInboundMessage | null {
  if (typeof payload !== "object" || payload === null) return null;
  const env = payload as RawEnvelope;
  if (env.event !== "messages.upsert") return null;
  if (typeof env.data !== "object" || env.data === null) return null;

  const data = env.data as {
    key?: { remoteJid?: unknown; fromMe?: unknown; id?: unknown };
    pushName?: unknown;
    message?: Record<string, unknown>;
    messageTimestamp?: unknown;
  };

  const externalId = data.key?.id;
  const chatId = data.key?.remoteJid;
  if (typeof externalId !== "string" || typeof chatId !== "string") return null;

  const message = data.message ?? {};
  let attachmentType: EvolutionAttachmentType = null;
  let body: string | null = typeof message.conversation === "string" ? message.conversation : null;

  for (const [key, tipo] of Object.entries(MEDIA_KEYS)) {
    const bloco = message[key];
    if (typeof bloco === "object" && bloco !== null) {
      attachmentType = tipo;
      const caption = (bloco as { caption?: unknown }).caption;
      if (typeof caption === "string") body = caption;
      break;
    }
  }

  const timestamp = data.messageTimestamp;
  const sentAt =
    typeof timestamp === "number"
      ? new Date(timestamp * 1000).toISOString()
      : typeof timestamp === "string" && /^\d+$/.test(timestamp)
        ? new Date(Number(timestamp) * 1000).toISOString()
        : null;

  return {
    externalId,
    chatId,
    direction: data.key?.fromMe === true ? "outbound" : "inbound",
    body,
    pushName: typeof data.pushName === "string" ? data.pushName : null,
    attachmentType,
    sentAt,
  };
}

export function parseEvolutionConnectionUpdate(payload: unknown): { state: string } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const env = payload as RawEnvelope;
  if (env.event !== "connection.update") return null;
  if (typeof env.data !== "object" || env.data === null) return null;
  const state = (env.data as { state?: unknown }).state;
  return typeof state === "string" ? { state } : null;
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `pnpm vitest run lib/evolution/webhook.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/evolution/webhook.ts lib/evolution/webhook.test.ts
git commit -m "feat(evolution): parser puro do payload de webhook (messages.upsert, connection.update)"
```

---

### Task 7: `lib/evolution/ingest.ts` — efeitos (grava contato/conversa/mensagem)

**Files:**
- Create: `lib/evolution/ingest.ts`
- Test: `lib/evolution/ingest.test.ts`

**Interfaces:**
- Consumes: `parseEvolutionInbound`, `parseEvolutionConnectionUpdate` de `./webhook`
  (Task 6); `aplicarEfeitosPosEntrada` de `@/lib/channels/pos-entrada`;
  `sincronizarSaudeDaConexao` de `@/lib/channels/health`.
- Produces: `ingestEvolutionInbound(admin, { organizationId, channelSessionId, payload, displayName? }): Promise<EvolutionIngestResult>`.

Mirror de `lib/channels/zernio/ingest.ts` (Task-anterior lida na exploração deste plano):
mesmas RPCs compartilhadas (`fn_upsert_wa_contact`, `fn_upsert_wa_conversation`,
`fn_mark_conversation_message`, `emit_event`), mesma captura de `23505` como duplicata.
Diferença: identidade é sempre `phone:` (Evolution API/Baileys não expõe o conceito de LID
opaco pelo webhook do jeito que o WAHA faz — a v1 não traduz LID, ver spec) e a conversa é
resolvida por `channel_session_id` (não há `provider_conversation_id` própria — o
endereço já é derivável do contato, como no WAHA).

- [ ] **Step 1: Escrever o teste (falhando), com um Supabase client dublê**

Antes de escrever, confira como `lib/channels/zernio/ingest.test.ts` (se existir — rode
`Glob` por `lib/channels/zernio/ingest.test.ts` e leia) dubla o `SupabaseClient` — reuse o
mesmo estilo de mock (provavelmente uma implementação mínima de `.from().insert()`,
`.rpc()` encadeáveis). Se não houver teste irmão para copiar o estilo, use este:

```ts
// lib/evolution/ingest.test.ts
import { describe, expect, it, vi } from "vitest";

import { ingestEvolutionInbound } from "./ingest";

function buildAdminMock(overrides: {
  contactId?: string;
  conversationId?: string;
  insertResult?: { data: { id: string } | null; error: { code?: string; message?: string } | null };
}) {
  const insertResult = overrides.insertResult ?? { data: { id: "msg-1" }, error: null };
  const rpc = vi.fn((fn: string) => {
    if (fn === "fn_upsert_wa_contact") return Promise.resolve({ data: overrides.contactId ?? "contact-1", error: null });
    if (fn === "fn_upsert_wa_conversation") return Promise.resolve({ data: overrides.conversationId ?? "conv-1", error: null });
    if (fn === "fn_mark_conversation_message") return Promise.resolve({ data: null, error: null });
    if (fn === "emit_event") return Promise.resolve({ data: null, error: null });
    throw new Error(`rpc inesperada: ${fn}`);
  });

  const insertChain = { select: () => ({ maybeSingle: () => Promise.resolve(insertResult) }) };
  const from = vi.fn((table: string) => {
    if (table === "messages") return { insert: () => insertChain };
    if (table === "contacts") return { update: () => ({ eq: () => ({ is: () => Promise.resolve({ error: null }) }) }) };
    throw new Error(`tabela inesperada: ${table}`);
  });

  return { rpc, from } as never;
}

const PAYLOAD_TEXTO = {
  event: "messages.upsert",
  instance: "org_abc",
  data: {
    key: { remoteJid: "5511999999999@s.whatsapp.net", fromMe: false, id: "3EB0XYZ" },
    pushName: "Fulano",
    message: { conversation: "oi" },
    messageTimestamp: 1734000000,
  },
};

describe("ingestEvolutionInbound", () => {
  it("mensagem de texto nova: cria contato, conversa e mensagem", async () => {
    const admin = buildAdminMock({});
    const r = await ingestEvolutionInbound(admin, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      payload: PAYLOAD_TEXTO,
    });
    expect(r).toMatchObject({ status: "ingested", conversationId: "conv-1", messageId: "msg-1" });
  });

  it("reentrega (23505): retorna duplicate, sem lançar", async () => {
    const admin = buildAdminMock({
      insertResult: { data: null, error: { code: "23505" } },
    });
    const r = await ingestEvolutionInbound(admin, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      payload: PAYLOAD_TEXTO,
    });
    expect(r).toMatchObject({ status: "duplicate", conversationId: "conv-1" });
  });

  it("evento sem interesse: ignored, sem tocar o banco", async () => {
    const admin = buildAdminMock({});
    const r = await ingestEvolutionInbound(admin, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      payload: { event: "qrcode.updated", data: {} },
    });
    expect(r.status).toBe("ignored");
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `pnpm vitest run lib/evolution/ingest.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar `lib/evolution/ingest.ts`**

```ts
/**
 * Ingestão do Evolution API: webhook → contato, conversa, mensagem.
 *
 * Mirror de `lib/channels/zernio/ingest.ts` — mesmas RPCs compartilhadas
 * (`fn_upsert_wa_contact`, `fn_upsert_wa_conversation`,
 * `fn_mark_conversation_message`, `emit_event`), mesma idempotência por
 * `unique (organization_id, external_id)` capturando 23505.
 *
 * Identidade sempre `phone:` — a v1 não resolve LID por este canal (ver spec,
 * seção Riscos). `chatId` (`<telefone>@s.whatsapp.net`) é a própria thread:
 * não há `provider_conversation_id` a gravar, como no WAHA.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import { aplicarEfeitosPosEntrada } from "../channels/pos-entrada";

import { parseEvolutionInbound, type EvolutionInboundMessage } from "./webhook";

export interface EvolutionIngestResult {
  status: "ingested" | "duplicate" | "ignored";
  conversationId?: string;
  messageId?: string;
  reason?: string;
}

export async function ingestEvolutionInbound(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string; payload: unknown; requestId?: string },
): Promise<EvolutionIngestResult> {
  const msg = parseEvolutionInbound(input.payload);
  if (!msg) return { status: "ignored", reason: "evento_sem_interesse" };

  const phone = telefoneDoChatId(msg.chatId);
  if (!phone) return { status: "ignored", reason: "chatId_sem_telefone_reconhecivel" };

  const contactId = await upsertContact(admin, input.organizationId, msg, phone);
  if (!contactId) return { status: "ignored", reason: "contato_nao_resolvido" };

  const conversationId = await upsertConversation(admin, input.organizationId, contactId, input.channelSessionId);
  if (!conversationId) return { status: "ignored", reason: "conversa_nao_resolvida" };

  const inserted = await insertMessage(admin, {
    organizationId: input.organizationId,
    conversationId,
    contactId,
    channelSessionId: input.channelSessionId,
    msg,
  });

  if (inserted === "duplicate") return { status: "duplicate", conversationId };

  await marcarConversa(admin, conversationId, msg);
  if (msg.attachmentType) {
    await pedirPersistenciaDaMidia(admin, input.organizationId, conversationId, inserted);
  }
  if (msg.direction === "inbound") {
    await aplicarEfeitosPosEntrada(admin, {
      organizationId: input.organizationId,
      contactId,
      conversationId,
      messageId: inserted,
      channelSessionId: input.channelSessionId,
      texto: msg.body,
      nomeDoContato: msg.pushName,
      requestId: input.requestId,
      origem: "evolution_webhook",
    });
  }

  return { status: "ingested", conversationId, messageId: inserted };
}

/** `5511999999999@s.whatsapp.net` → `+5511999999999`. Grupo (`@g.us`) não tem telefone. */
function telefoneDoChatId(chatId: string): string | null {
  if (chatId.endsWith("@g.us")) return null;
  const digitos = chatId.split("@")[0]?.replace(/\D/g, "") ?? "";
  return digitos.length >= 8 ? `+${digitos}` : null;
}

async function upsertContact(
  admin: SupabaseClient,
  organizationId: string,
  msg: EvolutionInboundMessage,
  phone: string,
): Promise<string | null> {
  const { data, error } = await admin.rpc("fn_upsert_wa_contact", {
    p_org: organizationId,
    p_kind: "phone",
    p_phone: phone,
    p_lid: null,
    p_chat_id: msg.chatId,
    p_notify: msg.pushName,
  });
  if (error) return null;
  return (data as string) ?? null;
}

async function upsertConversation(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
  channelSessionId: string,
): Promise<string | null> {
  const { data, error } = await admin.rpc("fn_upsert_wa_conversation", {
    p_org: organizationId,
    p_contact: contactId,
    p_session: channelSessionId,
  });
  if (error || !data) return null;
  return data as string;
}

async function insertMessage(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    conversationId: string;
    contactId: string;
    channelSessionId: string;
    msg: EvolutionInboundMessage;
  },
): Promise<string | "duplicate"> {
  const { msg } = input;
  const { data, error } = await admin
    .from("messages")
    .insert({
      organization_id: input.organizationId,
      conversation_id: input.conversationId,
      contact_id: input.contactId,
      channel_session_id: input.channelSessionId,
      external_id: msg.externalId,
      direction: msg.direction,
      sent_via: "external_device",
      status: msg.direction === "outbound" ? "sent" : "delivered",
      type: msg.attachmentType ?? "text",
      body: msg.body,
      metadata: {},
      ...(msg.sentAt ? { sent_at: msg.sentAt } : {}),
    })
    .select("id")
    .maybeSingle();

  if (error?.code === "23505") return "duplicate";
  if (error || !data) throw new Error(`evolution_ingest_insert_failed: ${error?.message ?? "sem id"}`);
  return (data as { id: string }).id;
}

async function marcarConversa(
  admin: SupabaseClient,
  conversationId: string,
  msg: EvolutionInboundMessage,
): Promise<void> {
  const { error } = await admin.rpc("fn_mark_conversation_message" as never, {
    p_conv: conversationId,
    p_direction: msg.direction,
    p_preview: (msg.body ?? "").slice(0, 200),
    p_at: msg.sentAt ?? new Date().toISOString(),
  } as never);
  if (error) {
    logger.warn("[evolution] carimbo da conversa falhou", { conversationId, detail: error.message });
  }
}

async function pedirPersistenciaDaMidia(
  admin: SupabaseClient,
  organizationId: string,
  conversationId: string,
  messageId: string,
): Promise<void> {
  const { error } = await admin.rpc("emit_event" as never, {
    p_event_type: "media.persist_requested",
    p_entity_kind: "message",
    p_entity_id: messageId,
    p_payload: { message_id: messageId, conversation_id: conversationId },
    p_metadata: { source: "evolution_webhook" },
    p_organization_id: organizationId,
  } as never);
  if (error) {
    logger.warn("[evolution] emit media.persist_requested falhou", { messageId, detail: error.message });
  }
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `pnpm vitest run lib/evolution/ingest.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/evolution/ingest.ts lib/evolution/ingest.test.ts
git commit -m "feat(evolution): ingestão de mensagem inbound (contato/conversa/mensagem)"
```

---

### Task 8: Ligar ao seam genérico de webhook (`lib/channels/inbound.ts`)

**Files:**
- Modify: `lib/channels/inbound.ts`

**Interfaces:**
- Consumes: `ingestEvolutionInbound` de `@/lib/evolution/ingest` (Task 7);
  `parseEvolutionConnectionUpdate` de `@/lib/evolution/webhook` (Task 6);
  `CHANNEL_PROVIDER_EVOLUTION` de `./capabilities` (Task 1).
- Produces: `acceptsInboundWebhook("evolution") === true`;
  `handleInboundWebhook` roteia payload de sessão `provider: "evolution"` para
  `evolutionInbound`.

Evolution API não assina o webhook por padrão (sem HMAC nativo confirmado — ver spec,
seção Riscos). A autenticidade vem do **path token opaco** já resolvido pela rota
genérica antes de chegar aqui (`webhook_path_token`, único, alto entropia) — mesmo nível
de segurança do Zernio hoje. Não há corpo assinado a conferir; a rota já rejeitou token
inválido/curto antes de chamar `handleInboundWebhook`.

- [ ] **Step 1: Ler o arquivo atual para confirmar que a estrutura não mudou**

Releia `lib/channels/inbound.ts` inteiro (é curto, ~170 linhas) antes de editar — o switch
principal e a função `zernioInbound` são o molde exato a seguir.

- [ ] **Step 2: Adicionar os imports**

No topo do arquivo, junto dos imports existentes:

```ts
import { CHANNEL_PROVIDER_EVOLUTION, CHANNEL_PROVIDER_ZERNIO } from "./capabilities";
import { sincronizarSaudeDaConexao } from "./health";
```
(a linha de `sincronizarSaudeDaConexao` já existe — não duplique; confirme antes de
adicionar.)

```ts
import { ingestEvolutionInbound } from "@/lib/evolution/ingest";
import { parseEvolutionConnectionUpdate } from "@/lib/evolution/webhook";
```

- [ ] **Step 3: Estender `acceptsInboundWebhook`**

```ts
export function acceptsInboundWebhook(provider: string): boolean {
  return provider === CHANNEL_PROVIDER_ZERNIO || provider === CHANNEL_PROVIDER_EVOLUTION;
}
```

- [ ] **Step 4: Estender o switch de `handleInboundWebhook`**

```ts
  switch (provider) {
    case CHANNEL_PROVIDER_ZERNIO:
      return zernioInbound(admin, input);
    case CHANNEL_PROVIDER_EVOLUTION:
      return evolutionInbound(admin, input);
    default:
      return { ok: false, code: "provider_mismatch", message: "canal não recebe por esta rota" };
  }
```

- [ ] **Step 5: Escrever a função `evolutionInbound`**

Logo depois da função `zernioInbound` existente:

```ts
async function evolutionInbound(
  admin: SupabaseClient,
  input: InboundWebhookInput,
): Promise<InboundWebhookOutcome> {
  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    return { ok: false, code: "invalid_json", message: "invalid_json" };
  }

  // Evento de CONEXÃO passa pelo vigia de saúde, não pela ingestão de mensagem.
  const conexao = parseEvolutionConnectionUpdate(payload);
  if (conexao) {
    const desfecho = await sincronizarSaudeDaConexao(
      admin,
      { id: input.session.id, organization_id: input.session.organization_id, status: conexao.state },
      { status: conexao.state, detail: null },
      input.session.display_name ?? input.session.phone_number ?? "sem nome",
      "empurrao",
    );
    return { ok: true, body: { status: "saude", state: conexao.state, desfecho } };
  }

  const r = await ingestEvolutionInbound(admin, {
    organizationId: input.session.organization_id,
    channelSessionId: input.session.id,
    payload,
  });
  return { ok: true, body: { ...r } };
}
```

⚠️ **Confira a assinatura real de `sincronizarSaudeDaConexao`** (leia
`lib/channels/health.ts` antes deste step) — a chamada acima foi inferida do uso em
`zernioInbound` já existente neste mesmo arquivo; se os tipos de parâmetro divergirem
(por exemplo o 4º argumento aceitar só um vocabulário fechado de strings), ajuste a
chamada para casar exatamente, e rode `pnpm typecheck` para confirmar.

- [ ] **Step 6: Rodar typecheck e os testes do módulo**

Run: `pnpm typecheck && pnpm vitest run lib/channels/inbound.test.ts` (se o arquivo de
teste não existir, rode só `pnpm typecheck` e confirme visualmente que o switch está
exaustivo — TypeScript acusa em compilação se faltar um `case` num switch tipado sobre
`ChannelProvider` sem `default`, mas este tem `default`, então não há checagem
exaustiva automática aqui; garanta manualmente).
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/channels/inbound.ts
git commit -m "feat(channels): rotea webhook do Evolution API pelo seam genérico"
```

---

### Task 9: `lib/channels/adapters/evolution.ts` — o `ChannelAdapter`

**Files:**
- Create: `lib/channels/adapters/evolution.ts`
- Test: `lib/channels/adapters/evolution.test.ts`
- Modify: `lib/channels/index.ts`
- Modify: `lib/channels/session-ref.ts`

**Interfaces:**
- Consumes: `getEvolutionClient` de `@/lib/evolution/client` (Task 4);
  `resolveEvolutionChatId` de `@/lib/evolution/send` (Task 5);
  `parseEvolutionMessageId` de `@/lib/evolution/message-id` (Task 5).
- Produces: `evolutionAdapter: ChannelAdapter`, registrado em `ADAPTERS.evolution` (Task
  9); `ChannelSessionRef` ganha o membro `{ provider: "evolution"; evolution_instance_name: string }`.

- [ ] **Step 1: Escrever o teste (falhando)**

```ts
// lib/channels/adapters/evolution.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { evolutionAdapter } from "./evolution";

describe("evolutionAdapter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("provider é 'evolution'", () => {
    expect(evolutionAdapter.provider).toBe("evolution");
  });

  it("resolveRecipient: telefone vira @s.whatsapp.net", () => {
    expect(
      evolutionAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: "+5511999999999",
        waIdentity: null,
      }),
    ).toBe("5511999999999@s.whatsapp.net");
  });

  it("isConfigured: false sem env", () => {
    vi.stubEnv("EVOLUTION_API_BASE_URL", "");
    vi.stubEnv("EVOLUTION_API_KEY", "");
    expect(evolutionAdapter.isConfigured()).toBe(false);
  });

  it("send: sem client configurado devolve externalId null (noop, não erro)", async () => {
    vi.stubEnv("EVOLUTION_API_BASE_URL", "");
    vi.stubEnv("EVOLUTION_API_KEY", "");
    const res = await evolutionAdapter.send({
      sessionRef: "org_abc",
      to: "5511999999999@s.whatsapp.net",
      kind: "text",
      body: "oi",
    });
    expect(res).toEqual({ externalId: null });
  });

  it("codes tem os três códigos esperados", () => {
    expect(evolutionAdapter.codes).toEqual({
      notConfigured: "evolution_not_configured",
      sendFailed: "evolution_error",
      unknownError: "evolution_unknown",
    });
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `pnpm vitest run lib/channels/adapters/evolution.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar o adapter**

```ts
/**
 * Adapter Evolution API — mirror de `lib/channels/adapters/waha.ts`: burro de
 * propósito, delega tudo a `lib/evolution/*`. Nenhuma regra de negócio aqui
 * (ver `ChannelAdapter` em ../types).
 */
import { getEvolutionClient } from "@/lib/evolution/client";
import { parseEvolutionMessageId } from "@/lib/evolution/message-id";
import { resolveEvolutionChatId } from "@/lib/evolution/send";
import type { ChannelAdapter, ChannelHealth, OutboundEnvelope, RecipientInput } from "../types";

export const evolutionAdapter: ChannelAdapter = {
  provider: "evolution",

  resolveRecipient(input: RecipientInput): string | null {
    return resolveEvolutionChatId({
      isGroup: input.isGroup,
      groupChatId: input.groupChatId,
      phoneNumber: input.phoneNumber,
    });
  },

  isConfigured(): boolean {
    return getEvolutionClient() !== null;
  },

  codes: {
    notConfigured: "evolution_not_configured",
    sendFailed: "evolution_error",
    unknownError: "evolution_unknown",
  },

  async checkHealth(input: { sessionRef: string }): Promise<ChannelHealth> {
    const client = getEvolutionClient();
    if (!client) return { reachable: false, status: null, detail: "transporte_nao_configurado" };
    try {
      const state = await client.getConnectionState(input.sessionRef);
      return { reachable: true, status: state, detail: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "erro_desconhecido";
      return { reachable: false, status: null, detail: msg.slice(0, 200) };
    }
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    const client = getEvolutionClient();
    // Sem env configurado o comportamento é NOOP, não erro — mesma regra do
    // adapter WAHA: a UI mostra o banner de canal não configurado.
    if (!client) return { externalId: null };

    if (envelope.media) {
      const mediatype = mediatypeDoEnvelope(envelope.kind);
      const res = await client.sendMedia(envelope.sessionRef, envelope.to, {
        mediatype,
        media: envelope.media.url,
        caption: envelope.body,
      });
      return { externalId: parseEvolutionMessageId(res) };
    }

    const res = await client.sendText(envelope.sessionRef, envelope.to, envelope.body ?? "");
    return { externalId: parseEvolutionMessageId(res) };
  },
};

function mediatypeDoEnvelope(kind: string): "image" | "video" | "document" | "audio" {
  switch (kind) {
    case "image":
      return "image";
    case "video":
      return "video";
    case "audio":
    case "voice":
      return "audio";
    default:
      return "document";
  }
}
```

⚠️ **Confira o shape de `OutboundMedia`** (`lib/waha/media-send.ts`, tipo reexportado por
`lib/channels/types.ts`) antes deste step — o acesso a `envelope.media.url` acima assume
que o campo se chama `url`; se o tipo real usar outro nome (`sourceUrl`, `path`), ajuste
aqui. Se `OutboundMedia` não trouxer uma URL utilizável diretamente (por exemplo, exigir
download prévio dos bytes do CRM antes de mandar), este `send` para mídia precisa buscar
os bytes e codificar em base64 antes de chamar `sendMedia` — a Evolution API aceita
`media` como URL pública OU base64; ajuste conforme o que `OutboundMedia` realmente
carrega.

- [ ] **Step 4: Registrar o adapter em `lib/channels/index.ts`**

```ts
import { evolutionAdapter } from "./adapters/evolution";
import { metaCloudAdapter } from "./adapters/meta-cloud";
import { wahaAdapter } from "./adapters/waha";
import { zernioAdapter } from "./adapters/zernio";
import type { ChannelAdapter, ChannelProvider } from "./types";

const ADAPTERS: Record<ChannelProvider, ChannelAdapter | null> = {
  waha: wahaAdapter,
  meta_cloud: metaCloudAdapter,
  zernio: zernioAdapter,
  evolution: evolutionAdapter,
};
```

- [ ] **Step 5: Estender `ChannelSessionRef` em `lib/channels/session-ref.ts`**

```ts
export type ChannelSessionRef =
  | { provider: "waha"; waha_session_name: string }
  | { provider: "meta_cloud"; meta_phone_number_id: string }
  | { provider: "zernio"; zernio_account_id: string }
  | { provider: "evolution"; evolution_instance_name: string };

export const CHANNEL_SESSION_REF_COLUMNS =
  "provider, waha_session_name, meta_phone_number_id, zernio_account_id, evolution_instance_name";

export function resolveSessionRef(session: ChannelSessionRef): string {
  switch (session.provider) {
    case "meta_cloud":
      return session.meta_phone_number_id;
    case "waha":
      return session.waha_session_name;
    case "zernio":
      return session.zernio_account_id;
    case "evolution":
      return session.evolution_instance_name;
  }
}
```

- [ ] **Step 6: Rodar e confirmar que os testes passam**

Run: `pnpm vitest run lib/channels/adapters/evolution.test.ts`
Expected: PASS

Run: `pnpm typecheck`
Expected: PASS — confirme que `resolveSessionRef` continua exaustivo (TypeScript acusa em
compilação se faltar um `case`, já que não há `default` nesta função).

- [ ] **Step 7: Rodar o lint de canais**

Run: `pnpm lint:channels`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/channels/adapters/evolution.ts lib/channels/adapters/evolution.test.ts lib/channels/index.ts lib/channels/session-ref.ts
git commit -m "feat(evolution): ChannelAdapter completo, registrado no seam"
```

---

### Task 10: Conectar via QR — `lib/channels/qr.ts` + rota + criação de sessão

**Files:**
- Create: `lib/channels/qr.ts`
- Modify: `app/api/v1/channel-sessions/[id]/qr/route.ts`
- Modify: `app/api/v1/channel-sessions/route.ts`
- Modify: `lib/schemas/channels.ts`
- Test: `lib/channels/qr.test.ts`

**Interfaces:**
- Produces: `fetchQrImage(session: { provider: string; waha_session_name: string | null; evolution_instance_name: string | null }): Promise<QrImageResult>`.

Esta task toca dois arquivos que já estão na lista de dívida do `lint:channels`
("Superfície de TRANSPORTE do provider legado"). Extrair a lógica de QR para
`lib/channels/qr.ts` **reduz** a menção a nomes de provider nesses dois arquivos (bônus:
não é objetivo desta task remover a entrada da lista de dívida, mas não se surpreenda se o
`pnpm lint:channels` já passar sem precisar de entrada nova — confirme no Step 6).

- [ ] **Step 1: Escrever o teste (falhando) de `fetchQrImage`**

```ts
// lib/channels/qr.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchQrImage } from "./qr";

describe("fetchQrImage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("waha: 503 quando WAHA não está configurado", async () => {
    vi.stubEnv("WAHA_API_BASE_URL", "");
    vi.stubEnv("WAHA_API_KEY", "");
    const r = await fetchQrImage({ provider: "waha", waha_session_name: "org_1", evolution_instance_name: null });
    expect(r).toEqual({ ok: false, status: 503 });
  });

  it("evolution: 503 quando Evolution API não está configurado", async () => {
    vi.stubEnv("EVOLUTION_API_BASE_URL", "");
    vi.stubEnv("EVOLUTION_API_KEY", "");
    const r = await fetchQrImage({ provider: "evolution", waha_session_name: null, evolution_instance_name: "org_1" });
    expect(r).toEqual({ ok: false, status: 503 });
  });

  it("provider desconhecido: 409", async () => {
    const r = await fetchQrImage({ provider: "meta_cloud", waha_session_name: null, evolution_instance_name: null });
    expect(r).toEqual({ ok: false, status: 409 });
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `pnpm vitest run lib/channels/qr.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar `lib/channels/qr.ts`**

```ts
/**
 * Proxy do QR de conexão — o único lugar que sabe QUAL provider mostra QR e
 * como buscar a imagem dele. Existe para a rota `channel-sessions/[id]/qr`
 * não precisar perguntar "qual canal é" (invariante 1 da doutrina).
 */
import { getEvolutionClient } from "@/lib/evolution/client";
import { getWahaClient } from "@/lib/waha/client";

export type QrImageResult =
  | { ok: true; contentType: string; body: ArrayBuffer }
  | { ok: false; status: number };

export interface QrSessionInput {
  provider: string;
  waha_session_name: string | null;
  evolution_instance_name: string | null;
}

export async function fetchQrImage(session: QrSessionInput): Promise<QrImageResult> {
  if (session.provider === "waha") {
    if (!session.waha_session_name) return { ok: false, status: 409 };
    const baseUrl = process.env.WAHA_API_BASE_URL;
    const apiKey = process.env.WAHA_API_KEY;
    if (!baseUrl || !apiKey || apiKey === "dev_plaintext_change_me") return { ok: false, status: 503 };
    const upstream = await fetch(
      `${baseUrl}/api/${encodeURIComponent(session.waha_session_name)}/auth/qr?format=image`,
      { headers: { "X-Api-Key": apiKey }, cache: "no-store" },
    );
    if (!upstream.ok) return { ok: false, status: upstream.status };
    return {
      ok: true,
      contentType: upstream.headers.get("content-type") ?? "image/png",
      body: await upstream.arrayBuffer(),
    };
  }

  if (session.provider === "evolution") {
    if (!session.evolution_instance_name) return { ok: false, status: 409 };
    const client = getEvolutionClient();
    if (!client) return { ok: false, status: 503 };
    const { base64 } = await client.getQr(session.evolution_instance_name);
    if (!base64) return { ok: false, status: 404 };
    // `base64` é uma data URL (`data:image/png;base64,AAAA...`) — decodifica
    // para o mesmo formato binário que o caminho do WAHA devolve, para a rota
    // não precisar saber a diferença.
    const [prefix, dados] = base64.split(",");
    const contentType = prefix?.match(/data:(.*);base64/)?.[1] ?? "image/png";
    const binario = Buffer.from(dados ?? "", "base64");
    return { ok: true, contentType, body: binario.buffer.slice(binario.byteOffset, binario.byteOffset + binario.byteLength) };
  }

  // Provider sem QR (meta_cloud, zernio — conectam por credencial, não por
  // pareamento). Ver a instância de `getWahaClient` acima: só existe para
  // deixar o import usado sem quebrar tree-shaking em builds estritos.
  void getWahaClient;
  return { ok: false, status: 409 };
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `pnpm vitest run lib/channels/qr.test.ts`
Expected: PASS

- [ ] **Step 5: Reescrever `app/api/v1/channel-sessions/[id]/qr/route.ts` para usar `fetchQrImage`**

Leia o arquivo inteiro primeiro (já lido durante a exploração deste plano — 105 linhas).
Troque o bloco final (a partir de `const baseUrl = process.env.WAHA_API_BASE_URL;`, hoje
nas linhas ~81-104) e ajuste a query de `select` para trazer as duas colunas de sessão:

```ts
  const buscar = (colunas: string) =>
    supabase
      .from("channel_sessions")
      .select(colunas)
      .eq("organization_id", activeOrg.orgId)
      .eq("id", id)
      .maybeSingle();
  const { data: sessionRaw } = await queryTolerantToMissingArchived(
    () => buscar(`provider, waha_session_name, evolution_instance_name, ${ARCHIVED_AT}`),
    () => buscar("provider, waha_session_name, evolution_instance_name"),
  );
  const session = sessionRaw as {
    provider: string;
    waha_session_name: string | null;
    evolution_instance_name: string | null;
    archived_at?: string | null;
  } | null;
  if (!session) return new NextResponse(null, { status: 404 });
  if (session.archived_at) {
    return new NextResponse(null, { status: 409, headers: { "x-channel-state": "archived" } });
  }

  const qr = await fetchQrImage(session);
  if (!qr.ok) return new NextResponse(null, { status: qr.status });
  return new NextResponse(qr.body, {
    status: 200,
    headers: { "content-type": qr.contentType, "cache-control": "no-store, max-age=0" },
  });
```

Adicione o import: `import { fetchQrImage } from "@/lib/channels/qr";` e remova o bloco
antigo que checava `session.waha_session_name` sozinho e fazia `fetch` direto ao WAHA (a
checagem de "canal oficial não pareia por QR" agora é coberta pelo `409` que
`fetchQrImage` devolve para provider sem QR).

- [ ] **Step 6: Rodar o lint de canais**

Run: `pnpm lint:channels`
Expected: PASS. Se reprovar dizendo que `evolution` aparece num arquivo fora de
`lib/channels/`/`lib/evolution/`, confira se sobrou alguma referência literal a
`"evolution"` na rota (não deveria: `fetchQrImage` recebe `session.provider` como string
genérica, a rota nunca escreve o literal `"evolution"`).

- [ ] **Step 7: Estender `createChannelSchema` para aceitar `provider`**

Em `lib/schemas/channels.ts`:

```ts
export const createChannelSchema = z.object({
  display_name: z.string().trim().min(1).max(80).optional(),
  // Default "waha" preserva o comportamento de quem já chama esta rota sem o
  // campo — nenhum cliente existente quebra.
  provider: z.enum(["waha", "evolution"]).optional().default("waha"),
});
```

- [ ] **Step 8: Ramificar a criação da sessão em `app/api/v1/channel-sessions/route.ts`**

Releia o `POST` inteiro (já lido na exploração — linhas 59-141) antes de editar. Adicione
o import `import { getEvolutionClient } from "@/lib/evolution/client";` e substitua o
bloco que hoje assume WAHA sempre:

```ts
  const parsed = createChannelSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const provider = parsed.data.provider;

  const waha = provider === "waha" ? getWahaClient() : null;
  const evolution = provider === "evolution" ? getEvolutionClient() : null;
  if (provider === "waha" && !waha) {
    return fail(
      "waha_not_configured",
      "O WhatsApp (WAHA) não está configurado neste ambiente: faltam WAHA_API_BASE_URL e/ou WAHA_API_KEY. Configure-as e tente de novo.",
      503,
      { requestId },
    );
  }
  if (provider === "evolution" && !evolution) {
    return fail(
      "evolution_not_configured",
      "O Evolution API não está configurado neste ambiente: faltam EVOLUTION_API_BASE_URL e/ou EVOLUTION_API_KEY.",
      503,
      { requestId },
    );
  }

  const supabase = await createClient();
  const sessionName = `org_${activeOrg.orgId.slice(0, 8)}_${randomUUID().replace(/-/g, "").slice(0, 6)}`;

  const { data: created, error: insErr } = await supabase
    .from("channel_sessions")
    .insert({
      organization_id: activeOrg.orgId,
      provider,
      ...(provider === "waha" ? { waha_session_name: sessionName, engine: "NOWEB" } : {}),
      ...(provider === "evolution" ? { evolution_instance_name: sessionName } : {}),
      display_name: parsed.data.display_name ?? null,
      webhook_path_token: randomUUID().replace(/-/g, ""),
      webhook_secret_encrypted: Buffer.from([0]),
      status: "STARTING",
      last_status_change_at: new Date().toISOString(),
      consecutive_health_fails: 0,
      daily_message_limit: 250,
      metadata: {},
    })
    .select(CHANNEL_COLUMNS)
    .single();
  if (insErr || !created) {
    return fail("internal_error", insErr?.message ?? "channel_session_insert_failed", 500, { requestId });
  }

  try {
    if (provider === "waha" && waha) await waha.startSession(sessionName);
    if (provider === "evolution" && evolution) {
      await evolution.createInstance(sessionName);
      const proto = process.env.NEXT_PUBLIC_APP_URL ?? "";
      await evolution.configureWebhook(
        sessionName,
        `${proto}/api/v1/webhooks/channel/${created.webhook_path_token}`,
      );
    }
  } catch (err) {
    await supabase
      .from("channel_sessions")
      .delete()
      .eq("organization_id", activeOrg.orgId)
      .eq("id", created.id);
    const msg = err instanceof Error ? err.message : "erro_desconhecido";
    return fail(provider === "waha" ? "waha_error" : "evolution_error", msg, 502, { requestId });
  }
```

⚠️ **Confira se `CHANNEL_COLUMNS` (linha ~24 do arquivo) precisa incluir
`evolution_instance_name` e `provider`** — releia a constante antes de editar; se a tela
de conexões (`ConnectionsClient.tsx`) depende dela para exibir o canal, a coluna nova
precisa entrar no `select`, senão a tela criada não mostra qual provider é.

⚠️ **Confira se existe `NEXT_PUBLIC_APP_URL` (ou equivalente) já usado em outro lugar do
repo** para montar URLs absolutas de webhook — grep por `NEXT_PUBLIC_APP_URL` antes de
inventar o nome; use a variável que já existe.

- [ ] **Step 9: Rodar typecheck, lint de canais e os testes já escritos**

Run: `pnpm typecheck && pnpm lint:channels`
Expected: PASS.

Se `pnpm lint:channels` reprovar `app/api/v1/channel-sessions/route.ts` por causa das
strings novas (`"evolution_not_configured"`, `"evolution_error"`, o literal `"evolution"`
no branch), adicione uma entrada nova a `KNOWN_DEBT` em `scripts/lint-channels.ts`, no
mesmo grupo onde `app/api/v1/channel-sessions/route.ts` já aparece para o WAHA, com a
razão: "Rota de criação de sessão já é per-provider por natureza (cria a sessão do
transporte escolhido) — mesma classificação do WAHA que já está aqui."

- [ ] **Step 10: Commit**

```bash
git add lib/channels/qr.ts lib/channels/qr.test.ts app/api/v1/channel-sessions/[id]/qr/route.ts app/api/v1/channel-sessions/route.ts lib/schemas/channels.ts scripts/lint-channels.ts
git commit -m "feat(evolution): conectar via QR — criação de instância e proxy de QR genéricos"
```

---

### Task 11: UI — seletor de provider na tela de Conexões

**Files:**
- Modify: `components/connections/ConnectionsClient.tsx`
- Modify: `lib/channels/connect.ts` (ou onde já vivem `PARTNER_CHANNEL_LABEL` etc. —
  confirme com `Grep` por `PARTNER_CHANNEL_LABEL` antes de decidir onde adicionar)

**Interfaces:**
- Produces: constante `EVOLUTION_CHANNEL_LABEL = "Evolution API"` exportada de
  `lib/channels/` (não de dentro do componente — copy de provider é nome dado, mora onde
  nomear é permitido, mesmo padrão de `PARTNER_CHANNEL_LABEL` para o Zernio).

- [ ] **Step 1: Ler `components/connections/ConnectionsClient.tsx` inteiro**

Este arquivo já está em `KNOWN_DEBT` (nomeia "waha" na cópia visível). Leia-o por completo
antes de editar para entender como a tela hoje decide o que mostrar (provavelmente sempre
assume WAHA, já que hoje só existe um provider QR).

- [ ] **Step 2: Adicionar a label e o export em `lib/channels/capabilities.ts`**

Junto de `CHANNEL_PROVIDER_EVOLUTION` (Task 1):

```ts
/** Nome comercial do canal, para o usuário. Mora aqui pelo mesmo motivo de PARTNER_CHANNEL_LABEL. */
export const CHANNEL_LABELS: Record<ChannelProvider, string> = {
  waha: "WhatsApp (QR)",
  meta_cloud: "WhatsApp Oficial (Meta)",
  zernio: "Zernio",
  evolution: "Evolution API",
};
```

(Se `lib/channels/capabilities.test.ts` da Task 1 checa `Object.keys(CHANNEL_CAPABILITIES)`
igual a `["evolution","meta_cloud","waha","zernio"]`, adicione um teste irmão para
`CHANNEL_LABELS` com a mesma asserção de chaves.)

- [ ] **Step 3: Adicionar o seletor de provider na criação de canal**

No componente que hoje chama `POST /api/v1/channel-sessions` (localize com `Grep` por
`channel-sessions"` dentro de `components/connections/`), adicione um campo de escolha
(rádio ou select) entre `"waha"` e `"evolution"`, usando `CHANNEL_LABELS` importado de
`@/lib/channels` para os rótulos, e inclua `provider` no corpo do POST. Não escreva
`"Evolution API"` como string literal no componente — importe `CHANNEL_LABELS.evolution`.

Como o componente exato e seu estado interno variam conforme o que o Step 1 revelar,
implemente seguindo o padrão de formulário já usado no restante do arquivo (mesma
biblioteca de form, mesmo estilo de submit) em vez de introduzir um padrão novo.

- [ ] **Step 4: Rodar o lint de canais**

Run: `pnpm lint:channels`
Expected: PASS — `CHANNEL_LABELS.evolution` é lido de dentro de `lib/channels/`, o
componente nunca escreve o literal.

- [ ] **Step 5: Testar manualmente no browser (doutrina de QA Visual)**

Suba o dev server (`pnpm dev`), acesse a tela de Conexões autenticado, e confirme
visualmente:
- o seletor mostra as duas opções com os rótulos de `CHANNEL_LABELS`;
- escolher "Evolution API" e submeter cria a sessão (confira no Supabase Studio que
  `channel_sessions.provider = 'evolution'` e `evolution_instance_name` preenchido);
- o QR aparece (usa `EVOLUTION_API_BASE_URL`/`EVOLUTION_API_KEY` reais, apontando pra
  instância do dono do produto).

Isto é o critério de aceite da doutrina de QA Visual — `curl` não conta. Anote no PR
qualquer divergência encontrada entre o shape assumido nas Tasks 4/6 e a resposta real da
instância.

- [ ] **Step 6: Commit**

```bash
git add components/connections/ConnectionsClient.tsx lib/channels/capabilities.ts lib/channels/capabilities.test.ts
git commit -m "feat(evolution): seletor de provider na tela de Conexões"
```

---

### Task 12: Suite completa — typecheck, lint, testes, `test:db`

**Files:** nenhum arquivo novo — task de verificação.

- [ ] **Step 1: Suite completa**

Run: `pnpm gov:verify` (= `pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit`)
Expected: PASS.

- [ ] **Step 2: Invariantes de banco**

Run: `pnpm test:db`
Expected: PASS — inclui o teste de isolamento RLS entre 2 organizações, exercitado contra
o `baseline.sql` com o apêndice da Task 2 já aplicado.

- [ ] **Step 3: Sabotar e confirmar que os testes pegam a regressão**

Escolha UM teste central (sugestão: `lib/evolution/ingest.test.ts`, caso "reentrega
23505"), comente temporariamente o `if (error?.code === "23505") return "duplicate";` em
`lib/evolution/ingest.ts`, rode `pnpm vitest run lib/evolution/ingest.test.ts` e confirme
que ele FALHA. Desfaça o comentário e rode de novo para confirmar que volta a passar. Isto
prova que o teste guarda o comportamento — verde de teste sem essa checagem não é prova de
nada (doutrina do `CLAUDE.md`).

- [ ] **Step 4: Commit (se algo precisou de ajuste nesta task)**

```bash
git add -A
git commit -m "test(evolution): fecha a suíte completa (gov:verify + test:db)"
```

(Pule este commit se nada mudou — as tasks anteriores já deixaram tudo verde.)

---

## Self-Review (já aplicado ao escrever este plano)

- **Cobertura da spec:** arquitetura (Tasks 1, 9), banco (Task 2), config (Task 3), código
  novo (Tasks 4-7), webhook (Task 8), UI (Tasks 10-11), testes (Task 12) — todas as seções
  da spec têm task correspondente. Fora de escopo (Docker Swarm, provisionamento do
  Evolution API, foto de perfil, LID, templates) permanece fora, conforme decidido.
- **Placeholders:** nenhum "TBD"/"implementar depois" — os únicos pontos marcados como
  "a confirmar" (shape exato do REST/webhook da instância real) vêm com código completo e
  executável contra o contrato documentado da Evolution API v2, e uma instrução explícita
  de onde ajustar se a instância real divergir — não são lacunas, são a mesma ressalva já
  registrada na spec.
- **Consistência de tipos:** `EvolutionInboundMessage` (Task 6) é o mesmo tipo consumido em
  `ingest.ts` (Task 7); `ChannelSessionRef` (Task 9) e `QrSessionInput` (Task 10) usam os
  mesmos nomes de coluna (`evolution_instance_name`) definidos na migration (Task 2);
  `fetchQrImage`/`EvolutionClient.getQr`/`sendText`/`sendMedia` mantêm assinatura estável
  entre as tasks que os chamam.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-18-evolution-api-channel.md`.
Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between
tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch
execution with checkpoints.

Which approach?
