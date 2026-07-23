# Onda 0 — Fundação de Mídia (Inbox Multimodal) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Toda mídia inbound do WhatsApp passa a ser baixada do WAHA e persistida no Supabase Storage (bucket `whatsapp-media`), com endpoint autenticado de acesso via signed URL — a fundação das ondas 1-3 do épico.

**Architecture:** A ingestão (`lib/waha/ingest.ts`) continua leve e passa a emitir `media.persist_requested` no `event_log`; um handler novo (registrado em `register-handlers.ts`, drenado pelo cron `event-log-drain`) baixa o binário via `MediaSource` (implementação WAHA; interface pronta pra Meta Cloud API) e sobe pro bucket privado, preenchendo `media_storage_path`/`media_size_bytes`. O frontend acessa via `GET /api/v1/messages/[id]/media` → 302 pra signed URL (fallback: proxy do WAHA na janela antes da persistência).

**Tech Stack:** Next.js 16 Route Handlers, Supabase (Storage + event_log), Vitest, Playwright (prova).

## Global Constraints

- Spec mestre: `docs/superpowers/specs/2026-07-21-inbox-multimodal-design.md` (Onda 0).
- Migration: arquivo versionado `supabase/migrations/<ts>_0054_whatsapp_media_bucket.sql` **+** apêndice idempotente no `supabase/baseline.sql` **+** linha no `supabase/migrations/MANIFEST.md`.
- Nunca HTTP em trigger Postgres; side effect só via `event_log` + worker.
- Admin client (service role) sempre filtra `organization_id` manualmente.
- Nada de `console.log` novo em código de produção (usar `logger` de `@/lib/logger`; `console.error` já é padrão aceito em `ingest.ts` — seguir o padrão local do arquivo).
- Prova final OBRIGATÓRIA com Playwright em conta real; handoff `HANDOFF-inbox-multimodal.md` atualizado + commitado a cada task concluída.
- Validação nunca via `cmd | tail` (mascara exit code).
- Limite de mídia: **50 MB** (`MAX_MEDIA_BYTES = 52_428_800`). TTL da signed URL: **3600s**.
- Bucket: `whatsapp-media`, privado. Path canônico: `{organization_id}/{conversation_id}/{message_id}.{ext}`.

---

### Task 1: Migration 0054 — bucket `whatsapp-media`

**Files:**
- Create: `supabase/migrations/20260721120000_0054_whatsapp_media_bucket.sql`
- Modify: `supabase/baseline.sql` (apêndice no fim)
- Modify: `supabase/migrations/MANIFEST.md` (linha na tabela Applied)

**Interfaces:**
- Produces: bucket `whatsapp-media` (privado, limite 50MB) existente em qualquer banco (fresh install e update).

- [ ] **Step 1: Criar a migration**

```sql
-- 0054: bucket privado whatsapp-media — binários de mídia do WhatsApp
-- (Onda 0 do épico inbox-multimodal). O acesso é exclusivamente via service
-- role (upload pelo worker, signed URL pelo endpoint) — sem policies de
-- storage.objects para anon/authenticated.
insert into storage.buckets (id, name, public, file_size_limit)
values ('whatsapp-media', 'whatsapp-media', false, 52428800)
on conflict (id) do update set file_size_limit = excluded.file_size_limit;
```

- [ ] **Step 2: Apêndice idempotente no `supabase/baseline.sql`**

Adicionar AO FIM do arquivo, no padrão dos apêndices existentes:

```sql
-- ---- bucket whatsapp-media (migration 0054) ----
insert into storage.buckets (id, name, public, file_size_limit)
values ('whatsapp-media', 'whatsapp-media', false, 52428800)
on conflict (id) do update set file_size_limit = excluded.file_size_limit;
```

- [ ] **Step 3: Linha no MANIFEST**

Em `supabase/migrations/MANIFEST.md`, tabela "Applied", adicionar:

```markdown
| 0054 | 20260721120000_0054_whatsapp_media_bucket | Bucket privado `whatsapp-media` (50MB) p/ persistir binários de mídia do WhatsApp (Onda 0 inbox-multimodal). |
```

