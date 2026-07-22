# Onda 3 — Agente Multimodal Model-Agnóstico Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O agente de IA passa a entender imagem (visão), áudio (transcrição) e PDF (texto) que o lead envia — funcionando com Claude, OpenAI e Gemini, e universal para qualquer modelo futuro.

**Architecture:** Duas camadas. (1) **Universal**: um worker de derivação gera `media_derived_text` (transcrição/OCR/visão) por mídia — texto puro que QUALQUER modelo lê, injetado no contexto do agente no lugar de `[image]`/`[audio]`. (2) **Aprimoramento**: para a mídia do turno corrente, se o modelo é capaz (capability registry), anexa-se a content part nativa da AI SDK v7 (`{type:'image'}`/`{type:'file'}`) — o seam `run-model-call.ts` já passa `ModelMessage[]` cru e a AI SDK normaliza por provider. Modelo desconhecido → só derivado, nunca quebra.

**Tech Stack:** AI SDK v7 (`ai@7.0.31`, `@ai-sdk/{anthropic,openai,google}` já instalados), Supabase Storage (`whatsapp-media`), `pdf-parse`/`pdfjs-dist` (via `extractPdfText` do RAG), event_log + workers, Vitest.

## Global Constraints

- Spec mestre (Onda 3): `docs/superpowers/specs/2026-07-21-inbox-multimodal-design.md`. Handoff `HANDOFF-inbox-multimodal.md` (protocolo de prova visível OBRIGATÓRIO).
- **Model-agnóstico é o requisito nº 1**: o derivado textual (camada universal) DEVE funcionar com qualquer modelo; a parte nativa é gated por capability e nunca é a única fonte.
- Provider e model são **campos separados** no runtime (`config.provider` = `"anthropic"`/`"openai"`/`"google"`; `modelId` = id puro). NÃO usar slug `"provider/model"`.
- BYOK: chave resolvida por turno via `resolveOrgLlmConfig` (`lib/agent-engine/edge/llm/credentials.ts`) da tabela `ai_provider_credentials` (check aceita anthropic/openai/google). Plaintext só em memória, nunca logado.
- Egress do worker passa pela allowlist (`allowlistedFetch`/`buildAllowlist` de `../egress`) — todo provider novo declara seu endpoint canônico.
- Trigger Postgres NUNCA faz HTTP; derivação é worker consumindo `event_log`.
- Admin client (service role) filtra `organization_id` manualmente em toda query.
- Migration: arquivo versionado + apêndice idempotente no `supabase/baseline.sql` + linha no `MANIFEST.md`. Próximo número: **0056** (último é 0055).
- Zod em input externo; sem `console.log` (usar `logger`/`console.error` no padrão local do arquivo); typecheck/lint/testes verdes por task (nunca validar via `cmd | tail`).
- **Vídeo fica FORA desta onda** (Onda 3.1): requer ffmpeg no worker image, flag off por default. As colunas/flag são provisionadas aqui (T1), mas a derivação de vídeo NÃO é implementada.
- Prova final: agente respondendo a imagem/áudio/PDF reais numa conversa real, provado em **≥2 providers** (Claude + OpenAI ou Gemini) trocando a config do agente.

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `lib/agent-engine/edge/llm/capabilities.ts` (novo) | Capability registry: `modelCapabilities(provider, modelId)` → `{image, pdf}`. Metadata model-agnóstica, default conservador. |
| `lib/agent-engine/edge/llm/providers.ts` (mod) | +factories `openai`, `google` (endpoints + fetch contido). |
| `lib/messaging/media/transcription.ts` (novo) | `TranscriptionProvider` plugável; default API (OpenAI Whisper via BYOK). |
| `lib/messaging/media/derive.ts` (novo) | `deriveMediaText({kind, buffer, mime, ...})` — despacha visão/transcrição/pdf. Puro (deps injetadas). |
| `workers/media-derive-worker.ts` + `.handler.ts` (novo) | Consome `media.derive_requested`; preenche `media_derived_text`/`media_derived_status`. |
| `workers/media-persist-worker.ts` (mod) | Emite `media.derive_requested` ao persistir com sucesso. |
| `lib/event-log/register-handlers.ts` (mod) | Registra `mediaDeriveHandler`. |
| `lib/agent-engine/edge/crm/get-lead-context.ts` (mod) | Carrega `media_storage_path/media_mime/type/media_derived_text`; usa derivado no lugar de `[tipo]`. |
| `lib/agent-engine/agent/agent-config.ts` (mod) | Lê flag `multimodal_input` da versão publicada. |
| `lib/agent-engine/agent/media-parts.ts` (novo) | `buildNativeMediaParts(...)` — busca binário do Storage + monta content parts nativas (capability-gated). |
| `lib/agent-engine/agent/inbound-turn.ts` (mod) | Injeta as parts no `openingMessages`; pruna no checkpoint. |
| `supabase/migrations/..._0056_...` + baseline + MANIFEST | Colunas `media_derived_text`, `media_derived_status`, flags `multimodal_input`/`video_frames_enabled`. |

---

### Task 1: Migration 0056 — colunas de derivado + flags multimodais por-agente

**Files:**
- Create: `supabase/migrations/20260722120000_0056_media_multimodal.sql`
- Modify: `supabase/baseline.sql` (apêndice), `supabase/migrations/MANIFEST.md`, `lib/database.types.ts` (2 tabelas)

**Interfaces:**
- Produces: `messages.media_derived_text text`, `messages.media_derived_status text` (null|'pending'|'ready'|'failed'); `ai_agent_versions.multimodal_input boolean not null default true`, `ai_agent_versions.video_frames_enabled boolean not null default false`.

- [ ] **Step 1: Criar a migration**

```sql
-- 0056: derivado textual de mídia (Onda 3 multimodal) + flags por-agente.
-- media_derived_text: transcrição/OCR/visão — camada universal que qualquer
-- modelo lê. multimodal_input: liga a parte nativa (capability-gated) por agente.
alter table messages
  add column if not exists media_derived_text text,
  add column if not exists media_derived_status text;

alter table ai_agent_versions
  add column if not exists multimodal_input boolean not null default true,
  add column if not exists video_frames_enabled boolean not null default false;
```

- [ ] **Step 2: Apêndice idempotente no `supabase/baseline.sql`** (ao fim, padrão dos blocos existentes)

```sql
-- ---- media multimodal: derivado + flags (migration 0056) ----
alter table messages
  add column if not exists media_derived_text text,
  add column if not exists media_derived_status text;
alter table ai_agent_versions
  add column if not exists multimodal_input boolean not null default true,
  add column if not exists video_frames_enabled boolean not null default false;
```

