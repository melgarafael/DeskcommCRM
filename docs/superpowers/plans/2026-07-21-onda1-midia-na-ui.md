# Onda 1 — Mídia Real na UI do Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Toda mídia recebida aparece DE VERDADE no chat: imagem com lightbox, vídeo playável, áudio com player estilo WhatsApp, figurinha inline e documento como card de download — substituindo os placeholders do `MessageBubble`.

**Architecture:** Componentes novos em `components/inbox/media/` (um por tipo + dispatcher `MediaRenderer`), todos consumindo `GET /api/v1/messages/{id}/media` (Onda 0) DIRETO como `src` — o browser segue o 302 pra signed URL; cookie de sessão vai junto (same-origin). Nenhuma mudança de backend. Âncora de UX: WhatsApp Web.

**Tech Stack:** React 19 client components, Tailwind + tokens do design system (Sage), shadcn Dialog (lightbox), Phosphor via `@/lib/ui/icons`, Vitest + @testing-library/react (jsdom).

## Global Constraints

- Spec mestre: `docs/superpowers/specs/2026-07-21-inbox-multimodal-design.md` (Onda 1). Épico: handoff `HANDOFF-inbox-multimodal.md` (protocolo de prova visível — OBRIGATÓRIO).
- `src` de mídia é SEMPRE `/api/v1/messages/{id}/media` — NUNCA `media_url` (URL do WAHA) nem signed URL construída no cliente.
- Ícones SÓ via `@/lib/ui/icons` (ADR-05) — se faltar ícone, adicionar ao wrapper.
- Player de áudio: play/pause, barra de progresso "seekável", tempo `m:ss`, velocidade ciclando 1x → 1.5x → 2x.
- Figurinha: inline ~síntese WhatsApp (imagem ~160px, SEM bolha de fundo quando não há body).
- Documento: card com nome do arquivo (da extensão/mime), tamanho formatado (`formatBytes`) e download.
- Estados obrigatórios em todo tipo visual: carregando (skeleton) e erro ("Mídia indisponível", ícone + texto, sem quebrar a bolha).
- Caption: mensagem com `body` E mídia renderiza a mídia EM CIMA e o texto embaixo (padrão WhatsApp).
- Sem nova dependência npm. Sem `console.log`. Typecheck/lint/testes verdes por task (nunca validar via `cmd | tail`).
- Prova final: Playwright na conversa REAL (5 mídias da Onda 0), medidas por ferramenta (`getBoundingClientRect`), console limpo, screenshots em `.superpowers/evidence/`.

---

### Task 1: Utilitários de mídia (`media-utils.ts`)

**Files:**
- Create: `components/inbox/media/media-utils.ts`
- Test: `tests/unit/inbox-media-utils.test.ts`

**Interfaces:**
- Produces (consumidos pelas tasks 2-5):
  - `mediaSrc(messageId: string): string` → `/api/v1/messages/${messageId}/media`
  - `formatBytes(bytes: number | null | undefined): string` → `"—"` | `"853 B"` | `"41,6 KB"` | `"12,6 MB"` (pt-BR, 1 casa decimal, base 1024)
  - `mediaFileLabel(mime: string | null, storagePath: string | null): string` → rótulo tipo `"PDF"`, `"MP4"`, `"Arquivo"` (extensão do storagePath em maiúsculas; senão sufixo do mime; senão `"Arquivo"`)

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/unit/inbox-media-utils.test.ts
import { describe, expect, it } from "vitest";

import {
  formatBytes,
  mediaFileLabel,
  mediaSrc,
} from "@/components/inbox/media/media-utils";

describe("mediaSrc", () => {
  it("monta a URL do endpoint da Onda 0", () => {
    expect(mediaSrc("abc-123")).toBe("/api/v1/messages/abc-123/media");
  });
});

describe("formatBytes", () => {
  it("formata em pt-BR base 1024", () => {
    expect(formatBytes(853)).toBe("853 B");
    expect(formatBytes(41598)).toBe("40,6 KB");
    expect(formatBytes(12563831)).toBe("12,0 MB");
  });
  it("devolve travessão sem valor", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(0)).toBe("—");
  });
});

