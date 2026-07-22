# Onda 2 — Composer WhatsApp (anexos, áudio, emoji + envio de mídia) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O atendente envia mídia como no WhatsApp: botão "+" com preview e caption, gravação de áudio (PTT) com timer, emoji picker completo — e o backend para de descartar mídia: upload → Storage → WAHA (`sendImage`/`sendVideo`/`sendVoice`/`sendFile`) via signed URL.

**Architecture:** Outbound é storage-first (doutrina: mídia sobe pro bucket `whatsapp-media` e o WAHA recebe URL assinada, nunca base64). Fluxo: `POST /api/v1/conversations/[id]/media` (multipart, valida e sobe) → `POST /api/v1/messages` com `media_storage_path` → `sendMessageHandler` assina URL e roteia pro endpoint WAHA por tipo. O formato normalizado (storage_path+mime) é a mesma costura que servirá a Meta Cloud API.

**Tech Stack:** Route Handlers (multipart via `req.formData()`), Supabase Storage signed URLs, WAHA REST, MediaRecorder API, shadcn Popover/Dialog, emoji-mart (lazy).

## Global Constraints

- Spec mestre (Onda 2) + `HANDOFF-inbox-multimodal.md` (protocolo de prova visível).
- **Storage-first**: WAHA recebe signed URL (TTL 600s) — NUNCA base64 inline, NUNCA URL pública permanente.
- Upload: cap **50MB** (`MAX_MEDIA_BYTES` de `lib/messaging/media/types.ts`); mime allowlist por tipo (image/*, video/*, audio/*, e documentos: pdf/doc/xls/ppt/txt/csv/zip); path `{org_id}/{conversation_id}/out-{uuid}.{ext}` (prefixo `out-` distingue outbound).
- `sendVoice` com `convert: true` (WhatsApp exige OGG/OPUS; docs WAHA). **Contingência registrada**: se na prova real o NOWEB Core não converter (PTT chega como arquivo), fallback `sendFile` e avaliação de conversão server-side (ffmpeg — que a Onda 3 já trará) — decisão na T6, não construir antes.
- Emoji picker: **nova dependência aprovada para esta onda**: `@emoji-mart/react` + `@emoji-mart/data` (visual WhatsApp-like: busca, categorias, recentes; referência do screenshot do Rafael), SEMPRE via `next/dynamic`/import dinâmico — zero peso no bundle inicial do inbox.
- Gravação: `MediaRecorder`, mime negociado (`audio/ogg;codecs=opus` → `audio/webm;codecs=opus` → default do browser); enviar com o mime REAL gravado.
- MessageBubble: alargar gate `hasMedia` para `media_url || media_storage_path` (forward note do review final da Onda 1).
- Optimistic update NÃO se aplica a envio de mídia (o renderer buscaria `/messages/temp-…/media` → 404); mídia envia sem inserção otimista e confia na invalidação. Decisão registrada.
- Ícones só via `@/lib/ui/icons` (adicionar os que faltarem ao wrapper: `Smiley`, `Microphone`, `Plus`, `ImageSquare`, `Trash`, `StopCircle`).
- Zod em todo input externo; audit já coberto pelo `message.sent` existente; sem `console.log`; typecheck/lint/testes verdes por task (sem pipe-tail).
- Prova final: Playwright + envio real pelo CRM e **confirmação de chegada no WhatsApp real** (Rafael do outro lado), acks na UI, screenshots + medidas.

---

### Task 1: Endpoint de upload `POST /api/v1/conversations/[id]/media`

**Files:**
- Create: `app/api/v1/conversations/[id]/media/route.ts`
- Create: `lib/messaging/media/upload-validation.ts`
- Test: `tests/unit/media-upload-validation.test.ts`

**Interfaces:**
- Consumes: `MAX_MEDIA_BYTES`/`extFromMime` (`lib/messaging/media/types.ts`), auth pattern de `app/api/v1/conversations/[id]/messages/route.ts`, `createAdminClient`.
- Produces: response `{ data: { storage_path, media_mime, media_size_bytes, kind } }` consumida pelas tasks 3-4; `validateOutboundMedia(mime, size): { ok: true; kind: MessageKind } | { ok: false; code; message }` com `type MessageKind = "image" | "video" | "audio" | "document"`.

- [ ] **Step 1: Teste da validação (falhando)**

```ts
// tests/unit/media-upload-validation.test.ts
import { describe, expect, it } from "vitest";

import { validateOutboundMedia } from "@/lib/messaging/media/upload-validation";

describe("validateOutboundMedia", () => {
  it("classifica mimes suportados no kind certo", () => {
    expect(validateOutboundMedia("image/jpeg", 1000)).toEqual({ ok: true, kind: "image" });
    expect(validateOutboundMedia("image/webp", 1000)).toEqual({ ok: true, kind: "image" });
    expect(validateOutboundMedia("video/mp4", 1000)).toEqual({ ok: true, kind: "video" });
    expect(validateOutboundMedia("audio/ogg; codecs=opus", 1000)).toEqual({ ok: true, kind: "audio" });
    expect(validateOutboundMedia("audio/webm", 1000)).toEqual({ ok: true, kind: "audio" });
    expect(validateOutboundMedia("application/pdf", 1000)).toEqual({ ok: true, kind: "document" });
    expect(validateOutboundMedia("text/csv", 1000)).toEqual({ ok: true, kind: "document" });
  });
  it("rejeita mime não suportado", () => {
    const r = validateOutboundMedia("application/x-msdownload", 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsupported_media_type");
  });
  it("rejeita acima de 50MB", () => {
    const r = validateOutboundMedia("image/jpeg", 51 * 1024 * 1024);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("payload_too_large");
  });
  it("rejeita arquivo vazio", () => {
    const r = validateOutboundMedia("image/jpeg", 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("validation_failed");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — `npx vitest run tests/unit/media-upload-validation.test.ts` → FAIL (módulo não existe).

- [ ] **Step 3: Implementar a validação**

```ts
// lib/messaging/media/upload-validation.ts
/** Validação do upload outbound (Onda 2). Allowlist por categoria + cap 50MB. */
import { MAX_MEDIA_BYTES } from "@/lib/messaging/media/types";

export type MessageKind = "image" | "video" | "audio" | "document";

const DOCUMENT_MIMES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "application/zip",
]);