- [ ] **Step 4: Aplicar e provar**

Aplicar via `mcp__plugin_supabase_supabase__apply_migration` (ou `supabase db push`). Provar com SQL:

```sql
select id, public, file_size_limit from storage.buckets where id = 'whatsapp-media';
```

Expected: 1 linha, `public = false`, `file_size_limit = 52428800`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260721120000_0054_whatsapp_media_bucket.sql supabase/baseline.sql supabase/migrations/MANIFEST.md
git commit -m "feat(media): migration 0054 — bucket privado whatsapp-media"
```

---

### Task 2: Tipos canônicos de mídia (`lib/messaging/media/types.ts`)

**Files:**
- Create: `lib/messaging/media/types.ts`
- Test: `tests/unit/media-types.test.ts`

**Interfaces:**
- Produces:
  - `interface FetchedMedia { buffer: Buffer; mime: string }`
  - `extFromMime(mime: string): string`
  - `storagePathFor(orgId: string, conversationId: string, messageId: string, mime: string): string`
  - `MAX_MEDIA_BYTES: number` (52_428_800)
  - `class MediaTooLargeError extends Error`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/unit/media-types.test.ts
import { describe, expect, it } from "vitest";

import {
  extFromMime,
  storagePathFor,
  MAX_MEDIA_BYTES,
} from "@/lib/messaging/media/types";

describe("extFromMime", () => {
  it("mapeia mimes comuns do WhatsApp", () => {
    expect(extFromMime("image/jpeg")).toBe("jpg");
    expect(extFromMime("image/png")).toBe("png");
    expect(extFromMime("image/webp")).toBe("webp"); // figurinhas
    expect(extFromMime("video/mp4")).toBe("mp4");
    expect(extFromMime("audio/ogg; codecs=opus")).toBe("ogg"); // PTT
    expect(extFromMime("audio/mpeg")).toBe("mp3");
    expect(extFromMime("application/pdf")).toBe("pdf");
  });
  it("cai em bin para mime desconhecido", () => {
    expect(extFromMime("application/x-unknown")).toBe("bin");
    expect(extFromMime("")).toBe("bin");
  });
});

describe("storagePathFor", () => {
  it("monta o path canônico org/conversa/mensagem.ext", () => {
    expect(storagePathFor("org1", "conv2", "msg3", "image/jpeg")).toBe("org1/conv2/msg3.jpg");
  });
});

describe("MAX_MEDIA_BYTES", () => {
  it("é 50MB", () => {
    expect(MAX_MEDIA_BYTES).toBe(52_428_800);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/unit/media-types.test.ts`
Expected: FAIL (módulo `@/lib/messaging/media/types` não existe).

- [ ] **Step 3: Implementar**

```ts
// lib/messaging/media/types.ts
/**
 * Tipos canônicos de mídia do messaging — camada provider-agnóstica.
 * Hoje só o WAHA produz mídia; a Meta Cloud API (futura) implementa a mesma
 * interface de fetch e o resto do sistema não muda (spec Onda 0).
 */

export const MAX_MEDIA_BYTES = 52_428_800; // 50MB — espelha file_size_limit do bucket

export interface FetchedMedia {
  buffer: Buffer;
  mime: string;
}

export class MediaTooLargeError extends Error {
  constructor() {
    super(`media exceeds ${MAX_MEDIA_BYTES} bytes`);
    this.name = "MediaTooLargeError";
  }
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "application/pdf": "pdf",
};

export function extFromMime(mime: string): string {
  const base = (mime ?? "").split(";")[0].trim().toLowerCase();
  return MIME_EXT[base] ?? "bin";
}

/** Path canônico no bucket whatsapp-media: {org}/{conversa}/{mensagem}.{ext} */
export function storagePathFor(
  orgId: string,
  conversationId: string,
  messageId: string,
  mime: string,
): string {
  return `${orgId}/${conversationId}/${messageId}.${extFromMime(mime)}`;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/unit/media-types.test.ts`