describe("mediaFileLabel", () => {
  it("prefere a extensão do storage path", () => {
    expect(mediaFileLabel("application/pdf", "org/conv/msg.pdf")).toBe("PDF");
    expect(mediaFileLabel("application/mp4", "org/conv/msg.mp4")).toBe("MP4");
  });
  it("cai pro sufixo do mime sem path", () => {
    expect(mediaFileLabel("application/pdf", null)).toBe("PDF");
  });
  it("fallback genérico", () => {
    expect(mediaFileLabel(null, null)).toBe("Arquivo");
    expect(mediaFileLabel("application/octet-stream", "org/conv/msg.bin")).toBe("Arquivo");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/unit/inbox-media-utils.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar**

```ts
// components/inbox/media/media-utils.ts
/**
 * Helpers puros da renderização de mídia no inbox (Onda 1).
 * A mídia é SEMPRE servida por /api/v1/messages/{id}/media (Onda 0) —
 * o browser segue o 302 pra signed URL; nunca usar media_url do WAHA.
 */

export function mediaSrc(messageId: string): string {
  return `/api/v1/messages/${messageId}/media`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toLocaleString("pt-BR", { maximumFractionDigits: 1, minimumFractionDigits: 1 })} KB`;
  const mb = kb / 1024;
  return `${mb.toLocaleString("pt-BR", { maximumFractionDigits: 1, minimumFractionDigits: 1 })} MB`;
}

/** Rótulo curto do arquivo: extensão do path ("PDF") > sufixo do mime > "Arquivo". */
export function mediaFileLabel(mime: string | null, storagePath: string | null): string {
  const ext = storagePath?.split(".").pop()?.toLowerCase();
  if (ext && ext !== "bin") return ext.toUpperCase();
  const sub = mime?.split(";")[0]?.split("/")[1]?.toLowerCase();
  if (sub && !["octet-stream", "bin"].includes(sub)) return sub.toUpperCase();
  return "Arquivo";
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/unit/inbox-media-utils.test.ts`
Expected: PASS. (Se `formatBytes(41598)` divergir na casa decimal, o TESTE está certo — ajuste a implementação, não o teste: 41598/1024 = 40,6.)

- [ ] **Step 5: Commit**

```bash
git add components/inbox/media/media-utils.ts tests/unit/inbox-media-utils.test.ts
git commit -m "feat(inbox-media): utilitários de mídia (mediaSrc, formatBytes, mediaFileLabel)"
```

---

### Task 2: Imagem com lightbox + Figurinha

**Files:**
- Create: `components/inbox/media/ImageMedia.tsx`
- Create: `components/inbox/media/StickerMedia.tsx`
- Create: `components/inbox/media/MediaUnavailable.tsx`
- Test: `tests/unit/inbox-media-image.test.tsx`

**Interfaces:**
- Consumes: `mediaSrc` (Task 1), `Dialog/DialogContent/DialogTitle` de `@/components/ui/dialog`, `ImageIcon` de `@/lib/ui/icons`, `Skeleton` de `@/components/ui/skeleton`.
- Produces: `<ImageMedia messageId alt />`, `<StickerMedia messageId />`, `<MediaUnavailable kind="Imagem" | ... />` (fallback compartilhado pelas tasks 3-5).

- [ ] **Step 1: Escrever os testes que falham**

```tsx
// tests/unit/inbox-media-image.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ImageMedia } from "@/components/inbox/media/ImageMedia";
import { StickerMedia } from "@/components/inbox/media/StickerMedia";

describe("ImageMedia", () => {
  it("renderiza a imagem apontando pro endpoint de mídia", () => {
    render(<ImageMedia messageId="m1" alt="Imagem recebida" />);
    const img = screen.getByAltText("Imagem recebida");
    expect(img).toHaveAttribute("src", "/api/v1/messages/m1/media");
  });

  it("abre o lightbox ao clicar", () => {
    render(<ImageMedia messageId="m1" alt="Imagem recebida" />);
    fireEvent.load(screen.getByAltText("Imagem recebida"));
    fireEvent.click(screen.getByRole("button", { name: /ampliar imagem/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("mostra fallback quando a imagem falha", () => {
    render(<ImageMedia messageId="m1" alt="Imagem recebida" />);
    fireEvent.error(screen.getByAltText("Imagem recebida"));
    expect(screen.getByText("Mídia indisponível")).toBeInTheDocument();
  });
});

describe("StickerMedia", () => {
  it("renderiza a figurinha sem moldura de bolha", () => {
    render(<StickerMedia messageId="m2" />);
    const img = screen.getByAltText("Figurinha");
    expect(img).toHaveAttribute("src", "/api/v1/messages/m2/media");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/unit/inbox-media-image.test.tsx`
Expected: FAIL (módulos não existem).

- [ ] **Step 3: Implementar os três componentes**

```tsx
// components/inbox/media/MediaUnavailable.tsx
import { ImageIcon } from "@/lib/ui/icons";

/** Fallback compartilhado quando a mídia não carrega (expirada/removida). */
export function MediaUnavailable({ kind }: { kind: string }) {
  return (
    <div className="flex h-24 w-56 flex-col items-center justify-center gap-1 rounded-lg bg-background/40 text-muted-foreground">
      <ImageIcon size={20} weight="duotone" aria-hidden />
      <span className="text-xs">Mídia indisponível</span>
      <span className="sr-only">{kind}</span>
    </div>
  );
}
```

```tsx
// components/inbox/media/ImageMedia.tsx
"use client";
import { useState } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { MediaUnavailable } from "./MediaUnavailable";
import { mediaSrc } from "./media-utils";

interface Props {
  messageId: string;
  alt: string;
}

/** Miniatura na bolha + lightbox (Dialog) no clique. Padrão WhatsApp Web. */
export function ImageMedia({ messageId, alt }: Props) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [open, setOpen] = useState(false);
  const src = mediaSrc(messageId);

  if (state === "error") return <MediaUnavailable kind="Imagem" />;

  return (
    <>
      <button
        type="button"
        aria-label="Ampliar imagem"
        onClick={() => setOpen(true)}
        className="relative block cursor-zoom-in overflow-hidden rounded-lg focus-visible:outline-2 focus-visible:outline-ring"
      >
        {state === "loading" && <Skeleton className="absolute inset-0 h-full w-full" />}
        <img
          src={src}
          alt={alt}
          loading="lazy"
          onLoad={() => setState("ready")}
          onError={() => setState("error")}
          className={cn(
            "max-h-72 w-auto max-w-full rounded-lg object-cover",
            state === "loading" && "min-h-32 min-w-48 opacity-0",
          )}
        />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-4xl border-none bg-transparent p-0 shadow-none">
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          <img src={src} alt={alt} className="max-h-[85vh] w-full rounded-lg object-contain" />
        </DialogContent>
      </Dialog>
    </>
  );
}
```

```tsx
// components/inbox/media/StickerMedia.tsx
"use client";
import { useState } from "react";

import { MediaUnavailable } from "./MediaUnavailable";
import { mediaSrc } from "./media-utils";

/** Figurinha: inline, sem bolha — como no WhatsApp. */
export function StickerMedia({ messageId }: { messageId: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <MediaUnavailable kind="Figurinha" />;
  return (
    <img
      src={mediaSrc(messageId)}
      alt="Figurinha"
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-40 w-40 object-contain"
    />
  );
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/unit/inbox-media-image.test.tsx`
Expected: PASS (4 testes). Se `toBeInTheDocument` não existir, confira que o setup de testes já importa `@testing-library/jest-dom` (padrão do repo — ver `vitest.config`/`tests/setup`); siga o padrão dos testes `.tsx` existentes (ex.: `tests/unit/inbox-filters-scope.test.tsx`).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add components/inbox/media/ tests/unit/inbox-media-image.test.tsx
git commit -m "feat(inbox-media): ImageMedia com lightbox, StickerMedia e fallback compartilhado"
```

---

### Task 3: Player de áudio estilo WhatsApp

**Files:**
- Create: `components/inbox/media/AudioPlayer.tsx`
- Test: `tests/unit/inbox-media-audio.test.tsx`

**Interfaces:**
- Consumes: `mediaSrc` (Task 1), `Play`/`Pause` de `@/lib/ui/icons`, `MediaUnavailable` (Task 2), `cn` de `@/lib/utils`.
- Produces: `<AudioPlayer messageId isOutbound />` — play/pause, progresso seekável (`<input type="range">`), tempo `m:ss`, velocidade 1x→1.5x→2x.

- [ ] **Step 1: Escrever os testes que falham**

```tsx
// tests/unit/inbox-media-audio.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { AudioPlayer } from "@/components/inbox/media/AudioPlayer";

beforeAll(() => {
  // jsdom não implementa playback — mocka o mínimo do HTMLMediaElement.
  Object.defineProperty(window.HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  Object.defineProperty(window.HTMLMediaElement.prototype, "pause", {
    configurable: true,
    value: vi.fn(),
  });
});

describe("AudioPlayer", () => {
  it("renderiza com src do endpoint e controles", () => {
    render(<AudioPlayer messageId="m3" isOutbound={false} />);
    expect(screen.getByRole("button", { name: /reproduzir/i })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: /progresso/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /velocidade/i })).toHaveTextContent("1x");
  });

  it("alterna play/pause", () => {
    render(<AudioPlayer messageId="m3" isOutbound={false} />);
    const btn = screen.getByRole("button", { name: /reproduzir/i });
    fireEvent.click(btn);
    expect(screen.getByRole("button", { name: /pausar/i })).toBeInTheDocument();
  });

  it("cicla a velocidade 1x → 1.5x → 2x → 1x", () => {
    render(<AudioPlayer messageId="m3" isOutbound={false} />);
    const rate = screen.getByRole("button", { name: /velocidade/i });
    fireEvent.click(rate);
    expect(rate).toHaveTextContent("1.5x");
    fireEvent.click(rate);
    expect(rate).toHaveTextContent("2x");
    fireEvent.click(rate);
    expect(rate).toHaveTextContent("1x");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/unit/inbox-media-audio.test.tsx`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar**

```tsx
// components/inbox/media/AudioPlayer.tsx
"use client";
import { useEffect, useRef, useState } from "react";

import { Pause, Play } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { MediaUnavailable } from "./MediaUnavailable";
import { mediaSrc } from "./media-utils";

const RATES = [1, 1.5, 2] as const;

function fmt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

interface Props {
  messageId: string;
  isOutbound: boolean;
}

/** Player de voz estilo WhatsApp: play/pause, progresso seekável, tempo, 1x/1.5x/2x. */
export function AudioPlayer({ messageId, isOutbound }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [rateIdx, setRateIdx] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setCurrent(el.currentTime);
    const onMeta = () => setDuration(el.duration);
    const onEnded = () => setPlaying(false);
    const onError = () => setFailed(true);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("ended", onEnded);
    el.addEventListener("error", onError);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("error", onError);
    };
  }, []);

  if (failed) return <MediaUnavailable kind="Áudio" />;

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      setPlaying(false);
    } else {
      void el.play();
      setPlaying(true);
    }
  };

  const cycleRate = () => {
    const next = (rateIdx + 1) % RATES.length;
    setRateIdx(next);
    if (audioRef.current) audioRef.current.playbackRate = RATES[next];
  };

  const seek = (value: number) => {
    if (audioRef.current) audioRef.current.currentTime = value;
    setCurrent(value);
  };

  return (
    <div className="flex w-60 items-center gap-2 py-1">
      <audio ref={audioRef} src={mediaSrc(messageId)} preload="metadata" />
      <button
        type="button"
        aria-label={playing ? "Pausar áudio" : "Reproduzir áudio"}
        onClick={toggle}
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors",
          isOutbound
            ? "bg-primary-foreground/20 text-primary-foreground hover:bg-primary-foreground/30"
            : "bg-primary/10 text-primary hover:bg-primary/20",
        )}
      >
        {playing ? (
          <Pause size={16} weight="fill" aria-hidden />
        ) : (
          <Play size={16} weight="fill" aria-hidden />
        )}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <input
          type="range"
          aria-label="Progresso do áudio"
          min={0}
          max={duration || 1}
          step={0.1}
          value={current}
          onChange={(e) => seek(Number(e.target.value))}
          className="h-1 w-full cursor-pointer accent-current"
        />
        <span className="text-[10px] tabular-nums opacity-70">
          {fmt(current)} / {fmt(duration)}
        </span>
      </div>
      <button
        type="button"
        aria-label={`Velocidade de reprodução: ${RATES[rateIdx]}x`}
        onClick={cycleRate}
        className={cn(
          "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums transition-colors",
          isOutbound
            ? "bg-primary-foreground/20 text-primary-foreground"
            : "bg-primary/10 text-primary",
        )}
      >
        {RATES[rateIdx]}x
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/unit/inbox-media-audio.test.tsx`
Expected: PASS (3 testes).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add components/inbox/media/AudioPlayer.tsx tests/unit/inbox-media-audio.test.tsx
git commit -m "feat(inbox-media): AudioPlayer estilo WhatsApp (seek, tempo, 1x/1.5x/2x)"
```

---

### Task 4: Vídeo + card de documento

**Files:**
- Create: `components/inbox/media/VideoMedia.tsx`
- Create: `components/inbox/media/DocumentCard.tsx`
- Modify: `lib/ui/icons.ts` (adicionar `DownloadSimple` ao bloco de exports, em ordem com os vizinhos)
- Test: `tests/unit/inbox-media-docvideo.test.tsx`

**Interfaces:**
- Consumes: `mediaSrc`/`formatBytes`/`mediaFileLabel` (Task 1), `FileText`/`DownloadSimple` de `@/lib/ui/icons`, `MediaUnavailable` (Task 2).
- Produces: `<VideoMedia messageId />`, `<DocumentCard messageId mime sizeBytes storagePath isOutbound />`.

- [ ] **Step 1: Escrever os testes que falham**

```tsx
// tests/unit/inbox-media-docvideo.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DocumentCard } from "@/components/inbox/media/DocumentCard";
import { VideoMedia } from "@/components/inbox/media/VideoMedia";

describe("VideoMedia", () => {
  it("renderiza <video> com controles apontando pro endpoint", () => {
    const { container } = render(<VideoMedia messageId="m4" />);
    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute("src", "/api/v1/messages/m4/media");
    expect(video).toHaveAttribute("controls");
  });

  it("mostra fallback quando o vídeo falha", () => {
    const { container } = render(<VideoMedia messageId="m4" />);
    fireEvent.error(container.querySelector("video")!);
    expect(screen.getByText("Mídia indisponível")).toBeInTheDocument();
  });
});

describe("DocumentCard", () => {
  it("mostra rótulo, tamanho e link de download", () => {
    render(
      <DocumentCard
        messageId="m5"
        mime="application/pdf"
        sizeBytes={3179614}
        storagePath="org/conv/m5.pdf"
        isOutbound={false}
      />,
    );
    expect(screen.getByText("PDF")).toBeInTheDocument();
    expect(screen.getByText(/3,0 MB/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /baixar documento/i });
    expect(link).toHaveAttribute("href", "/api/v1/messages/m5/media");
    expect(link).toHaveAttribute("target", "_blank");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/unit/inbox-media-docvideo.test.tsx`
Expected: FAIL (módulos não existem).

- [ ] **Step 3: Implementar (+ ícone)**

Em `lib/ui/icons.ts`, adicionar `DownloadSimple,` ao bloco `// actions` (mesmo export list dos vizinhos `PaperPlaneTilt`, `Check`…).

```tsx
// components/inbox/media/VideoMedia.tsx
"use client";
import { useState } from "react";

import { MediaUnavailable } from "./MediaUnavailable";
import { mediaSrc } from "./media-utils";

/** Vídeo inline com controles nativos (padrão WhatsApp Web). */
export function VideoMedia({ messageId }: { messageId: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <MediaUnavailable kind="Vídeo" />;
  return (
    <video
      src={mediaSrc(messageId)}
      controls
      preload="metadata"
      onError={() => setFailed(true)}
      className="max-h-72 w-full max-w-sm rounded-lg bg-black/5"
    />
  );
}
```

```tsx
// components/inbox/media/DocumentCard.tsx
import { DownloadSimple, FileText } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { formatBytes, mediaFileLabel, mediaSrc } from "./media-utils";

interface Props {
  messageId: string;
  mime: string | null;
  sizeBytes: number | null;
  storagePath: string | null;
  isOutbound: boolean;
}

/** Card de documento: rótulo (PDF/MP4/…), tamanho e download. */
export function DocumentCard({ messageId, mime, sizeBytes, storagePath, isOutbound }: Props) {
  const label = mediaFileLabel(mime, storagePath);
  return (
    <a
      href={mediaSrc(messageId)}
      target="_blank"
      rel="noreferrer"
      aria-label="Baixar documento"
      className={cn(
        "flex w-60 items-center gap-3 rounded-lg p-2 transition-colors",
        isOutbound
          ? "bg-primary-foreground/10 hover:bg-primary-foreground/20"
          : "bg-background/60 hover:bg-background",
      )}
    >
      <span
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
          isOutbound ? "bg-primary-foreground/20" : "bg-primary/10 text-primary",
        )}
      >
        <FileText size={20} weight="duotone" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{label}</span>
        <span className="block text-xs opacity-70">{formatBytes(sizeBytes)}</span>
      </span>
      <DownloadSimple size={18} className="shrink-0 opacity-70" aria-hidden />
    </a>
  );
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/unit/inbox-media-docvideo.test.tsx`
Expected: PASS (3 testes).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add components/inbox/media/VideoMedia.tsx components/inbox/media/DocumentCard.tsx lib/ui/icons.ts tests/unit/inbox-media-docvideo.test.tsx
git commit -m "feat(inbox-media): VideoMedia e DocumentCard (+ ícone DownloadSimple)"
```

---

### Task 5: `MediaRenderer` + integração no `MessageBubble`

**Files:**
- Create: `components/inbox/media/MediaRenderer.tsx`
- Modify: `components/inbox/MessageBubble.tsx` (remover `MediaPlaceholder` L19-34 e o uso na L87; integrar renderer; caso figurinha sem bolha)
- Test: `tests/unit/inbox-media-renderer.test.tsx`

**Interfaces:**
- Consumes: todos os componentes das tasks 2-4; `Message` de `@/lib/types/messaging`.
- Produces: `<MediaRenderer message />` — dispatcher por `message.type`; `MessageBubble` renderiza mídia acima do body (caption) e figurinha sem moldura.

- [ ] **Step 1: Escrever os testes que falham**

```tsx
// tests/unit/inbox-media-renderer.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MediaRenderer } from "@/components/inbox/media/MediaRenderer";
import { MessageBubble } from "@/components/inbox/MessageBubble";
import type { Message } from "@/lib/types/messaging";

function msg(over: Partial<Message>): Message {
  return {
    id: "m1",
    conversation_id: "c1",
    contact_id: "ct1",
    channel_session_id: "s1",
    external_id: "x1",
    type: "text",
    direction: "inbound",
    status: "delivered",
    ack: null,
    body: null,
    media_url: "http://waha/file",
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: "external_device",
    sent_at: "2026-07-21T20:00:00.000Z",
    delivered_at: null,
    read_at: null,
    error_code: null,
    error_message: null,
    metadata: {},
    created_at: "2026-07-21T20:00:00.000Z",
  } as Message;
}

describe("MediaRenderer", () => {
  it("image → ImageMedia", () => {
    render(<MediaRenderer message={msg({ type: "image" })} />);
    expect(screen.getByAltText("Imagem recebida")).toBeInTheDocument();
  });
  it("sticker → StickerMedia", () => {
    render(<MediaRenderer message={msg({ type: "sticker" })} />);
    expect(screen.getByAltText("Figurinha")).toBeInTheDocument();
  });
  it("audio → AudioPlayer", () => {
    render(<MediaRenderer message={msg({ type: "audio" })} />);
    expect(screen.getByRole("button", { name: /reproduzir/i })).toBeInTheDocument();
  });
  it("video → VideoMedia", () => {
    const { container } = render(<MediaRenderer message={msg({ type: "video" })} />);
    expect(container.querySelector("video")).not.toBeNull();
  });
  it("document (e tipos desconhecidos) → DocumentCard", () => {
    render(<MediaRenderer message={msg({ type: "document", media_mime: "application/pdf" })} />);
    expect(screen.getByRole("link", { name: /baixar documento/i })).toBeInTheDocument();
  });
});

describe("MessageBubble com mídia", () => {
  it("renderiza mídia E caption juntos", () => {
    render(<MessageBubble message={msg({ type: "image", body: "olha isso" })} />);
    expect(screen.getByAltText("Imagem recebida")).toBeInTheDocument();
    expect(screen.getByText("olha isso")).toBeInTheDocument();
  });
  it("mensagem só-texto não renderiza mídia", () => {
    render(<MessageBubble message={msg({ type: "text", body: "oi", media_url: null })} />);
    expect(screen.queryByAltText("Imagem recebida")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/unit/inbox-media-renderer.test.tsx`
Expected: FAIL (MediaRenderer não existe).

- [ ] **Step 3: Implementar o dispatcher**

```tsx
// components/inbox/media/MediaRenderer.tsx
"use client";
import type { Message } from "@/lib/types/messaging";

import { AudioPlayer } from "./AudioPlayer";
import { DocumentCard } from "./DocumentCard";
import { ImageMedia } from "./ImageMedia";
import { StickerMedia } from "./StickerMedia";
import { VideoMedia } from "./VideoMedia";

/**
 * Dispatcher de mídia por message.type (Onda 1). Tipo com mídia mas sem
 * renderer dedicado (location/contact futuros) cai no DocumentCard —
 * sempre dá pro atendente baixar o arquivo.
 */
export function MediaRenderer({ message }: { message: Message }) {
  const isOutbound = message.direction === "outbound";
  switch (message.type) {
    case "image":
      return <ImageMedia messageId={message.id} alt="Imagem recebida" />;
    case "sticker":
      return <StickerMedia messageId={message.id} />;
    case "audio":
      return <AudioPlayer messageId={message.id} isOutbound={isOutbound} />;
    case "video":
      return <VideoMedia messageId={message.id} />;
    default:
      return (
        <DocumentCard
          messageId={message.id}
          mime={message.media_mime}
          sizeBytes={message.media_size_bytes}
          storagePath={message.media_storage_path}
          isOutbound={isOutbound}
        />
      );
  }
}
```

- [ ] **Step 4: Integrar no `MessageBubble`**

Em `components/inbox/MessageBubble.tsx`:

1. Remover a função `MediaPlaceholder` (L19-34) e os imports que ficarem órfãos (`ImageIcon`, `MusicNote` — manter `FileText` só se ainda usado; conferir).
2. Adicionar import: `import { MediaRenderer } from "@/components/inbox/media/MediaRenderer";`
3. Calcular no corpo do componente (após `isFailed`):

```tsx
  const hasMedia = Boolean(message.media_url);
  // Figurinha sem caption: sem moldura de bolha (padrão WhatsApp).
  const isBareSticker = hasMedia && message.type === "sticker" && !message.body;
```

4. Trocar a moldura externa da bolha — a `div` interna com classes `max-w-[75%] rounded-2xl px-3 py-2...` passa a ser condicional:

```tsx
      <div
        className={cn(
          "max-w-[75%] text-sm",
          isBareSticker
            ? "px-0 py-0"
            : cn(
                "rounded-2xl px-3 py-2 shadow-sm",
                isOutbound
                  ? "rounded-br-sm bg-primary text-primary-foreground"
                  : "rounded-bl-sm bg-muted text-foreground",
              ),
          isFailed && "border border-destructive",
        )}
      >
```

5. Substituir o bloco do body + placeholder (L83-87) por: mídia PRIMEIRO, caption depois:

```tsx
        {hasMedia && (
          <div className={cn(message.body && "mb-1")}>
            <MediaRenderer message={message} />
          </div>
        )}

        {message.body && (
          <p className="whitespace-pre-wrap break-words leading-snug">{message.body}</p>
        )}
```

6. O rodapé (hora/ack) permanece como está — em `isBareSticker` ele continua visível abaixo da figurinha (aceitável; WhatsApp faz o mesmo com hora sobreposta, não replicar overlay).

- [ ] **Step 5: Rodar e ver passar + suíte completa**

Run: `npx vitest run tests/unit/inbox-media-renderer.test.tsx`
Expected: PASS (7 testes).
Run: `npm run typecheck` e `npx vitest run`
Expected: zerado / todos verdes (nenhum teste antigo referencia `MediaPlaceholder`).

- [ ] **Step 6: Commit**

```bash
git add components/inbox/media/MediaRenderer.tsx components/inbox/MessageBubble.tsx tests/unit/inbox-media-renderer.test.tsx
git commit -m "feat(inbox-media): MediaRenderer integrado ao MessageBubble (caption + figurinha sem bolha)"
```

---

### Task 6: Prova E2E real (Playwright) + medidas + HANDOFF

**Files:**
- Modify: `HANDOFF-inbox-multimodal.md`
- Evidência: `.superpowers/evidence/inbox-multimodal-onda1-*.png`

**Interfaces:**
- Consumes: dev server + conversa real da Onda 0 (5 mídias persistidas, conversa `bcb64692-…`).

- [ ] **Step 1: Ambiente e navegação**

Dev server + WAHA já rodando (Onda 0). Login admin E2E (TOTP em `.e2e-creds.json`), abrir `/app/inbox?id=<conversa real>`.

- [ ] **Step 2: Prova visual + funcional de cada tipo**

Na conversa real, com Playwright:
- Screenshot da thread completa (imagem, vídeo, áudio, figurinha, documento renderizados de verdade).
- Clicar na imagem → lightbox abre → screenshot → fechar.
- Clicar play no áudio → aguardar ~2s → `browser_evaluate` em `document.querySelector("audio")`: `currentTime > 0` E `paused === false`. Clicar no botão de velocidade → `playbackRate === 1.5`.
- Vídeo: `readyState >= 1` (metadata carregada) e `duration > 0`.
- Documento: link com `href` correto e `target="_blank"`.

- [ ] **Step 3: Medidas por ferramenta (não a olho)**

`browser_evaluate` com `getBoundingClientRect()`: imagem na bolha ≤ 288px de altura (max-h-72); figurinha ~160px; player de áudio ~240px de largura; NENHUM elemento estourando a largura da bolha (`bubble.width ≥ media.width`). Reportar os números no HANDOFF.

- [ ] **Step 4: Console limpo + UX check**

`browser_console_messages`: nenhum erro novo (401 pré-existente de `crm_leads` no CRMSidePanel não conta — registrado no épico anterior). Avaliar experiência: skeleton aparece? lightbox fecha com Esc? player responde rápido? Se algo estiver ruim, CORRIGIR antes de reportar.

- [ ] **Step 5: Suíte final + HANDOFF + commit**

```bash
npm run typecheck
npm run lint
npx vitest run
```

Expected: tudo verde. Atualizar `HANDOFF-inbox-multimodal.md` (Onda 1 → ✅ com provas e medidas) e commitar.

---

## Self-review (feito na escrita)

- **Cobertura do spec (Onda 1):** imagem+lightbox (T2), vídeo (T4), áudio player com velocidade (T3), figurinha inline sem bolha (T2+T5), documento com nome/tamanho/download (T4), caption (T5), estados loading/erro (T2, compartilhado), src só via endpoint (T1, global constraint). React Query para signed URL não é necessário — o endpoint é usado como src direto e o browser gerencia o 302 (decisão registrada; simplificação sobre o texto do spec, mesmo contrato).
- **Sem placeholders:** todo step tem código/comando/expected concretos.
- **Consistência de tipos:** `mediaSrc`/`formatBytes`/`mediaFileLabel` (T1) usados com os mesmos nomes em T2-T5; `MediaUnavailable` definido em T2 e consumido em T3-T4; props de `DocumentCard` idênticas em T4 e T5.