type Ok = { ok: true; kind: MessageKind };
type Fail = { ok: false; code: "unsupported_media_type" | "payload_too_large" | "validation_failed"; message: string };

export function validateOutboundMedia(mime: string, sizeBytes: number): Ok | Fail {
  if (!sizeBytes || sizeBytes <= 0) {
    return { ok: false, code: "validation_failed", message: "Arquivo vazio." };
  }
  if (sizeBytes > MAX_MEDIA_BYTES) {
    return { ok: false, code: "payload_too_large", message: "Arquivo acima de 50MB." };
  }
  const base = mime.split(";")[0]!.trim().toLowerCase();
  if (base.startsWith("image/")) return { ok: true, kind: "image" };
  if (base.startsWith("video/")) return { ok: true, kind: "video" };
  if (base.startsWith("audio/")) return { ok: true, kind: "audio" };
  if (DOCUMENT_MIMES.has(base)) return { ok: true, kind: "document" };
  return { ok: false, code: "unsupported_media_type", message: "Tipo de arquivo não suportado." };
}
```

- [ ] **Step 4: Implementar a rota**

```ts
// app/api/v1/conversations/[id]/media/route.ts
/**
 * POST /api/v1/conversations/[id]/media — upload outbound (multipart).
 * Storage-first: sobe pro bucket whatsapp-media; o envio da mensagem
 * referencia o storage_path (o WAHA recebe signed URL, nunca base64).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { extFromMime } from "@/lib/messaging/media/types";
import { validateOutboundMedia } from "@/lib/messaging/media/upload-validation";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id: conversationId } = await ctx.params;
  const supabase = await createClient();

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) return fail("unauthenticated", "Auth required.", 401, { requestId });
  const authUser = await loadAuthUser();
  const activeOrg = authUser ? await resolveActiveOrg(authUser) : null;
  if (!activeOrg) return fail("no_active_org", "No active organization.", 403, { requestId });

  // RLS + filtro explícito: a conversa precisa ser da org ativa.
  const { data: conv, error: convErr } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (convErr) return fail("internal_error", "Erro ao validar conversa.", 500, { requestId });
  if (!conv) return fail("not_found", "Conversa não encontrada.", 404, { requestId });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return fail("validation_failed", "Campo 'file' (multipart) obrigatório.", 422, { requestId });
  }

  const mime = file.type || "application/octet-stream";
  const verdict = validateOutboundMedia(mime, file.size);
  if (!verdict.ok) {
    const status = verdict.code === "payload_too_large" ? 413 : verdict.code === "unsupported_media_type" ? 415 : 422;
    return fail(verdict.code, verdict.message, status, { requestId });
  }

  const storagePath = `${activeOrg.orgId}/${conversationId}/out-${randomUUID()}.${extFromMime(mime)}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  const admin = createAdminClient();
  const { error: upErr } = await admin.storage
    .from("whatsapp-media")
    .upload(storagePath, buffer, { contentType: mime, upsert: false });
  if (upErr) {
    console.error("[conversations.media] upload failed", upErr.message);
    return fail("internal_error", "Erro ao subir o arquivo.", 500, { requestId });
  }

  return ok(
    {
      storage_path: storagePath,
      media_mime: mime,
      media_size_bytes: file.size,
      kind: verdict.kind,
    },
    { requestId },
  );
}
```

- [ ] **Step 5: Rodar testes + typecheck + commit**

`npx vitest run tests/unit/media-upload-validation.test.ts` → PASS; `npm run typecheck` → 0.

```bash
git add app/api/v1/conversations/[id]/media/route.ts lib/messaging/media/upload-validation.ts tests/unit/media-upload-validation.test.ts
git commit -m "feat(composer): endpoint de upload outbound storage-first"
```

---

### Task 2: Envio de mídia no backend (schema + WahaClient + handler)

**Files:**
- Modify: `lib/schemas/messaging.ts` (`sendMessageSchema`)
- Modify: `lib/waha/client.ts` (métodos de mídia)
- Create: `lib/waha/media-send.ts` (roteamento puro tipo→método)
- Modify: `app/api/v1/messages/_handler.ts` (persistir storage_path/size; enviar mídia de verdade)
- Test: `tests/unit/waha-media-send.test.ts`

**Interfaces:**
- Consumes: `getWahaClient`, `parseWahaMessageId`, padrão do handler existente.
- Produces:
  - Schema aceita `media_storage_path?: string` e `media_size_bytes?: number` (refine: `body || media_url || media_storage_path`).
  - `WahaClient.sendMedia(session, chatId, plan)` onde `plan = wahaSendPlanFor(kindFromType, { url, mime, filename, caption })` → `{ endpoint: "sendImage"|"sendVideo"|"sendVoice"|"sendFile"; payload: Record<string, unknown> }`.
  - Handler: mensagens com `media_storage_path` são enviadas via signed URL (TTL 600s) pelo endpoint certo; texto puro continua `sendText`.

- [ ] **Step 1: Teste do roteamento (falhando)**

```ts
// tests/unit/waha-media-send.test.ts
import { describe, expect, it } from "vitest";

import { wahaSendPlanFor } from "@/lib/waha/media-send";

const media = { url: "https://signed.example/x?token=t", mime: "image/jpeg", filename: "x.jpg", caption: "oi" };

describe("wahaSendPlanFor", () => {
  it("image → sendImage com caption", () => {
    const plan = wahaSendPlanFor("image", media);
    expect(plan.endpoint).toBe("sendImage");
    expect(plan.payload.caption).toBe("oi");
    expect((plan.payload.file as { url: string }).url).toBe(media.url);
  });
  it("video → sendVideo com caption e convert", () => {
    const plan = wahaSendPlanFor("video", { ...media, mime: "video/mp4" });
    expect(plan.endpoint).toBe("sendVideo");
    expect(plan.payload.convert).toBe(true);
  });
  it("audio → sendVoice com convert (WhatsApp exige OGG/OPUS)", () => {
    const plan = wahaSendPlanFor("audio", { ...media, mime: "audio/webm;codecs=opus" });
    expect(plan.endpoint).toBe("sendVoice");
    expect(plan.payload.convert).toBe(true);
    expect(plan.payload.caption).toBeUndefined(); // voz não tem caption no WhatsApp
  });
  it("document (e desconhecidos) → sendFile com filename", () => {
    const plan = wahaSendPlanFor("document", { ...media, mime: "application/pdf", filename: "doc.pdf" });
    expect(plan.endpoint).toBe("sendFile");
    expect((plan.payload.file as { filename: string }).filename).toBe("doc.pdf");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — `npx vitest run tests/unit/waha-media-send.test.ts` → FAIL.

- [ ] **Step 3: Implementar o roteamento puro**

```ts
// lib/waha/media-send.ts
/**
 * Plano de envio de mídia WAHA por tipo de mensagem (Onda 2). Puro — o
 * WahaClient executa. sendVoice: WhatsApp só aceita OGG/OPUS; convert:true
 * pede conversão ao WAHA (contingência NOWEB Core registrada no plano).
 */