Expected: PASS (todos).

- [ ] **Step 5: Commit**

```bash
git add lib/messaging/media/types.ts tests/unit/media-types.test.ts
git commit -m "feat(media): tipos canônicos de mídia (extFromMime, storagePathFor)"
```

---

### Task 3: MediaSource do WAHA (`lib/messaging/media/waha-source.ts`)

**Files:**
- Create: `lib/messaging/media/waha-source.ts`
- Test: `tests/unit/media-waha-source.test.ts`

**Interfaces:**
- Consumes: `FetchedMedia`, `MAX_MEDIA_BYTES`, `MediaTooLargeError` de `@/lib/messaging/media/types`.
- Produces: `fetchWahaMedia(mediaUrl: string, hintMime?: string | null): Promise<FetchedMedia>`. Lança `Error("waha_media_untrusted_host")` se o host da URL não bate com `WAHA_API_BASE_URL`, `Error("waha_media_<status>")` em HTTP não-2xx, `MediaTooLargeError` acima de 50MB.

- [ ] **Step 1: Escrever os testes que falham**

```ts
// tests/unit/media-waha-source.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchWahaMedia } from "@/lib/messaging/media/waha-source";
import { MediaTooLargeError } from "@/lib/messaging/media/types";

const WAHA_BASE = "http://localhost:3030";

describe("fetchWahaMedia", () => {
  beforeEach(() => {
    vi.stubEnv("WAHA_API_BASE_URL", WAHA_BASE);
    vi.stubEnv("WAHA_API_KEY", "hash123");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("baixa a mídia com X-Api-Key e retorna buffer + mime", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(bytes, { status: 200, headers: { "content-type": "image/jpeg" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const media = await fetchWahaMedia(`${WAHA_BASE}/api/files/abc.jpg`);
    expect(media.mime).toBe("image/jpeg");
    expect(media.buffer.byteLength).toBe(3);
    expect(fetchMock).toHaveBeenCalledWith(
      `${WAHA_BASE}/api/files/abc.jpg`,
      expect.objectContaining({ headers: { "X-Api-Key": "hash123" } }),
    );
  });

  it("recusa host fora do WAHA_API_BASE_URL (anti-SSRF)", async () => {
    await expect(fetchWahaMedia("http://evil.example.com/x.jpg")).rejects.toThrow(
      "waha_media_untrusted_host",
    );
  });

  it("propaga status HTTP de erro", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    await expect(fetchWahaMedia(`${WAHA_BASE}/api/files/gone.jpg`)).rejects.toThrow(
      "waha_media_404",
    );
  });

  it("rejeita mídia acima de 50MB", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new ArrayBuffer(8), {
          status: 200,
          headers: { "content-type": "video/mp4", "content-length": String(60 * 1024 * 1024) },
        }),
      ),
    );
    await expect(fetchWahaMedia(`${WAHA_BASE}/api/files/big.mp4`)).rejects.toThrow(
      MediaTooLargeError,
    );
  });

  it("usa hintMime quando o content-type vem vazio", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(new ArrayBuffer(2), { status: 200 })),
    );
    const media = await fetchWahaMedia(`${WAHA_BASE}/api/files/x`, "audio/ogg; codecs=opus");
    expect(media.mime).toBe("audio/ogg; codecs=opus");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/unit/media-waha-source.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar**

```ts
// lib/messaging/media/waha-source.ts
/**
 * MediaSource do WAHA: baixa o binário hospedado pelo container WAHA.
 * O webhook HMAC é best-effort, então o host da mediaUrl É validado contra
 * WAHA_API_BASE_URL (anti-SSRF: payload forjado não faz o worker buscar
 * URL arbitrária). A futura MetaMediaSource implementa a mesma assinatura
 * baixando via media_id + Graph API.
 */
import {
  MAX_MEDIA_BYTES,
  MediaTooLargeError,
  type FetchedMedia,
} from "@/lib/messaging/media/types";

const FETCH_TIMEOUT_MS = 30_000;