- [ ] **Step 3: Linha no MANIFEST**

```markdown
| 0056 | 20260722120000_0056_media_multimodal | Colunas `media_derived_text`/`media_derived_status` em messages + flags `multimodal_input`/`video_frames_enabled` em ai_agent_versions (Onda 3 agente multimodal). |
```

- [ ] **Step 4: Aplicar e provar** — via `mcp__plugin_supabase_supabase__apply_migration` ou `supabase db query --linked`. SQL de prova:

```sql
select column_name from information_schema.columns
where table_name='messages' and column_name in ('media_derived_text','media_derived_status')
union all
select column_name from information_schema.columns
where table_name='ai_agent_versions' and column_name in ('multimodal_input','video_frames_enabled')
order by column_name;
```

Expected: 4 linhas.

- [ ] **Step 5: Refletir em `lib/database.types.ts`** — nas Row/Insert/Update de `messages` adicionar `media_derived_text: string | null` e `media_derived_status: string | null`; nas de `ai_agent_versions` adicionar `multimodal_input: boolean` e `video_frames_enabled: boolean`. (Se `supabase gen types` estiver disponível, regenerar; senão edição manual das 3 variantes por tabela.)

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add supabase/migrations/20260722120000_0056_media_multimodal.sql supabase/baseline.sql supabase/migrations/MANIFEST.md lib/database.types.ts
git commit -m "feat(multimodal): migration 0056 — derivado de mídia + flags multimodais por-agente"
```

---

### Task 2: Capability registry (metadata model-agnóstica)

**Files:**
- Create: `lib/agent-engine/edge/llm/capabilities.ts`
- Test: `tests/unit/agent-llm-capabilities.test.ts`

**Interfaces:**
- Produces: `interface ModelCapabilities { image: boolean; pdf: boolean }` e `modelCapabilities(provider: string, modelId: string): ModelCapabilities`. Default conservador `{image:false, pdf:false}` para provider desconhecido — garante que modelo novo funciona via derivado sem parte nativa.

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/unit/agent-llm-capabilities.test.ts
import { describe, expect, it } from "vitest";

import { modelCapabilities } from "@/lib/agent-engine/edge/llm/capabilities";

describe("modelCapabilities", () => {
  it("providers conhecidos aceitam imagem e pdf nativos", () => {
    expect(modelCapabilities("anthropic", "claude-sonnet-4-6")).toEqual({ image: true, pdf: true });
    expect(modelCapabilities("openai", "gpt-5")).toEqual({ image: true, pdf: true });
    expect(modelCapabilities("google", "gemini-2.5-pro")).toEqual({ image: true, pdf: true });
  });
  it("provider DESCONHECIDO cai no default conservador (só derivado)", () => {
    expect(modelCapabilities("novissima-ia", "modelo-x")).toEqual({ image: false, pdf: false });
  });
  it("modelo explicitamente text-only rebaixa mesmo em provider conhecido", () => {
    // um modelo de embeddings/text-only não deve receber imagem nativa
    expect(modelCapabilities("openai", "text-embedding-3-large")).toEqual({ image: false, pdf: false });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — `npx vitest run tests/unit/agent-llm-capabilities.test.ts` → FAIL.

- [ ] **Step 3: Implementar**

```ts
// lib/agent-engine/edge/llm/capabilities.ts
/**
 * Capability registry model-agnóstico (Onda 3). Decide se a mídia do turno vai
 * como PARTE NATIVA (image/file) além do derivado textual. É metadata, não um
 * gate de correção: o derivado universal sempre existe, então um modelo
 * desconhecido (default {false,false}) ainda "vê" a mídia via texto.
 *
 * Estender = uma linha (novo provider ou override de modelo). Conservador por
 * construção: só afirma nativo para o que sabemos que funciona.
 */
export interface ModelCapabilities {
  image: boolean;
  pdf: boolean;
}

const NATIVE: ModelCapabilities = { image: true, pdf: true };
const NONE: ModelCapabilities = { image: false, pdf: false };

// Famílias flagship dos 3 providers aceitam imagem+pdf via content parts da AI SDK.
const PROVIDER_DEFAULT: Record<string, ModelCapabilities> = {
  anthropic: NATIVE,
  openai: NATIVE,
  google: NATIVE,
};

// Substrings de modelos que NÃO são de chat multimodal (embeddings, TTS, etc.)
// — rebaixam mesmo num provider capaz. Deny-list explícita e pequena.
const TEXT_ONLY_HINTS = ["embedding", "tts", "whisper", "moderation"];

export function modelCapabilities(provider: string, modelId: string): ModelCapabilities {
  const id = (modelId ?? "").toLowerCase();
  if (TEXT_ONLY_HINTS.some((h) => id.includes(h))) return { ...NONE };
  const base = PROVIDER_DEFAULT[provider?.toLowerCase()] ?? NONE;
  return { ...base };
}
```

- [ ] **Step 4: Rodar e ver passar** — PASS (3 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/agent-engine/edge/llm/capabilities.ts tests/unit/agent-llm-capabilities.test.ts
git commit -m "feat(multimodal): capability registry model-agnóstico (default conservador)"
```

---

### Task 3: Registrar providers OpenAI e Google

**Files:**
- Modify: `lib/agent-engine/edge/llm/providers.ts`
- Test: `tests/unit/agent-providers-registry.test.ts`

**Interfaces:**
- Consumes: `createDefaultRegistry` existente.
- Produces: registry com chaves `anthropic`, `openai`, `google` (cada uma factory `(apiKey, modelId) => LanguageModel`).

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/unit/agent-providers-registry.test.ts
import { describe, expect, it } from "vitest";

import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";