export interface OutboundMedia {
  url: string;
  mime: string;
  filename?: string | null;
  caption?: string | null;
}

export interface WahaSendPlan {
  endpoint: "sendImage" | "sendVideo" | "sendVoice" | "sendFile";
  payload: Record<string, unknown>;
}

export function wahaSendPlanFor(kind: string, media: OutboundMedia): WahaSendPlan {
  const file: Record<string, unknown> = { url: media.url, mimetype: media.mime };
  if (media.filename) file.filename = media.filename;

  switch (kind) {
    case "image":
      return { endpoint: "sendImage", payload: { file, ...(media.caption ? { caption: media.caption } : {}) } };
    case "video":
      return {
        endpoint: "sendVideo",
        payload: { file, convert: true, ...(media.caption ? { caption: media.caption } : {}) },
      };
    case "audio":
      return { endpoint: "sendVoice", payload: { file, convert: true } };
    default:
      return { endpoint: "sendFile", payload: { file, ...(media.caption ? { caption: media.caption } : {}) } };
  }
}
```

- [ ] **Step 4: `WahaClient.sendMedia` + schema**

Em `lib/waha/client.ts`, adicionar método (mesmo padrão do `sendMessage`):

```ts
  async sendMedia(
    session: string,
    chatId: string,
    plan: { endpoint: string; payload: Record<string, unknown> },
  ): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/api/${plan.endpoint}`, {
      method: "POST",
      headers: { "X-Api-Key": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ session, chatId, ...plan.payload }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`waha_${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }
```

Em `lib/schemas/messaging.ts`, trocar `sendMessageSchema` por:

```ts
export const sendMessageSchema = z
  .object({
    conversation_id: z.string().uuid(),
    type: messageTypeSchema.default("text"),
    body: z.string().min(1).max(4096).optional(),
    media_url: z.string().url().optional(),
    media_storage_path: z.string().min(1).max(500).optional(),
    media_mime: z.string().optional(),
    media_size_bytes: z.number().int().positive().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((d) => !!d.body || !!d.media_url || !!d.media_storage_path, {
    message: "body, media_url or media_storage_path required",
    path: ["body"],
  });
```

- [ ] **Step 5: Handler — persistir e enviar**

Em `app/api/v1/messages/_handler.ts`:

1. Imports novos: `import { createAdminClient } from "@/lib/supabase/admin";` e `import { wahaSendPlanFor } from "@/lib/waha/media-send";`.
2. `insertRow` ganha, após `media_mime`: `media_storage_path: input.media_storage_path ?? null,` e `media_size_bytes: input.media_size_bytes ?? null,`.
3. No branch de envio (o `else` final, onde hoje chama `waha.sendMessage`), substituir o corpo do `try` por:

```ts
      let wahaRes: unknown;
      if (input.media_storage_path) {
        // Storage-first: signed URL curta só pro WAHA baixar (nunca base64).
        const admin = createAdminClient();
        const { data: signed, error: signErr } = await admin.storage
          .from("whatsapp-media")
          .createSignedUrl(input.media_storage_path, 600);
        if (signErr || !signed?.signedUrl) {
          throw new Error(`storage_sign_failed: ${signErr?.message ?? "no_url"}`);
        }
        const filename = input.media_storage_path.split("/").pop() ?? undefined;
        wahaRes = await waha.sendMedia(
          c.channel_sessions.waha_session_name,
          chatId,
          wahaSendPlanFor(input.type, {
            url: signed.signedUrl,
            mime: input.media_mime ?? "application/octet-stream",
            filename,
            caption: input.body ?? null,
          }),
        );
      } else {
        wahaRes = await waha.sendMessage(
          c.channel_sessions.waha_session_name,
          chatId,
          input.body ?? "",
        );
      }
```

(o restante do `try` — `parseWahaMessageId(wahaRes)` e o update `sent` — permanece idêntico; só a variável `wahaRes` deixa de ser declarada inline.)

- [ ] **Step 6: Rodar tudo + commit**

`npx vitest run tests/unit/waha-media-send.test.ts` → PASS; `npm run typecheck` → 0; `npx vitest run` → verde.

```bash
git add lib/schemas/messaging.ts lib/waha/client.ts lib/waha/media-send.ts app/api/v1/messages/_handler.ts tests/unit/waha-media-send.test.ts
git commit -m "feat(composer): backend envia mídia de verdade (schema + WahaClient.sendMedia + handler storage-first)"
```

---

### Task 3: Botão "+" — anexos com preview e caption

**Files:**
- Create: `components/inbox/composer/AttachMenu.tsx`
- Create: `components/inbox/composer/AttachmentPreviewDialog.tsx`
- Create: `hooks/inbox/useUploadMedia.ts`
- Modify: `components/inbox/Composer.tsx` (substituir o Paperclip desabilitado)
- Modify: `hooks/inbox/useSendMessage.ts` (aceitar storage_path/size; sem optimistic p/ mídia)
- Modify: `components/inbox/MessageBubble.tsx` (alargar `hasMedia`)
- Modify: `lib/ui/icons.ts` (adicionar `Plus`, `ImageSquare` se ausentes)
- Test: `tests/unit/composer-attach.test.tsx`

**Interfaces:**
- Consumes: endpoint da T1, schema da T2, `formatBytes` (Onda 1).
- Produces: fluxo completo selecionar → preview (thumb p/ imagem/vídeo; card p/ documento) + caption → enviar. `useUploadMedia(): mutation({conversationId, file}) → { storage_path, media_mime, media_size_bytes, kind }`.

- [ ] **Step 1: Testes (falhando)**

```tsx
// tests/unit/composer-attach.test.tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadResult = {
  storage_path: "org/conv/out-1.jpg",
  media_mime: "image/jpeg",
  media_size_bytes: 3,
  kind: "image" as const,
};
const uploadMock = vi.fn(async () => uploadResult);
const sendMock = vi.fn();

vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: uploadMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: sendMock, isPending: false }),
}));

import { Composer } from "@/components/inbox/Composer";

function renderComposer() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <Composer conversationId="conv-1" />
    </QueryClientProvider>,
  );
}

describe("Composer + anexos", () => {
  beforeEach(() => {
    uploadMock.mockClear();
    sendMock.mockClear();
  });

  it("botão Anexar abre o menu com as duas opções", () => {
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: /anexar/i }));
    expect(screen.getByText("Fotos e vídeos")).toBeInTheDocument();
    expect(screen.getByText("Documento")).toBeInTheDocument();
  });

  it("selecionar arquivo abre preview e enviar dispara upload + send com caption", async () => {
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: /anexar/i }));
    const input = document.querySelector('input[accept^="image"]') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], "foto.jpg", { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/legenda/i), { target: { value: "olha isso" } });
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));

    await waitFor(() => expect(uploadMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          conversation_id: "conv-1",
          type: "image",
          body: "olha isso",
          media_storage_path: "org/conv/out-1.jpg",
          media_mime: "image/jpeg",
          media_size_bytes: 3,
        }),
        expect.anything(),
      ),
    );
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — `npx vitest run tests/unit/composer-attach.test.tsx` → FAIL.

- [ ] **Step 3: `useUploadMedia`**