export async function fetchWahaMedia(
  mediaUrl: string,
  hintMime?: string | null,
): Promise<FetchedMedia> {
  const base = process.env.WAHA_API_BASE_URL;
  const url = new URL(mediaUrl);
  if (!base || url.host !== new URL(base).host) {
    throw new Error("waha_media_untrusted_host");
  }

  const apiKey = process.env.WAHA_API_KEY;
  const res = await fetch(mediaUrl, {
    headers: apiKey ? { "X-Api-Key": apiKey } : {},
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`waha_media_${res.status}`);

  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_MEDIA_BYTES) throw new MediaTooLargeError();

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > MAX_MEDIA_BYTES) throw new MediaTooLargeError();

  const mime = res.headers.get("content-type") || hintMime || "application/octet-stream";
  return { buffer, mime };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/unit/media-waha-source.test.ts`
Expected: PASS (5 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/messaging/media/waha-source.ts tests/unit/media-waha-source.test.ts
git commit -m "feat(media): MediaSource do WAHA com anti-SSRF e cap de 50MB"
```

---

### Task 4: Worker de persistência (`media.persist_requested`)

**Files:**
- Create: `workers/media-persist-worker.ts`
- Create: `workers/media-persist-worker.handler.ts`
- Modify: `lib/event-log/register-handlers.ts`
- Test: `tests/unit/media-persist-worker.test.ts`

**Interfaces:**
- Consumes: `fetchWahaMedia` (Task 3), `storagePathFor`/`MediaTooLargeError` (Task 2), `EventHandler`/`EventRow`/`HandlerResult` de `@/lib/event-log/dispatcher`, `createAdminClient` de `@/lib/supabase/admin`.
- Produces: `persistMessageMedia(row: EventRow): Promise<HandlerResult>` e `mediaPersistHandler: EventHandler` (key `"media_persist_v1"`, events `["media.persist_requested"]`). Efeito: `messages.media_storage_path`, `media_size_bytes`, `media_mime` preenchidos e `metadata.media_status = "stored"` (ou `"failed"` após 5 tentativas).

- [ ] **Step 1: Escrever os testes que falham**

```ts
// tests/unit/media-persist-worker.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadMock = vi.fn();
const updateEqMock = vi.fn();
const messageRow = {
  id: "msg1",
  organization_id: "org1",
  conversation_id: "conv1",
  media_url: "http://localhost:3030/api/files/abc.jpg",
  media_mime: "image/jpeg",
  media_storage_path: null as string | null,
  metadata: { raw_type: "image" },
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: messageRow, error: null }) }),
        }),
      }),
      update: (patch: Record<string, unknown>) => {
        updateEqMock(patch);
        return { eq: () => ({ eq: async () => ({ error: null }) }) };
      },
    }),
    storage: { from: () => ({ upload: uploadMock }) },
  }),
}));

vi.mock("@/lib/messaging/media/waha-source", () => ({
  fetchWahaMedia: vi.fn(async () => ({ buffer: Buffer.from([1, 2, 3]), mime: "image/jpeg" })),
}));

import { persistMessageMedia } from "@/workers/media-persist-worker";
import { fetchWahaMedia } from "@/lib/messaging/media/waha-source";

function eventRow(attempts = 0) {
  return {
    id: "ev1",
    organization_id: "org1",
    event_type: "media.persist_requested",
    entity_kind: "message",
    entity_id: "msg1",
    payload: { message_id: "msg1" },
    metadata: {},
    consumed_by: [],
    attempts,
  };
}

describe("persistMessageMedia", () => {
  beforeEach(() => {
    uploadMock.mockReset().mockResolvedValue({ error: null });
    updateEqMock.mockReset();
    messageRow.media_storage_path = null;
    vi.mocked(fetchWahaMedia).mockResolvedValue({
      buffer: Buffer.from([1, 2, 3]),
      mime: "image/jpeg",
    });
  });

  it("baixa, sobe pro bucket e atualiza a mensagem", async () => {
    const result = await persistMessageMedia(eventRow());
    expect(result.status).toBe("ok");
    expect(uploadMock).toHaveBeenCalledWith(
      "org1/conv1/msg1.jpg",
      expect.any(Buffer),
      expect.objectContaining({ contentType: "image/jpeg", upsert: true }),
    );
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({
        media_storage_path: "org1/conv1/msg1.jpg",
        media_size_bytes: 3,
        metadata: expect.objectContaining({ media_status: "stored" }),
      }),
    );
  });

  it("pula mensagem já persistida (idempotência)", async () => {
    messageRow.media_storage_path = "org1/conv1/msg1.jpg";
    const result = await persistMessageMedia(eventRow());
    expect(result.status).toBe("skipped");
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("agenda retry quando o download falha e attempts < 5", async () => {
    vi.mocked(fetchWahaMedia).mockRejectedValue(new Error("waha_media_503"));
    const result = await persistMessageMedia(eventRow(1));
    expect(result.status).toBe("retry");
    expect(result.retry_at).toBeTruthy();
  });

  it("marca failed na 5ª tentativa", async () => {
    vi.mocked(fetchWahaMedia).mockRejectedValue(new Error("waha_media_503"));
    const result = await persistMessageMedia(eventRow(5));
    expect(result.status).toBe("error");
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ media_status: "failed" }) }),
    );
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/unit/media-persist-worker.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar o core**

```ts
// workers/media-persist-worker.ts
/**
 * Consome `media.persist_requested`: baixa o binário da mídia (MediaSource
 * WAHA) e persiste no bucket privado `whatsapp-media`, preenchendo
 * media_storage_path/media_size_bytes na linha de `messages`.
 * Retry com backoff linear via HandlerResult (até 5 tentativas), depois
 * marca metadata.media_status = "failed" (Onda 3 poderá reprocessar).
 */