describe("createDefaultRegistry", () => {
  it("registra os três providers do lançamento multimodal", () => {
    const reg = createDefaultRegistry();
    expect(Object.keys(reg).sort()).toEqual(["anthropic", "google", "openai"]);
  });
  it("cada factory produz um LanguageModel (não lança ao instanciar)", () => {
    const reg = createDefaultRegistry();
    expect(() => reg.anthropic("k", "claude-sonnet-4-6")).not.toThrow();
    expect(() => reg.openai("k", "gpt-5")).not.toThrow();
    expect(() => reg.google("k", "gemini-2.5-pro")).not.toThrow();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — FAIL (só `anthropic` registrado).

- [ ] **Step 3: Implementar** — em `lib/agent-engine/edge/llm/providers.ts`:

Trocar os imports do topo:

```ts
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
```

Adicionar as constantes de endpoint junto de `ANTHROPIC_ENDPOINT`:

```ts
const OPENAI_ENDPOINT = 'https://api.openai.com';
const GOOGLE_ENDPOINT = 'https://generativelanguage.googleapis.com';
```

Substituir o corpo de `createDefaultRegistry` para conter os 3, cada um com seu fetch contido:

```ts
export function createDefaultRegistry(opts?: { allowedHosts?: string[] }): ProviderRegistry {
  const extra = opts?.allowedHosts ?? [];
  const contain = (endpoint: string): typeof fetch => {
    const allow = buildAllowlist([endpoint, ...extra]);
    return (input, init) => {
      const url = typeof input === 'string' || input instanceof URL ? input : input.url;
      return allowlistedFetch(url, init, { allowlist: allow });
    };
  };
  return {
    anthropic: (apiKey, modelId) =>
      createAnthropic({ apiKey, fetch: contain(ANTHROPIC_ENDPOINT) })(modelId),
    openai: (apiKey, modelId) =>
      createOpenAI({ apiKey, fetch: contain(OPENAI_ENDPOINT) })(modelId),
    google: (apiKey, modelId) =>
      createGoogleGenerativeAI({ apiKey, fetch: contain(GOOGLE_ENDPOINT) })(modelId),
  };
}
```

- [ ] **Step 4: Rodar e ver passar** — `npx vitest run tests/unit/agent-providers-registry.test.ts` → PASS.

- [ ] **Step 5: Typecheck + suíte do agente + commit**

```bash
npm run typecheck
npx vitest run tests/unit/agent-providers-registry.test.ts
git add lib/agent-engine/edge/llm/providers.ts tests/unit/agent-providers-registry.test.ts
git commit -m "feat(multimodal): registra providers OpenAI e Google (multi-modelo)"
```

---

### Task 4: TranscriptionProvider plugável (default API)

**Files:**
- Create: `lib/messaging/media/transcription.ts`
- Test: `tests/unit/media-transcription.test.ts`

**Interfaces:**
- Produces:
  - `interface TranscriptionProvider { transcribe(audio: Buffer, mime: string): Promise<string> }`
  - `interface TranscriptionCreds { apiKey: string; model?: string; baseUrl?: string }`
  - `apiTranscriptionProvider(creds: TranscriptionCreds, fetchImpl?: typeof fetch): TranscriptionProvider` — POSTa multipart pro endpoint OpenAI-compatível `/v1/audio/transcriptions` (Whisper); default model `whisper-1`.

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/unit/media-transcription.test.ts
import { describe, expect, it, vi } from "vitest";

import { apiTranscriptionProvider } from "@/lib/messaging/media/transcription";

describe("apiTranscriptionProvider", () => {
  it("POSTa multipart pro endpoint de transcrição e devolve o texto", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "olá, quero comprar" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = apiTranscriptionProvider({ apiKey: "sk-test" }, fetchMock);
    const text = await provider.transcribe(Buffer.from([1, 2, 3]), "audio/ogg; codecs=opus");
    expect(text).toBe("olá, quero comprar");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/v1/audio/transcriptions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("propaga erro HTTP do provider", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    const provider = apiTranscriptionProvider({ apiKey: "bad" }, fetchMock);
    await expect(provider.transcribe(Buffer.from([1]), "audio/ogg")).rejects.toThrow(/transcription_401/);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — FAIL.

- [ ] **Step 3: Implementar**

```ts
// lib/messaging/media/transcription.ts
/**
 * Transcrição de áudio plugável (Onda 3). Default: API speech-to-text
 * OpenAI-compatível (Whisper) via BYOK. O derivado é texto → alimenta QUALQUER
 * modelo de chat (camada universal). Um backend mlx-whisper local implementa a
 * mesma interface para self-host em Apple Silicon (fora deste MVP).
 */
export interface TranscriptionProvider {
  transcribe(audio: Buffer, mime: string): Promise<string>;
}

export interface TranscriptionCreds {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

const DEFAULT_BASE = "https://api.openai.com";
const DEFAULT_MODEL = "whisper-1";

function extFor(mime: string): string {
  const base = mime.split(";")[0]!.trim().toLowerCase();
  if (base.includes("ogg")) return "ogg";
  if (base.includes("mpeg") || base.includes("mp3")) return "mp3";
  if (base.includes("mp4") || base.includes("m4a")) return "m4a";
  if (base.includes("webm")) return "webm";
  if (base.includes("wav")) return "wav";
  return "bin";
}

export function apiTranscriptionProvider(
  creds: TranscriptionCreds,
  fetchImpl: typeof fetch = fetch,
): TranscriptionProvider {
  const base = creds.baseUrl ?? DEFAULT_BASE;
  const model = creds.model ?? DEFAULT_MODEL;
  return {
    async transcribe(audio, mime) {
      const form = new FormData();
      form.append("model", model);
      form.append(
        "file",
        new Blob([new Uint8Array(audio)], { type: mime.split(";")[0]!.trim() }),
        `audio.${extFor(mime)}`,
      );
      const res = await fetchImpl(`${base}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${creds.apiKey}` },
        body: form,
      });
      if (!res.ok) throw new Error(`transcription_${res.status}`);
      const json = (await res.json()) as { text?: string };
      return json.text ?? "";
    },
  };
}
```

- [ ] **Step 4: Rodar e ver passar** — PASS (2 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/messaging/media/transcription.ts tests/unit/media-transcription.test.ts
git commit -m "feat(multimodal): TranscriptionProvider plugável (API Whisper default, BYOK)"
```

---

### Task 5: `deriveMediaText` — despacho puro de derivação

**Files:**
- Create: `lib/messaging/media/derive.ts`
- Test: `tests/unit/media-derive.test.ts`

**Interfaces:**
- Consumes: `TranscriptionProvider` (T4); `extractPdfText` de `@/lib/ai/rag/extractors/pdf`.
- Produces:
  - `type DerivableKind = "image" | "audio" | "document"`
  - `interface DeriveDeps { transcriber: TranscriptionProvider; describeImage(buffer: Buffer, mime: string): Promise<string>; extractPdf(buffer: Buffer): Promise<string> }`
  - `deriveMediaText(kind: string, buffer: Buffer, mime: string, deps: DeriveDeps): Promise<string>` — audio→transcribe, document(pdf)→extractPdf, image→describeImage; outros → `""`. Trunca a 8000 chars.

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/unit/media-derive.test.ts
import { describe, expect, it, vi } from "vitest";

import { deriveMediaText, type DeriveDeps } from "@/lib/messaging/media/derive";

function deps(over: Partial<DeriveDeps> = {}): DeriveDeps {
  return {
    transcriber: { transcribe: vi.fn(async () => "transcrição do áudio") },
    describeImage: vi.fn(async () => "uma foto de um tênis vermelho"),
    extractPdf: vi.fn(async () => "conteúdo do pdf"),
    ...over,
  };
}

describe("deriveMediaText", () => {
  it("audio → transcrição", async () => {
    expect(await deriveMediaText("audio", Buffer.from([1]), "audio/ogg", deps())).toBe(
      "transcrição do áudio",
    );
  });
  it("document pdf → texto extraído", async () => {
    expect(
      await deriveMediaText("document", Buffer.from([1]), "application/pdf", deps()),
    ).toBe("conteúdo do pdf");
  });
  it("image → descrição por visão", async () => {
    expect(await deriveMediaText("image", Buffer.from([1]), "image/jpeg", deps())).toBe(
      "uma foto de um tênis vermelho",
    );
  });
  it("document NÃO-pdf → vazio (sem extrator)", async () => {
    expect(await deriveMediaText("document", Buffer.from([1]), "text/csv", deps())).toBe("");
  });
  it("tipo sem derivação (sticker/video) → vazio", async () => {
    expect(await deriveMediaText("sticker", Buffer.from([1]), "image/webp", deps())).toBe("");
    expect(await deriveMediaText("video", Buffer.from([1]), "video/mp4", deps())).toBe("");
  });
  it("trunca derivado gigante a 8000 chars", async () => {
    const huge = "a".repeat(20000);
    const out = await deriveMediaText("document", Buffer.from([1]), "application/pdf", deps({
      extractPdf: vi.fn(async () => huge),
    }));
    expect(out.length).toBe(8000);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — FAIL.

- [ ] **Step 3: Implementar**

```ts
// lib/messaging/media/derive.ts
/**
 * Derivação textual de mídia (Onda 3, camada UNIVERSAL). Puro: as capacidades
 * (transcrição, visão, extração de pdf) são injetadas — o worker as monta com as
 * credenciais BYOK da org. O resultado é texto que qualquer modelo de chat lê.
 */
import type { TranscriptionProvider } from "@/lib/messaging/media/transcription";

const MAX_DERIVED_CHARS = 8000;

export interface DeriveDeps {
  transcriber: TranscriptionProvider;
  describeImage(buffer: Buffer, mime: string): Promise<string>;
  extractPdf(buffer: Buffer): Promise<string>;
}

export async function deriveMediaText(
  kind: string,
  buffer: Buffer,
  mime: string,
  deps: DeriveDeps,
): Promise<string> {
  const base = mime.split(";")[0]!.trim().toLowerCase();
  let text = "";
  if (kind === "audio") {
    text = await deps.transcriber.transcribe(buffer, mime);
  } else if (kind === "document" && base === "application/pdf") {
    text = await deps.extractPdf(buffer);
  } else if (kind === "image") {
    text = await deps.describeImage(buffer, mime);
  }
  // sticker/video/document-não-pdf: sem derivado nesta onda.
  return (text ?? "").slice(0, MAX_DERIVED_CHARS);
}
```

- [ ] **Step 4: Rodar e ver passar** — PASS (6 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/messaging/media/derive.ts tests/unit/media-derive.test.ts
git commit -m "feat(multimodal): deriveMediaText — despacho puro (áudio/pdf/imagem)"
```

---

### Task 6: Worker de derivação — preenche `media_derived_text`

**Files:**
- Create: `workers/media-derive-worker.ts`, `workers/media-derive-worker.handler.ts`
- Modify: `workers/media-persist-worker.ts` (emitir `media.derive_requested` no sucesso), `lib/event-log/register-handlers.ts`
- Test: `tests/unit/media-derive-worker.test.ts`

**Interfaces:**
- Consumes: `deriveMediaText`/`DeriveDeps` (T5), `apiTranscriptionProvider` (T4), `resolveOrgLlmConfig` (`lib/agent-engine/edge/llm/credentials.ts` → `OrgLlmConfig{provider,apiKey,defaultModel}`), `createDefaultRegistry` (T3), `modelCapabilities` (T2), `extractPdfText` de `@/lib/ai/rag/extractors/pdf`, `generateText` de `ai`, `EventHandler`/`EventRow`/`HandlerResult` de `@/lib/event-log/dispatcher`, `createAdminClient`.
- Produces: `deriveMessageMedia(row: EventRow): Promise<HandlerResult>` e `mediaDeriveHandler: EventHandler` (key `"media_derive_v1"`, events `["media.derive_requested"]`). Efeito: `messages.media_derived_text` + `media_derived_status` ('ready'|'failed'). Idempotente (pula se já 'ready').

- [ ] **Step 1: Escrever o teste que falha** (mocka storage + deriveMediaText — testa orquestração/idempotência/estado, não as APIs externas)

```ts
// tests/unit/media-derive-worker.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const downloadMock = vi.fn();
const updateEqMock = vi.fn();
const messageRow = {
  id: "msg1",
  organization_id: "org1",
  type: "audio" as string,
  media_mime: "audio/ogg",
  media_storage_path: "org1/conv1/msg1.ogg",
  media_derived_status: null as string | null,
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: messageRow, error: null }) }) }) }),
      update: (patch: Record<string, unknown>) => {
        updateEqMock(patch);
        return { eq: () => ({ eq: async () => ({ error: null }) }) };
      },
    }),
    storage: { from: () => ({ download: downloadMock }) },
  }),
}));

vi.mock("@/lib/messaging/media/derive", () => ({
  deriveMediaText: vi.fn(async () => "transcrição do áudio real"),
}));

// resolveOrgLlmConfig e generateText mockados: o worker precisa de credencial p/
// montar as deps, mas o teste não exercita rede.
vi.mock("@/lib/agent-engine/edge/llm/credentials", () => ({
  resolveOrgLlmConfig: vi.fn(async () => ({
    provider: "openai",
    apiKey: "sk-test",
    defaultModel: "gpt-5",
    params: {},
    enabledModels: [],
    monthlyBudgetCents: null,
  })),
}));

import { deriveMessageMedia } from "@/workers/media-derive-worker";
import { deriveMediaText } from "@/lib/messaging/media/derive";

function eventRow(attempts = 0) {
  return {
    id: "ev1",
    organization_id: "org1",
    event_type: "media.derive_requested",
    entity_kind: "message",
    entity_id: "msg1",
    payload: { message_id: "msg1" },
    metadata: {},
    consumed_by: [],
    attempts,
  };
}

describe("deriveMessageMedia", () => {
  beforeEach(() => {
    downloadMock.mockReset().mockResolvedValue({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null });
    updateEqMock.mockReset();
    messageRow.media_derived_status = null;
    messageRow.type = "audio";
    vi.mocked(deriveMediaText).mockResolvedValue("transcrição do áudio real");
  });

  it("baixa a mídia, deriva e grava ready", async () => {
    const r = await deriveMessageMedia(eventRow());
    expect(r.status).toBe("ok");
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({ media_derived_text: "transcrição do áudio real", media_derived_status: "ready" }),
    );
  });

  it("pula se já derivado (idempotência)", async () => {
    messageRow.media_derived_status = "ready";
    const r = await deriveMessageMedia(eventRow());
    expect(r.status).toBe("skipped");
    expect(deriveMediaText).not.toHaveBeenCalled();
  });

  it("tipo sem derivado (sticker) → skipped sem baixar", async () => {
    messageRow.type = "sticker";
    const r = await deriveMessageMedia(eventRow());
    expect(r.status).toBe("skipped");
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it("erro na derivação marca failed no último attempt", async () => {
    vi.mocked(deriveMediaText).mockRejectedValue(new Error("transcription_503"));
    const r = await deriveMessageMedia(eventRow(4));
    expect(r.status).toBe("error");
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({ media_derived_status: "failed" }),
    );
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — FAIL.

- [ ] **Step 3: Implementar o worker**

```ts
// workers/media-derive-worker.ts
/**
 * Consome `media.derive_requested`: baixa a mídia persistida (Onda 0), gera o
 * derivado textual model-agnóstico (transcrição/visão/pdf) e grava em
 * messages.media_derived_text. Camada UNIVERSAL da Onda 3 — o texto alimenta
 * qualquer modelo de chat. Retry/backoff delegados ao drain (padrão do repo).
 */
import { generateText } from "ai";

import { extractPdfText } from "@/lib/ai/rag/extractors/pdf";
import { modelCapabilities } from "@/lib/agent-engine/edge/llm/capabilities";
import { resolveOrgLlmConfig } from "@/lib/agent-engine/edge/llm/credentials";
import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";
import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { deriveMediaText, type DeriveDeps } from "@/lib/messaging/media/derive";
import { apiTranscriptionProvider } from "@/lib/messaging/media/transcription";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAgentPool } from "@/workers/agent-worker/pool"; // pool pg do worker (ver nota)

export const MEDIA_DERIVE_CONSUMER_KEY = "media_derive_v1";
const DRAIN_MAX_ATTEMPTS = 5; // espelho de lib/event-log/drain.ts

const DERIVABLE = new Set(["audio", "image", "document"]);

interface MessageRow {
  id: string;
  organization_id: string;
  type: string;
  media_mime: string | null;
  media_storage_path: string | null;
  media_derived_status: string | null;
}

export async function deriveMessageMedia(row: EventRow): Promise<HandlerResult> {
  const consumer_key = MEDIA_DERIVE_CONSUMER_KEY;
  const messageId = (row.payload.message_id as string | undefined) ?? row.entity_id;
  if (!messageId) return { consumer_key, status: "skipped", detail: "no message_id" };

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("messages")
    .select("id, organization_id, type, media_mime, media_storage_path, media_derived_status")
    .eq("id", messageId)
    .eq("organization_id", row.organization_id)
    .maybeSingle();
  if (error) return { consumer_key, status: "error", detail: error.message };

  const msg = data as MessageRow | null;
  if (!msg?.media_storage_path) return { consumer_key, status: "skipped", detail: "no media" };
  if (msg.media_derived_status === "ready") return { consumer_key, status: "skipped", detail: "already derived" };
  if (!DERIVABLE.has(msg.type)) return { consumer_key, status: "skipped", detail: `type ${msg.type}` };

  const markFailed = async () => {
    await admin.from("messages").update({ media_derived_status: "failed" })
      .eq("id", msg.id).eq("organization_id", msg.organization_id);
  };

  try {
    const dl = await admin.storage.from("whatsapp-media").download(msg.media_storage_path);
    if (dl.error || !dl.data) throw new Error(`storage_download_failed: ${dl.error?.message ?? "no_data"}`);
    const buffer = Buffer.from(await dl.data.arrayBuffer());

    // Credencial BYOK da org p/ visão (imagem). Transcrição usa a mesma chave se
    // o provider for openai; senão exige credencial openai dedicada (Whisper).
    const llm = await resolveOrgLlmConfig(getAgentPool(), row.organization_id);
    const deps = buildDeriveDeps(llm);

    const text = await deriveMediaText(msg.type, buffer, msg.media_mime ?? "application/octet-stream", deps);
    await admin.from("messages")
      .update({ media_derived_text: text, media_derived_status: "ready" })
      .eq("id", msg.id).eq("organization_id", msg.organization_id);
    return { consumer_key, status: "ok" };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (row.attempts >= DRAIN_MAX_ATTEMPTS - 1) {
      logger.error("[media-derive] failed permanently", { message_id: msg.id, detail });
      await markFailed();
    }
    return { consumer_key, status: "error", detail };
  }
}

function buildDeriveDeps(llm: { provider: string; apiKey: string; defaultModel: string | null }): DeriveDeps {
  const registry = createDefaultRegistry();
  const visionCapable = modelCapabilities(llm.provider, llm.defaultModel ?? "").image;
  const describeImage: DeriveDeps["describeImage"] = async (buffer, mime) => {
    if (!visionCapable) return ""; // provider sem visão → sem descrição (áudio/pdf ainda funcionam)
    const factory = registry[llm.provider];
    if (!factory) return "";
    const res = await generateText({
      model: factory(llm.apiKey, llm.defaultModel ?? ""),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Descreva objetivamente esta imagem em 1-2 frases, em português, para um atendente de vendas entender o que o cliente enviou." },
            { type: "image", image: buffer, mediaType: mime.split(";")[0] },
          ],
        },
      ],
    });
    return res.text;
  };
  return {
    transcriber: apiTranscriptionProvider({ apiKey: llm.apiKey }),
    describeImage,
    extractPdf: extractPdfText,
  };
}
```

> **Nota de implementação:** o worker precisa de um `pg.Pool` para `resolveOrgLlmConfig`. Verifique como o `workers/agent-worker/main.ts` obtém seu pool (ex.: um singleton exportado). Se não houver `@/workers/agent-worker/pool`, reutilize o mesmo mecanismo de pool que o agent-worker usa (importe de onde ele cria o `pg.Pool`), ou crie um helper `getAgentPool()` fino ali. Ajuste o import na primeira linha de erro do typecheck — NÃO invente um módulo; siga o padrão existente do daemon.

- [ ] **Step 4: Implementar o handler + registrar**

```ts
// workers/media-derive-worker.handler.ts
import type { EventHandler } from "@/lib/event-log/dispatcher";
import { MEDIA_DERIVE_CONSUMER_KEY, deriveMessageMedia } from "@/workers/media-derive-worker";

export const mediaDeriveHandler: EventHandler = {
  key: MEDIA_DERIVE_CONSUMER_KEY,
  events: ["media.derive_requested"],
  handle: deriveMessageMedia,
};
```

Em `lib/event-log/register-handlers.ts`, adicionar import + `registerHandler(mediaDeriveHandler);` (junto dos existentes, sem reordenar).

- [ ] **Step 5: Emitir `media.derive_requested` no persist worker** — em `workers/media-persist-worker.ts`, no ponto em que marca `media_status='stored'` com sucesso (após o upload+update ok, antes do `return { ...status:"ok" }`), emitir o evento de derivação:

```ts
    await admin.rpc("emit_event" as never, {
      p_event_type: "media.derive_requested",
      p_entity_kind: "message",
      p_entity_id: msg.id,
      p_payload: { message_id: msg.id },
      p_metadata: { source: "media_persist" },
      p_organization_id: msg.organization_id,
    } as never);
```

(fire-and-forget no padrão do arquivo; falha de emit não reverte a persistência.)

- [ ] **Step 6: Rodar tudo + commit**

```bash
npm run typecheck
npx vitest run tests/unit/media-derive-worker.test.ts
git add workers/media-derive-worker.ts workers/media-derive-worker.handler.ts workers/media-persist-worker.ts lib/event-log/register-handlers.ts tests/unit/media-derive-worker.test.ts
git commit -m "feat(multimodal): worker media_derive_v1 — preenche media_derived_text (BYOK, model-agnóstico)"
```

---

### Task 7: Contexto do agente carrega mídia + usa derivado

**Files:**
- Modify: `lib/agent-engine/edge/crm/get-lead-context.ts` (HistoryRow, SELECT, LeadContextMessage, flattening), `lib/agent-engine/agent/agent-config.ts` (flag `multimodalInput`)
- Test: `tests/unit/get-lead-context-media.test.ts`

**Interfaces:**
- Consumes: nada novo além do schema.
- Produces:
  - `LeadContextMessage` ganha campos opcionais: `type?: string; media_storage_path?: string | null; media_mime?: string | null`.
  - Flattening: `body` usa `media_derived_text` quando presente; senão `[tipo]`.
  - `PublishedAgentConfig.multimodalInput: boolean` (lido de `v.multimodal_input`).

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/unit/get-lead-context-media.test.ts
import { describe, expect, it } from "vitest";

import { __test_fitToBudget } from "@/lib/agent-engine/edge/crm/get-lead-context";

// fitToBudget é interno; exportar como __test_fitToBudget (ver Step 3).
describe("fitToBudget — mídia no contexto", () => {
  const base = { lead_id: "l1", contact: { name: "x", phone: null, email: null, tags: [], is_blocked: false }, conversation_id: "c1" };

  it("mídia com derivado usa o TEXTO derivado (não [tipo])", () => {
    const ctx = __test_fitToBudget(base, [
      { direction: "inbound", type: "audio", body: null, media_url: "u", media_storage_path: "p", media_mime: "audio/ogg", media_derived_text: "quero o tênis 42", sent_at: "2026-07-22T10:00:00Z" },
    ], 100000);
    expect(ctx.messages[0]!.body).toBe("quero o tênis 42");
    expect(ctx.messages[0]!.type).toBe("audio");
    expect(ctx.messages[0]!.media_storage_path).toBe("p");
  });

  it("mídia SEM derivado ainda cai no marcador [tipo]", () => {
    const ctx = __test_fitToBudget(base, [
      { direction: "inbound", type: "image", body: null, media_url: "u", media_storage_path: "p", media_mime: "image/jpeg", media_derived_text: null, sent_at: "2026-07-22T10:00:00Z" },
    ], 100000);
    expect(ctx.messages[0]!.body).toBe("[image]");
  });

  it("texto puro inalterado", () => {
    const ctx = __test_fitToBudget(base, [
      { direction: "inbound", type: "text", body: "oi", media_url: null, media_storage_path: null, media_mime: null, media_derived_text: null, sent_at: "2026-07-22T10:00:00Z" },
    ], 100000);
    expect(ctx.messages[0]!.body).toBe("oi");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — FAIL (campos e `__test_fitToBudget` não existem).

- [ ] **Step 3: Implementar** — em `lib/agent-engine/edge/crm/get-lead-context.ts`:

Estender `HistoryRow` (L86-92):

```ts
interface HistoryRow {
  direction: 'inbound' | 'outbound';
  type: string;
  body: string | null;
  media_url: string | null;
  media_storage_path: string | null;
  media_mime: string | null;
  media_derived_text: string | null;
  sent_at: string;
}
```

Ampliar o SELECT do histórico (L128-135):

```ts
          `select direction, type, body, media_url, media_storage_path, media_mime,
                  media_derived_text, sent_at::text as sent_at
           from messages
           where organization_id = $1 and conversation_id = $2
             and direction in ('inbound', 'outbound')
           order by sent_at desc, id desc
           limit $3`,
```

Estender `LeadContextMessage` (L37-42):

```ts
export interface LeadContextMessage {
  direction: 'inbound' | 'outbound';
  /** Corpo textual; mídia usa o derivado (transcrição/visão/pdf) ou marcador [tipo]. */
  body: string;
  sent_at: string;
  /** Metadados de mídia (Onda 3): presentes só em mensagens com mídia. */
  type?: string;
  media_storage_path?: string | null;
  media_mime?: string | null;
}
```

Trocar o flattening em `fitToBudget` (L181-186):

```ts
  let messages: LeadContextMessage[] = history.map((m) => ({
    direction: m.direction,
    // Onda 3: mídia usa o derivado textual (universal); sem derivado, marcador [tipo].
    body: m.body ?? (m.media_derived_text ?? (m.media_storage_path || m.media_url ? `[${m.type}]` : '')),
    sent_at: m.sent_at,
    ...(m.media_storage_path || m.media_url
      ? { type: m.type, media_storage_path: m.media_storage_path, media_mime: m.media_mime }
      : {}),
  }));
```

Exportar `fitToBudget` para teste (ao lado da definição):

```ts
/** @internal exposto p/ teste — não usar fora de testes. */
export const __test_fitToBudget = fitToBudget;
```

- [ ] **Step 4: Adicionar a flag em `agent-config.ts`** — em `PublishedAgentConfig` (após `handoffToolEnabled`): `multimodalInput: boolean;`; em `Row`: `multimodal_input: boolean;`; no SELECT (após `v.handoff_tool_enabled,`): `v.multimodal_input,`; no return: `multimodalInput: r.multimodal_input,`.

- [ ] **Step 5: Rodar tudo + commit**

```bash
npm run typecheck
npx vitest run tests/unit/get-lead-context-media.test.ts
git add lib/agent-engine/edge/crm/get-lead-context.ts lib/agent-engine/agent/agent-config.ts tests/unit/get-lead-context-media.test.ts
git commit -m "feat(multimodal): contexto do agente carrega mídia + usa derivado; flag multimodal_input"
```

---

### Task 8: Injeção da parte nativa no turno (capability-gated)

**Files:**
- Create: `lib/agent-engine/agent/media-parts.ts`
- Modify: `lib/agent-engine/agent/inbound-turn.ts` (montagem de `openingMessages` ~L1150; prune no checkpoint ~L1230)
- Test: `tests/unit/agent-media-parts.test.ts`

**Interfaces:**
- Consumes: `modelCapabilities` (T2); `LeadContextMessage` com campos de mídia (T7); admin storage (signed URL/bytes).
- Produces: `buildNativeMediaParts(args): Promise<Array<{type:'image',image:URL}|{type:'file',data:URL,mediaType:string}>>` — para as mensagens INBOUND de mídia recentes do contexto, se `capabilities` permite a modalidade, gera a part com **signed URL** (TTL 300s). Retorna `[]` se flag off, provider incapaz, ou sem mídia.

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/unit/agent-media-parts.test.ts
import { describe, expect, it, vi } from "vitest";

import { buildNativeMediaParts } from "@/lib/agent-engine/agent/media-parts";

function signer(ok = true) {
  return {
    storage: {
      from: () => ({
        createSignedUrl: vi.fn(async (path: string) =>
          ok ? { data: { signedUrl: `https://signed/${path}` }, error: null } : { data: null, error: { message: "x" } },
        ),
      }),
    },
  };
}