```ts
// hooks/inbox/useUploadMedia.ts
"use client";
import { useMutation } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";

export interface UploadedMedia {
  storage_path: string;
  media_mime: string;
  media_size_bytes: number;
  kind: "image" | "video" | "audio" | "document";
}

export function useUploadMedia() {
  return useMutation({
    mutationFn: async (args: { conversationId: string; file: File | Blob; filename?: string }) => {
      const form = new FormData();
      form.append("file", args.file, args.filename ?? (args.file instanceof File ? args.file.name : "audio"));
      const res = await fetch(`/api/v1/conversations/${args.conversationId}/media`, {
        method: "POST",
        body: form,
      });
      const json = (await res.json()) as { data?: UploadedMedia; error?: { code: string; message: string } };
      if (!res.ok || !json.data) {
        throw Object.assign(new Error(json.error?.message ?? "upload_failed"), {
          code: json.error?.code,
          status: res.status,
        });
      }
      return json.data;
    },
    onError: (err) => showApiError(err),
  });
}
```

- [ ] **Step 4: `AttachMenu` + `AttachmentPreviewDialog`**

```tsx
// components/inbox/composer/AttachMenu.tsx
"use client";
import { useRef } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { FileText, ImageSquare, Plus } from "@/lib/ui/icons";

interface Props {
  disabled?: boolean;
  onPick: (file: File) => void;
}

/** Menu "+" do composer (padrão WhatsApp): Fotos e vídeos / Documento. */
export function AttachMenu({ disabled, onPick }: Props) {
  const mediaRef = useRef<HTMLInputElement | null>(null);
  const docRef = useRef<HTMLInputElement | null>(null);

  const handle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onPick(file);
    e.target.value = ""; // permite re-selecionar o mesmo arquivo
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-9 w-9 shrink-0"
          aria-label="Anexar"
          disabled={disabled}
        >
          <Plus size={18} weight="regular" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-52 p-1">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted"
          onClick={() => mediaRef.current?.click()}
        >
          <ImageSquare size={18} weight="duotone" className="text-primary" aria-hidden />
          Fotos e vídeos
        </button>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted"
          onClick={() => docRef.current?.click()}
        >
          <FileText size={18} weight="duotone" className="text-primary" aria-hidden />
          Documento
        </button>
        <input ref={mediaRef} type="file" accept="image/*,video/*" className="hidden" onChange={handle} />
        <input
          ref={docRef}
          type="file"
          accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip"
          className="hidden"
          onChange={handle}
        />
      </PopoverContent>
    </Popover>
  );
}
```

```tsx
// components/inbox/composer/AttachmentPreviewDialog.tsx
"use client";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FileText } from "@/lib/ui/icons";
import { formatBytes } from "@/components/inbox/media/media-utils";

interface Props {
  file: File | null;
  sending: boolean;
  onCancel: () => void;
  onSend: (caption: string) => void;
}

/** Preview antes do envio (padrão WhatsApp): thumb ou card + legenda. */
export function AttachmentPreviewDialog({ file, sending, onCancel, onSend }: Props) {
  const [caption, setCaption] = useState("");
  useEffect(() => setCaption(""), [file]);

  const objectUrl = useMemo(() => (file && /^(image|video)\//.test(file.type) ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  if (!file) return null;
  const isImage = file.type.startsWith("image/");
  const isVideo = file.type.startsWith("video/");

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Enviar anexo</DialogTitle>
        </DialogHeader>
        <div className="flex items-center justify-center rounded-lg bg-muted/40 p-3">
          {isImage && objectUrl && (
            <img src={objectUrl} alt={file.name} className="max-h-64 rounded-md object-contain" />
          )}
          {isVideo && objectUrl && <video src={objectUrl} controls className="max-h-64 rounded-md" />}
          {!isImage && !isVideo && (
            <div className="flex items-center gap-3 py-4">
              <FileText size={28} weight="duotone" className="text-primary" aria-hidden />
              <div className="text-sm">
                <p className="font-medium">{file.name}</p>
                <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
              </div>
            </div>
          )}
        </div>
        <Input
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder="Legenda (opcional)"
          aria-label="Legenda"
          onKeyDown={(e) => e.key === "Enter" && !sending && onSend(caption.trim())}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={sending}>
            Cancelar
          </Button>
          <Button onClick={() => onSend(caption.trim())} disabled={sending}>
            Enviar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 5: Integrar no `Composer` + `useSendMessage` + `MessageBubble`**

`hooks/inbox/useSendMessage.ts`:
- `SendArgs` ganha `media_storage_path?: string;` e `media_size_bytes?: number;`.
- `onMutate`: primeira linha vira `if (args.media_storage_path || args.media_url) return {};` (sem optimistic p/ mídia — decisão registrada nas Global Constraints); o resto permanece.

`components/inbox/Composer.tsx`:
- Trocar o `Button` Paperclip desabilitado por `<AttachMenu disabled={isDisabled} onPick={setPendingFile} />`.
- Estado novo: `const [pendingFile, setPendingFile] = useState<File | null>(null);` + `const upload = useUploadMedia();`.
- Render (após o `div` principal, dentro do componente):

```tsx
      <AttachmentPreviewDialog
        file={pendingFile}
        sending={upload.isPending || send.isPending}
        onCancel={() => setPendingFile(null)}
        onSend={async (caption) => {
          if (!pendingFile) return;
          const uploaded = await upload.mutateAsync({ conversationId, file: pendingFile });
          send.mutate(
            {
              conversation_id: conversationId,
              type: uploaded.kind,
              body: caption || undefined,
              media_storage_path: uploaded.storage_path,
              media_mime: uploaded.media_mime,
              media_size_bytes: uploaded.media_size_bytes,
            },
            { onSuccess: () => setPendingFile(null) },
          );
        }}
      />