import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { storagePathFor } from "@/lib/messaging/media/types";
import { fetchWahaMedia } from "@/lib/messaging/media/waha-source";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const MEDIA_PERSIST_CONSUMER_KEY = "media_persist_v1";
const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 60_000;

interface MessageMediaRow {
  id: string;
  organization_id: string;
  conversation_id: string;
  media_url: string | null;
  media_mime: string | null;
  media_storage_path: string | null;
  metadata: Record<string, unknown> | null;
}

export async function persistMessageMedia(row: EventRow): Promise<HandlerResult> {
  const consumer_key = MEDIA_PERSIST_CONSUMER_KEY;
  const messageId = (row.payload.message_id as string | undefined) ?? row.entity_id;
  if (!messageId) return { consumer_key, status: "skipped", detail: "no message_id" };

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("messages")
    .select("id, organization_id, conversation_id, media_url, media_mime, media_storage_path, metadata")
    .eq("id", messageId)
    .eq("organization_id", row.organization_id)
    .maybeSingle();
  if (error) return { consumer_key, status: "error", detail: error.message };

  const msg = data as MessageMediaRow | null;
  if (!msg?.media_url) return { consumer_key, status: "skipped", detail: "no media_url" };
  if (msg.media_storage_path) return { consumer_key, status: "skipped", detail: "already stored" };

  const markStatus = async (media_status: "stored" | "failed", patch: Record<string, unknown> = {}) => {
    const { error: updErr } = await admin
      .from("messages")
      .update({ metadata: { ...(msg.metadata ?? {}), media_status }, ...patch })
      .eq("id", msg.id)
      .eq("organization_id", msg.organization_id);
    if (updErr) throw new Error(`message update failed: ${updErr.message}`);
  };

  let media;
  try {
    media = await fetchWahaMedia(msg.media_url, msg.media_mime);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (row.attempts < MAX_ATTEMPTS) {
      return {
        consumer_key,
        status: "retry",
        retry_at: new Date(Date.now() + RETRY_BASE_MS * (row.attempts + 1)).toISOString(),
        detail,
      };
    }
    logger.error("[media-persist] download failed permanently", { message_id: msg.id, detail });
    await markStatus("failed");
    return { consumer_key, status: "error", detail };
  }

  const path = storagePathFor(msg.organization_id, msg.conversation_id, msg.id, media.mime);
  const { error: uploadErr } = await admin.storage
    .from("whatsapp-media")
    .upload(path, media.buffer, { contentType: media.mime, upsert: true });
  if (uploadErr) return { consumer_key, status: "error", detail: uploadErr.message };

  await markStatus("stored", {
    media_storage_path: path,
    media_size_bytes: media.buffer.byteLength,
    media_mime: media.mime,
  });
  return { consumer_key, status: "ok" };
}
```

- [ ] **Step 4: Implementar o handler + registrar**

```ts
// workers/media-persist-worker.handler.ts
import type { EventHandler } from "@/lib/event-log/dispatcher";
import {
  MEDIA_PERSIST_CONSUMER_KEY,
  persistMessageMedia,
} from "@/workers/media-persist-worker";