const imgMsg = { direction: "inbound" as const, body: "[image]", sent_at: "t", type: "image", media_storage_path: "org/conv/m.jpg", media_mime: "image/jpeg" };
const pdfMsg = { direction: "inbound" as const, body: "[document]", sent_at: "t", type: "document", media_storage_path: "org/conv/m.pdf", media_mime: "application/pdf" };
const textMsg = { direction: "inbound" as const, body: "oi", sent_at: "t" };

describe("buildNativeMediaParts", () => {
  it("flag off → []", async () => {
    const parts = await buildNativeMediaParts({ messages: [imgMsg], provider: "anthropic", model: "claude", multimodalInput: false, admin: signer() as never });
    expect(parts).toEqual([]);
  });
  it("provider capaz + imagem → part image com signed URL", async () => {
    const parts = await buildNativeMediaParts({ messages: [imgMsg], provider: "anthropic", model: "claude-sonnet-4-6", multimodalInput: true, admin: signer() as never });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: "image" });
  });
  it("pdf em provider com pdf → part file", async () => {
    const parts = await buildNativeMediaParts({ messages: [pdfMsg], provider: "google", model: "gemini-2.5-pro", multimodalInput: true, admin: signer() as never });
    expect(parts[0]).toMatchObject({ type: "file", mediaType: "application/pdf" });
  });
  it("provider incapaz (desconhecido) → [] (derivado cobre)", async () => {
    const parts = await buildNativeMediaParts({ messages: [imgMsg], provider: "nova-ia", model: "x", multimodalInput: true, admin: signer() as never });
    expect(parts).toEqual([]);
  });
  it("texto puro → []", async () => {
    const parts = await buildNativeMediaParts({ messages: [textMsg], provider: "anthropic", model: "claude", multimodalInput: true, admin: signer() as never });
    expect(parts).toEqual([]);
  });
  it("só a mídia inbound MAIS RECENTE entra (evita re-enviar histórico caro)", async () => {
    const older = { ...imgMsg, media_storage_path: "org/conv/old.jpg" };
    const parts = await buildNativeMediaParts({ messages: [older, imgMsg], provider: "anthropic", model: "claude", multimodalInput: true, admin: signer() as never, maxItems: 1 });
    expect(parts).toHaveLength(1);
    expect((parts[0] as { image: URL }).image.toString()).toContain("m.jpg");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — FAIL.

- [ ] **Step 3: Implementar**

```ts
// lib/agent-engine/agent/media-parts.ts
/**
 * Parte NATIVA de mídia para o turno (Onda 3, camada de aprimoramento).
 * Capability-gated: só emite image/file para provider+modelo conhecidos por
 * aceitá-los; caso contrário [] e o derivado textual (já no contexto) cobre.
 * Usa signed URL curta do bucket privado — o provider baixa, nunca base64.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { modelCapabilities } from "@/lib/agent-engine/edge/llm/capabilities";
import type { LeadContextMessage } from "@/lib/agent-engine/edge/crm/get-lead-context";

const SIGNED_TTL_S = 300;

export type NativeMediaPart =
  | { type: "image"; image: URL }
  | { type: "file"; data: URL; mediaType: string };

export interface BuildNativeMediaPartsArgs {
  messages: LeadContextMessage[];
  provider: string;
  model: string;
  multimodalInput: boolean;
  admin: SupabaseClient;
  /** teto de mídias anexadas (default 1: só a inbound mais recente). */
  maxItems?: number;
}

export async function buildNativeMediaParts(args: BuildNativeMediaPartsArgs): Promise<NativeMediaPart[]> {
  if (!args.multimodalInput) return [];
  const caps = modelCapabilities(args.provider, args.model);
  if (!caps.image && !caps.pdf) return [];

  const maxItems = args.maxItems ?? 1;
  // mais recentes primeiro (o array vem em ordem cronológica asc → reverse)
  const candidates = [...args.messages]
    .reverse()
    .filter((m) => m.direction === "inbound" && m.media_storage_path)
    .slice(0, maxItems);

  const parts: NativeMediaPart[] = [];
  for (const m of candidates) {
    const mime = (m.media_mime ?? "").split(";")[0]!.trim().toLowerCase();
    const isImage = m.type === "image" && mime.startsWith("image/") && caps.image;
    const isPdf = m.type === "document" && mime === "application/pdf" && caps.pdf;
    if (!isImage && !isPdf) continue;

    const signed = await args.admin.storage.from("whatsapp-media").createSignedUrl(m.media_storage_path!, SIGNED_TTL_S);
    if (signed.error || !signed.data?.signedUrl) continue;
    const url = new URL(signed.data.signedUrl);
    if (isImage) parts.push({ type: "image", image: url });
    else parts.push({ type: "file", data: url, mediaType: "application/pdf" });
  }
  return parts;
}
```

- [ ] **Step 4: Injetar no `inbound-turn.ts`** — a montagem de `openingMessages` (L1150-1155) passa a incluir as parts quando houver. Substituir o bloco por:

```ts
  const openingText =
    openingSuffixes.length === 0 ? openingBase : `${openingBase}\n\n${openingSuffixes.join('\n\n')}`;
  const nativeParts = await buildNativeMediaParts({
    messages: effectiveContext.messages,
    provider: agentConfig?.provider ?? deps.llmCfg.defaultProvider ?? 'anthropic',
    model: agentConfig?.model ?? '',
    multimodalInput: agentConfig?.multimodalInput ?? false,
    admin: deps.crmCfg.supabase,
  });
  const openingMessages: ModelMessage[] =
    nativeParts.length === 0
      ? [{ role: 'user', content: openingText }]
      : [{ role: 'user', content: [{ type: 'text', text: openingText }, ...nativeParts] }];
```

Adicionar o import no topo do arquivo:

```ts
import { buildNativeMediaParts } from '@/lib/agent-engine/agent/media-parts';
```

> Ajuste os acessos `effectiveContext.messages`, `deps.crmCfg.supabase` e `deps.llmCfg.defaultProvider` ao shape real (o Explore confirmou `deps.crmCfg.supabase` = admin client e `effectiveContext` = o `LeadContext`). Se `deps.llmCfg` não tiver `defaultProvider`, use `'anthropic'` como fallback literal — a flag `multimodalInput` só liga quando há agente publicado, que sempre traz `provider`.

- [ ] **Step 5: Prune da mídia no checkpoint** — na chamada de fechamento (~L1214-1236) que reusa `openingMessages`, garantir que a part de mídia NÃO seja re-enviada (custo). Trocar o reuso de `...openingMessages` por uma versão só-texto:

```ts
  const openingTextOnly: ModelMessage[] = [{ role: 'user', content: openingText }];
  // ... no fechamento, usar openingTextOnly no lugar de openingMessages:
  //   [...openingTextOnly, ...responseMessages, { role:'user', content: CHECKPOINT_INSTRUCTION }]
```

(Declare `openingTextOnly` junto de `openingMessages` no Step 4 e use-o no bloco de checkpoint.)

- [ ] **Step 6: Rodar tudo + commit**

```bash
npm run typecheck
npx vitest run tests/unit/agent-media-parts.test.ts
npx vitest run
git add lib/agent-engine/agent/media-parts.ts lib/agent-engine/agent/inbound-turn.ts tests/unit/agent-media-parts.test.ts
git commit -m "feat(multimodal): injeta parte nativa no turno (capability-gated) + prune no checkpoint"
```

---

### Task 9: Prova E2E real — multimodal em ≥2 modelos + HANDOFF

**Files:**
- Modify: `HANDOFF-inbox-multimodal.md`
- Evidência: `.superpowers/evidence/inbox-multimodal-onda3-*.png`

- [ ] **Step 1: Ambiente** — dev server + WAHA + worker de agente rodando; sessão WhatsApp WORKING; um agente publicado na org de teste com `multimodal_input=true` e uma credencial BYOK válida (Anthropic). Confirmar o worker de agente e o de derivação drenando `event_log`.

- [ ] **Step 2: Derivação provada (SQL)** — enviar do WhatsApp real: 1 imagem (ex.: foto de um produto), 1 áudio de voz (falando um pedido), 1 PDF. Drenar. SQL:

```sql
select type, media_derived_status, left(media_derived_text, 80) as derivado
from messages where organization_id = '<org>' and media_storage_path is not null
  and created_at > now() - interval '15 minutes' order by created_at desc;
```

Expected: `media_derived_status='ready'` e `media_derived_text` com transcrição/descrição/texto coerentes.

- [ ] **Step 3: Agente entende a mídia (Claude)** — deixar o agente responder ao lead. Na conversa (Playwright), verificar que a resposta do agente demonstra ter entendido o conteúdo da imagem/áudio/PDF (ex.: cita o produto da foto, responde ao pedido falado). Screenshot.

- [ ] **Step 4: Prova de MODEL-AGNOSTICISMO** — trocar a config do agente para um segundo provider (OpenAI ou Google) publicando nova versão com `provider`/`model`/`credentialId` do segundo provider (credencial BYOK real fornecida pelo Rafael — PEDIR se não houver). Reenviar uma mídia (ou reprocessar o turno) e verificar que o agente responde entendendo a mídia com o SEGUNDO modelo. Screenshot lado a lado. Se o Rafael só tiver credencial de um provider, provar o segundo via o derivado textual (que é model-agnóstico por construção) + registrar que a parte nativa do 2º provider ficou pendente de credencial.

- [ ] **Step 5: UX + suíte + HANDOFF** — console limpo; sem custo explosivo (a mídia entra depois do prefixo cacheável); `npm run typecheck` + `npm run lint` + `npx vitest run` verdes. Atualizar `HANDOFF-inbox-multimodal.md` (Onda 3 → status, provas dos 2 modelos, nota Onda 3.1 vídeo). Commit.

---

## Self-review (feito na escrita)

- **Cobertura do spec (Onda 3):** camada universal (derivado) = T4+T5+T6; usa derivado no contexto = T7; camada nativa capability-gated = T2+T8; multi-modelo (openai+google) = T3; flag por-agente = T1+T7; transcrição plugável = T4; colunas = T1. Vídeo explicitamente diferido (Onda 3.1) — coerente com "flag off default" e ausência de ffmpeg. Prova ≥2 modelos = T9.
- **Model-agnóstico garantido:** T6 preenche derivado (texto) para qualquer org/provider; T7 injeta esse texto no contexto → qualquer modelo lê; T8 só ADICIONA nativo quando capability confirma, default conservador (T2) nunca quebra modelo novo.
- **Sem placeholders:** todo step tem código/comando/expected. As duas notas de implementação (pool do worker; shapes de `deps` no inbound-turn) apontam o padrão existente a seguir, não deixam lógica em aberto.
- **Consistência de tipos:** `ModelCapabilities{image,pdf}` (T2) usado em T6/T8; `DeriveDeps` (T5) montado em T6; `LeadContextMessage` estendido (T7) consumido em T8; `MEDIA_DERIVE_CONSUMER_KEY` idem T6; `multimodalInput` (T7) lido em T8.