```

`components/inbox/MessageBubble.tsx`: `const hasMedia = Boolean(message.media_url || message.media_storage_path);` (forward note da Onda 1).

`lib/ui/icons.ts`: garantir exports `Plus` e `ImageSquare` (adicionar ao bloco actions se ausentes).

- [ ] **Step 6: Rodar tudo + commit**

`npx vitest run tests/unit/composer-attach.test.tsx` → PASS; `npm run typecheck` + `npx vitest run` + `npm run lint` → verdes.

```bash
git add components/inbox/composer/ hooks/inbox/useUploadMedia.ts components/inbox/Composer.tsx hooks/inbox/useSendMessage.ts components/inbox/MessageBubble.tsx lib/ui/icons.ts tests/unit/composer-attach.test.tsx
git commit -m "feat(composer): anexos com preview e caption (menu +, upload storage-first)"
```

---

### Task 4: Gravação de áudio (PTT estilo WhatsApp)

**Files:**
- Create: `components/inbox/composer/AudioRecorder.tsx`
- Modify: `components/inbox/Composer.tsx` (mic quando textarea vazio; send quando há texto)
- Modify: `lib/ui/icons.ts` (garantir `Microphone`, `Trash`, `StopCircle`)
- Test: `tests/unit/composer-audio-recorder.test.tsx`

**Interfaces:**
- Consumes: `useUploadMedia` (T3), `useSendMessage`.
- Produces: `<AudioRecorder conversationId disabled />` — fluxo: mic → gravando (timer + cancelar + enviar) → upload blob (mime real) → send `type: "audio"`.

- [ ] **Step 1: Testes (falhando)**

```tsx
// tests/unit/composer-audio-recorder.test.tsx
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadMock = vi.fn(async () => ({
  storage_path: "org/conv/out-a.ogg",
  media_mime: "audio/ogg",
  media_size_bytes: 5,
  kind: "audio" as const,
}));
const sendMock = vi.fn();
vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: uploadMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: sendMock, isPending: false }),
}));

import { AudioRecorder } from "@/components/inbox/composer/AudioRecorder";

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported = () => true;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  state = "inactive";
  mimeType = "audio/webm;codecs=opus";
  constructor(_stream: unknown, opts?: { mimeType?: string }) {
    if (opts?.mimeType) this.mimeType = opts.mimeType;
    FakeRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2])], { type: this.mimeType }) });
    this.onstop?.();
  }
}