export const mediaPersistHandler: EventHandler = {
  key: MEDIA_PERSIST_CONSUMER_KEY,
  events: ["media.persist_requested"],
  handle: persistMessageMedia,
};
```

Em `lib/event-log/register-handlers.ts`, adicionar o import e o registro (junto dos existentes):

```ts
import { mediaPersistHandler } from "@/workers/media-persist-worker.handler";
// ... dentro de ensureHandlersRegistered():
  registerHandler(mediaPersistHandler);
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx vitest run tests/unit/media-persist-worker.test.ts`
Expected: PASS (4 testes).

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add workers/media-persist-worker.ts workers/media-persist-worker.handler.ts lib/event-log/register-handlers.ts tests/unit/media-persist-worker.test.ts
git commit -m "feat(media): worker media_persist_v1 — WAHA → Supabase Storage com retry"
```

---

### Task 5: Emissão de `media.persist_requested` na ingestão

**Files:**
- Modify: `lib/waha/ingest.ts` (`handleInbound` ~L271-309; `handleOutboundFromUserPhone` ~L335-356)

**Interfaces:**
- Consumes: RPC `emit_event` (padrão já usado no arquivo).
- Produces: evento `media.persist_requested` com `payload.message_id` para TODA mensagem ingerida com `mediaUrl` (inbound e outbound-do-celular).

- [ ] **Step 1: Emitir no `handleInbound`**

Dentro do bloco `if (insertedMessage?.id) { ... }` existente (após os dois emits atuais), adicionar:

```ts
    if (p.mediaUrl) {
      admin
        .rpc("emit_event" as never, {
          p_event_type: "media.persist_requested",
          p_entity_kind: "message",
          p_entity_id: inboundMessageId,
          p_payload: { message_id: inboundMessageId, conversation_id: conversationId },
          p_metadata: { source: "waha_webhook", request_id: requestId },
          p_organization_id: session.organization_id,
        } as never)
        .then(({ error }) => {
          if (error) console.error("[waha.ingest] emit media.persist_requested failed", error.message);
        });
    }
```

- [ ] **Step 2: Emitir no `handleOutboundFromUserPhone`**

O insert atual (~L335) não retorna o id. Trocar:

```ts
  const { error: insertErr } = await admin.from("messages").insert({
```

por:

```ts
  const { data: insertedOutbound, error: insertErr } = await admin
    .from("messages")
    .insert({
```

e encadear após o objeto do insert (mesmo padrão do `handleInbound`):

```ts
    .select("id")
    .maybeSingle();
```

Após o `audit({ action: "message.sent", ... })`, adicionar:

```ts
  if (insertedOutbound?.id && p.mediaUrl) {
    admin
      .rpc("emit_event" as never, {
        p_event_type: "media.persist_requested",
        p_entity_kind: "message",
        p_entity_id: insertedOutbound.id,
        p_payload: { message_id: insertedOutbound.id, conversation_id: conversationId },
        p_metadata: { source: "waha_webhook", request_id: requestId },
        p_organization_id: session.organization_id,
      } as never)
      .then(({ error }) => {
        if (error) console.error("[waha.ingest] emit media.persist_requested failed", error.message);
      });
  }
```

- [ ] **Step 3: Typecheck + testes existentes**

```bash
npm run typecheck
npx vitest run
```

Expected: zerado / todos passam (nenhum teste existente cobre esses handlers diretamente; a prova funcional vem na Task 7).

- [ ] **Step 4: Commit**

```bash
git add lib/waha/ingest.ts
git commit -m "feat(media): ingestão emite media.persist_requested p/ mensagens com mídia"
```

---

### Task 6: Endpoint `GET /api/v1/messages/[id]/media`

**Files:**
- Create: `app/api/v1/messages/[id]/media/route.ts`

**Interfaces:**
- Consumes: `fetchWahaMedia` (Task 3), auth pattern de `app/api/v1/conversations/[id]/messages/route.ts` (`createClient` + `getUser` + `loadAuthUser`/`resolveActiveOrg`), `createAdminClient`, `fail` de `@/lib/api/wrappers`.
- Produces: contrato consumido pela Onda 1 — a UI usa `/api/v1/messages/{id}/media` DIRETO como `src` de `<img>`/`<video>`/`<audio>`: `302` → signed URL (mídia persistida), `200` bytes proxied do WAHA (janela pré-persistência), `404` sem mídia, `401/403` auth.

- [ ] **Step 1: Implementar a rota**

```ts
// app/api/v1/messages/[id]/media/route.ts
/**
 * GET /api/v1/messages/[id]/media — acesso autenticado à mídia da mensagem.
 * Persistida → 302 pra signed URL (TTL 1h) do bucket whatsapp-media.
 * Ainda não persistida (janela até o worker rodar) → proxy dos bytes do WAHA.
 * A URL desta rota é usada diretamente como src de <img>/<video>/<audio>
 * (cookie de sessão vai junto por ser same-origin; RLS decide o acesso).
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { fetchWahaMedia } from "@/lib/messaging/media/waha-source";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const SIGNED_URL_TTL_S = 3600;

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id: messageId } = await ctx.params;
  const supabase = await createClient();

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }
  const authUser = await loadAuthUser();
  const activeOrg = authUser ? await resolveActiveOrg(authUser) : null;
  if (!activeOrg) {
    return fail("no_active_org", "No active organization.", 403, { requestId });
  }

  // Client de sessão: RLS garante que a mensagem pertence a uma org do usuário.
  const { data: msg, error } = await supabase
    .from("messages")
    .select("id, media_url, media_mime, media_storage_path")
    .eq("id", messageId)
    .maybeSingle();
  if (error) {
    return fail("internal_error", "Erro ao buscar mensagem.", 500, { requestId });
  }
  if (!msg || (!msg.media_storage_path && !msg.media_url)) {
    return fail("not_found", "Mensagem sem mídia.", 404, { requestId });
  }

  if (msg.media_storage_path) {
    const admin = createAdminClient();
    const { data: signed, error: signErr } = await admin.storage
      .from("whatsapp-media")
      .createSignedUrl(msg.media_storage_path, SIGNED_URL_TTL_S);
    if (!signErr && signed?.signedUrl) {
      return NextResponse.redirect(signed.signedUrl, 302);
    }
  }

  // Fallback: worker ainda não persistiu — proxy server-side do WAHA
  // (o browser não alcança o WAHA nem tem a api key).
  if (msg.media_url) {
    try {
      const media = await fetchWahaMedia(msg.media_url, msg.media_mime);
      return new Response(new Uint8Array(media.buffer), {
        status: 200,
        headers: {
          "Content-Type": media.mime,
          "Cache-Control": "private, max-age=60",
          "X-Request-Id": requestId,
        },
      });
    } catch {
      return fail("bad_gateway", "Mídia indisponível no momento.", 502, { requestId });
    }
  }

  return fail("not_found", "Mensagem sem mídia.", 404, { requestId });
}
```

- [ ] **Step 2: Typecheck + lint**

```bash
npm run typecheck
npm run lint
```

Expected: zerado nos dois (rodar sem pipe pra `tail`).