describe("AudioRecorder", () => {
  beforeEach(() => {
    uploadMock.mockClear();
    sendMock.mockClear();
    FakeRecorder.instances = [];
    vi.stubGlobal("MediaRecorder", FakeRecorder as unknown as typeof MediaRecorder);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })),
      },
    });
  });

  it("mic inicia gravação e mostra timer + cancelar", async () => {
    render(<AudioRecorder conversationId="conv-1" />);
    fireEvent.click(screen.getByRole("button", { name: /gravar áudio/i }));
    expect(await screen.findByRole("button", { name: /cancelar gravação/i })).toBeInTheDocument();
    expect(screen.getByText(/0:0\d/)).toBeInTheDocument();
  });

  it("enviar para a gravação, sobe o blob com mime real e envia type audio", async () => {
    render(<AudioRecorder conversationId="conv-1" />);
    fireEvent.click(screen.getByRole("button", { name: /gravar áudio/i }));
    await screen.findByRole("button", { name: /enviar áudio/i });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /enviar áudio/i }));
    });
    await waitFor(() => expect(uploadMock).toHaveBeenCalled());
    const arg = uploadMock.mock.calls[0]![0] as { file: Blob };
    expect(arg.file.type).toContain("audio/");
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "audio", media_storage_path: "org/conv/out-a.ogg" }),
        expect.anything(),
      ),
    );
  });

  it("cancelar descarta sem upload", async () => {
    render(<AudioRecorder conversationId="conv-1" />);
    fireEvent.click(screen.getByRole("button", { name: /gravar áudio/i }));
    fireEvent.click(await screen.findByRole("button", { name: /cancelar gravação/i }));
    expect(uploadMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /gravar áudio/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: Implementar**

```tsx
// components/inbox/composer/AudioRecorder.tsx
"use client";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Microphone, PaperPlaneTilt, Trash } from "@/lib/ui/icons";
import { useSendMessage } from "@/hooks/inbox/useSendMessage";
import { useUploadMedia } from "@/hooks/inbox/useUploadMedia";

const PREFERRED_MIMES = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus"];

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return PREFERRED_MIMES.find((m) => MediaRecorder.isTypeSupported(m));
}

interface Props {
  conversationId: string;
  disabled?: boolean;
}

/** Gravação de voz estilo WhatsApp: mic → timer + cancelar/enviar → PTT. */
export function AudioRecorder({ conversationId, disabled }: Props) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardRef = useRef(false);
  const upload = useUploadMedia();
  const send = useSendMessage();

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  const cleanupStream = () => {
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
  };

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      discardRef.current = false;
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        cleanupStream();
        setRecording(false);
        setElapsed(0);
        if (discardRef.current || chunksRef.current.length === 0) return;
        const type = rec.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        void upload
          .mutateAsync({ conversationId, file: blob, filename: `ptt.${type.includes("ogg") ? "ogg" : "webm"}` })
          .then((uploaded) =>
            send.mutate(
              {
                conversation_id: conversationId,
                type: "audio",
                media_storage_path: uploaded.storage_path,
                media_mime: uploaded.media_mime,
                media_size_bytes: uploaded.media_size_bytes,
              },
              {},
            ),
          );
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      // permissão negada / sem mic — não gravar é o estado final; toast simples
      const { showApiError } = await import("@/components/feedback/ApiErrorToast");
      showApiError(new Error("Não consegui acessar o microfone. Verifique a permissão do navegador."));
    }
  }

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  if (!recording) {
    return (
      <Button
        type="button"
        size="icon"
        className="h-9 w-9 shrink-0"
        aria-label="Gravar áudio"
        onClick={start}
        disabled={disabled}
      >
        <Microphone size={16} weight="fill" aria-hidden />
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-9 w-9 shrink-0 text-destructive"
        aria-label="Cancelar gravação"
        onClick={() => {
          discardRef.current = true;
          recorderRef.current?.stop();
        }}
      >
        <Trash size={16} weight="regular" aria-hidden />
      </Button>
      <span className="flex items-center gap-1.5 text-sm tabular-nums text-destructive">
        <span className="h-2 w-2 animate-pulse rounded-full bg-destructive" aria-hidden />
        {fmt(elapsed)}
      </span>
      <Button
        type="button"
        size="icon"
        className="h-9 w-9 shrink-0"
        aria-label="Enviar áudio"
        onClick={() => recorderRef.current?.stop()}
      >
        <PaperPlaneTilt size={16} weight="fill" aria-hidden />
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: Integrar no Composer (mic ↔ send, padrão WhatsApp)**

Em `components/inbox/Composer.tsx`, substituir o botão Enviar fixo por:

```tsx
        {text.trim() ? (
          <Button
            type="button"
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={handleSubmit}
            disabled={isDisabled}
            aria-label="Enviar"
          >
            <PaperPlaneTilt size={16} weight="fill" aria-hidden />
          </Button>
        ) : (
          <AudioRecorder conversationId={conversationId} disabled={isDisabled} />
        )}
```

`lib/ui/icons.ts`: garantir `Microphone` e `Trash` exportados.

- [ ] **Step 5: Rodar tudo + commit**

Focado + `npm run typecheck` + `npx vitest run` → verdes.

```bash
git add components/inbox/composer/AudioRecorder.tsx components/inbox/Composer.tsx lib/ui/icons.ts tests/unit/composer-audio-recorder.test.tsx
git commit -m "feat(composer): gravação de áudio PTT estilo WhatsApp (mic, timer, cancelar/enviar)"
```

---

### Task 5: Emoji picker (lazy, estilo WhatsApp)

**Files:**
- Create: `components/inbox/composer/EmojiButton.tsx`
- Modify: `components/inbox/Composer.tsx` (botão smiley + inserção no cursor)
- Modify: `package.json` (deps novas: `@emoji-mart/react`, `@emoji-mart/data` — aprovadas nas Global Constraints)
- Modify: `lib/ui/icons.ts` (garantir `Smiley`)
- Test: `tests/unit/composer-emoji.test.tsx`

**Interfaces:**
- Produces: `<EmojiButton disabled onPick(emoji: string) />` — Popover com picker emoji-mart carregado por import dinâmico só ao abrir; `Composer` insere o emoji na posição do cursor do textarea.

- [ ] **Step 1: Instalar deps**

```bash
npm install @emoji-mart/react @emoji-mart/data
```

- [ ] **Step 2: Testes (falhando)**

```tsx
// tests/unit/composer-emoji.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// emoji-mart real é pesado p/ jsdom — mocka o módulo dinâmico com um picker fake.
vi.mock("@emoji-mart/react", () => ({
  default: ({ onEmojiSelect }: { onEmojiSelect: (e: { native: string }) => void }) => (
    <button type="button" onClick={() => onEmojiSelect({ native: "😀" })}>
      picker-fake
    </button>
  ),
}));
vi.mock("@emoji-mart/data", () => ({ default: {} }));

import { EmojiButton } from "@/components/inbox/composer/EmojiButton";

describe("EmojiButton", () => {
  it("abre o picker ao clicar e propaga o emoji escolhido", async () => {
    const onPick = vi.fn();
    render(<EmojiButton onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: /emoji/i }));
    fireEvent.click(await screen.findByText("picker-fake"));
    expect(onPick).toHaveBeenCalledWith("😀");
  });
});
```

- [ ] **Step 3: Rodar e ver falhar.**

- [ ] **Step 4: Implementar**

```tsx
// components/inbox/composer/EmojiButton.tsx
"use client";
import { lazy, Suspense, useState } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Smiley } from "@/lib/ui/icons";