- [ ] **Step 3: Commit**

```bash
git add app/api/v1/messages/[id]/media/route.ts
git commit -m "feat(media): endpoint GET /messages/[id]/media — 302 signed URL + proxy fallback"
```

---

### Task 7: Prova E2E em conta real (Playwright) + HANDOFF

**Files:**
- Modify: `HANDOFF-inbox-multimodal.md` (estado, prova, log de sessão)
- Evidência: `.superpowers/evidence/inbox-multimodal-onda0-*.png` (gitignored)

**Interfaces:**
- Consumes: tudo das Tasks 1-6 rodando junto.
- Produces: evidência observada (screenshots + SQL) de mídia real persistida e servida; handoff atualizado.

- [ ] **Step 1: Subir o ambiente real**

```bash
docker compose up -d          # WAHA local (se token Plus expirado: WAHA Core público devlikeapro/waha:noweb na 3030 — ver memória reference_waha_dev_setup)
npm run dev                   # http://localhost:3000
```

Conectar/confirmar uma sessão WhatsApp real em Conexões (QR). Se não houver sessão conectável, PARAR e pedir ao Rafael o pareamento — proibido simular.

- [ ] **Step 2: Receber mídia real**

Pedir ao Rafael (ou usar o segundo número de teste) para enviar à sessão conectada: **1 imagem, 1 áudio (PTT), 1 PDF e 1 figurinha**.

- [ ] **Step 3: Drenar o event_log e provar no banco**

```bash
curl -s -X POST http://localhost:3000/api/v1/cron/event-log-drain \
  -H "Authorization: Bearer $INTERNAL_CRON_SECRET"
```

SQL de prova (via MCP Supabase ou psql):

```sql
select id, type, media_mime, media_size_bytes, media_storage_path,
       metadata->>'media_status' as media_status
from messages
where media_url is not null
order by created_at desc limit 10;
```

Expected: as 4 mensagens com `media_storage_path` no padrão `{org}/{conv}/{msg}.{ext}`, `media_size_bytes > 0`, `media_status = 'stored'`.

- [ ] **Step 4: Provar o endpoint na tela (Playwright, conta real)**

Com Playwright MCP logado numa conta real (seed `scripts/seed-e2e-credentials.ts` se preciso): navegar até a conversa no inbox, e via `browser_evaluate` chamar `fetch('/api/v1/messages/<id>/media', { redirect: 'follow' })` para cada mídia, verificando `response.ok === true` e `content-type` correto; abrir a signed URL retornada numa aba e capturar screenshot da imagem renderizada. Salvar em `.superpowers/evidence/inbox-multimodal-onda0-endpoint.png` + screenshot do inbox `...-inbox.png`. Avaliar TAMBÉM a experiência: latência do 302, erro no console — o critério é "funcionou BEM".

- [ ] **Step 5: Suíte completa + HANDOFF + commit**

```bash
npm run typecheck
npm run lint
npx vitest run
```

Expected: tudo verde. Atualizar `HANDOFF-inbox-multimodal.md` (Onda 0 → ✅ local, com paths das evidências e achados/bugs corrigidos) e commitar:

```bash
git add HANDOFF-inbox-multimodal.md
git commit -m "docs(inbox-multimodal): Onda 0 provada local — mídia persistida e servida"
```

---

## Self-review (feito na escrita)

- **Cobertura do spec (Onda 0):** MediaSource normalizado (T2+T3), fluxo assíncrono via event_log (T4+T5), bucket + colunas preenchidas (T1+T4), endpoint signed URL + fallback (T6), doutrina de migrations (T1), prova Playwright em conta real + handoff (T7). Meta Cloud API fica como segunda implementação da MESMA assinatura `fetch*Media` — nada a construir agora.
- **Sem placeholders:** todo step tem código/comando/expected concretos.
- **Consistência de tipos:** `FetchedMedia`/`storagePathFor`/`MEDIA_PERSIST_CONSUMER_KEY` usados com os mesmos nomes em T3/T4/T6.