// Lazy: o picker (+dados) só carrega quando o usuário abre — zero peso no bundle do inbox.
const Picker = lazy(() => import("@emoji-mart/react"));

interface Props {
  disabled?: boolean;
  onPick: (emoji: string) => void;
}

export function EmojiButton({ disabled, onPick }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-9 w-9 shrink-0"
          aria-label="Emoji"
          disabled={disabled}
        >
          <Smiley size={18} weight="regular" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-auto border-none p-0 shadow-lg">
        {open && (
          <Suspense fallback={<Skeleton className="h-[420px] w-[352px]" />}>
            <EmojiPickerLazy onPick={onPick} />
          </Suspense>
        )}
      </PopoverContent>
    </Popover>
  );
}

function EmojiPickerLazy({ onPick }: { onPick: (emoji: string) => void }) {
  return (
    <Picker
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- data dinâmico do emoji-mart
      data={async () => (await import("@emoji-mart/data")).default}
      locale="pt"
      previewPosition="none"
      onEmojiSelect={(e: { native: string }) => onPick(e.native)}
    />
  );
}
```

- [ ] **Step 5: Integrar no Composer (inserção no cursor)**

Em `components/inbox/Composer.tsx`, ao lado do `AttachMenu`:

```tsx
        <EmojiButton
          disabled={isDisabled}
          onPick={(emoji) => {
            const ta = taRef.current;
            if (!ta) {
              setText((t) => t + emoji);
              return;
            }
            const start = ta.selectionStart ?? text.length;
            const end = ta.selectionEnd ?? text.length;
            const next = text.slice(0, start) + emoji + text.slice(end);
            setText(next);
            requestAnimationFrame(() => {
              ta.focus();
              ta.selectionStart = ta.selectionEnd = start + emoji.length;
              autoresize();
            });
          }}
        />
```

`lib/ui/icons.ts`: garantir `Smiley`.

- [ ] **Step 6: Rodar tudo + commit**

Focado + typecheck + lint + suíte completa → verdes. Verificar tamanho: `npm run build` NÃO precisa rodar aqui (CI cobre), mas conferir que o import é dinâmico (nenhum import estático de emoji-mart fora do `lazy`).

```bash
git add components/inbox/composer/EmojiButton.tsx components/inbox/Composer.tsx lib/ui/icons.ts package.json package-lock.json tests/unit/composer-emoji.test.tsx
git commit -m "feat(composer): emoji picker lazy estilo WhatsApp (emoji-mart, locale pt)"
```

---

### Task 6: Prova E2E real ponta a ponta + HANDOFF

**Files:**
- Modify: `HANDOFF-inbox-multimodal.md`
- Evidência: `.superpowers/evidence/inbox-multimodal-onda2-*.png`

- [ ] **Step 1: Ambiente** — dev server + WAHA up (religar se caiu: `npm run dev` bg; container `deskcomm-waha`); sessão `e2e-wave12-…` WORKING; login admin E2E.

- [ ] **Step 2: Envio real pelo CRM (Playwright)** — na conversa real: (a) enviar IMAGEM com caption pelo "+"; (b) enviar PDF; (c) gravar e enviar ÁUDIO (conceder permissão de mic via Playwright `--use-fake-ui-for-media-stream` ou permissão do contexto); (d) inserir emoji pelo picker num texto e enviar. Screenshots de cada etapa (menu aberto, preview com caption, gravação com timer, picker aberto).

- [ ] **Step 3: Confirmação DUPLA do recebimento** — (1) SQL: mensagens outbound com `status='sent'`, `external_id` preenchido e depois `ack>=2` (delivered) via webhook; (2) **Rafael confirma no WhatsApp real** que imagem+caption, PDF, áudio (como MENSAGEM DE VOZ, não arquivo) e texto com emoji chegaram. Se o áudio chegar como arquivo (contingência NOWEB Core sem convert), registrar e decidir ffmpeg server-side.

- [ ] **Step 4: UX check** — bolhas outbound renderizam a mídia enviada (gate `media_storage_path` da T3); acks progridem na UI; console limpo; medidas do composer (menu, preview, recorder) por `getBoundingClientRect`.

- [ ] **Step 5: Suíte final + HANDOFF + commit** — `npm run typecheck` + `npm run lint` + `npx vitest run` verdes; HANDOFF atualizado (Onda 2 → status + provas + contingência de voz) e commitado.

---

## Self-review (feito na escrita)

- **Cobertura do spec (Onda 2):** botão "+" com preview/caption (T3), gravação PTT (T4), emoji picker lazy (T5), `WahaClient` com sendImage/sendVideo/sendFile/sendVoice e handler deixando de descartar mídia (T2), upload storage-first com URL ao WAHA (T1+T2), normalização outbound = mesma costura Meta (storage_path+mime). Forward note da Onda 1 (gate `hasMedia`) fechada na T3.
- **Sem placeholders:** código/comandos/expected concretos em todos os steps.
- **Consistência:** `UploadedMedia.kind` (T1/T3) = `MessageKind` (T1); `wahaSendPlanFor(kind|type, …)` usa os mesmos valores do `messageTypeSchema`; `useUploadMedia` retorna exatamente o shape que T3/T4 consomem; aria-labels dos testes batem com os componentes.
