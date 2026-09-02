"use client";
import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { PaperPlaneTilt } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { AttachMenu } from "@/components/inbox/composer/AttachMenu";
import { AttachmentPreviewDialog } from "@/components/inbox/composer/AttachmentPreviewDialog";
import { AudioRecorder } from "@/components/inbox/composer/AudioRecorder";
import { DraftReplyButton } from "@/components/inbox/composer/DraftReplyButton";
import { EmojiButton } from "@/components/inbox/composer/EmojiButton";
import { resolveSlash, TemplateMenu } from "@/components/inbox/composer/TemplateMenu";
import { useCreateNote } from "@/hooks/inbox/useCreateNote";
import { useMessageTemplates, type MessageTemplate } from "@/hooks/inbox/useMessageTemplates";
import { useSendMessage } from "@/hooks/inbox/useSendMessage";
import { useUploadMedia } from "@/hooks/inbox/useUploadMedia";
import { imagemDoClipboard } from "@/lib/inbox/clipboard-image";
import { interpolateTemplate } from "@/lib/inbox/template-vars";
import { cn } from "@/lib/utils";

export interface ComposerHandle {
  focus: () => void;
}

interface Props {
  conversationId: string;
  disabled?: boolean;
  /** Set true when contact is blocked / anonymized — explanation shown. */
  blockedReason?: string | null;
  /**
   * Janela de 24h fechada: barra a RESPOSTA, e só ela.
   *
   * Separado de `blockedReason` porque a nota interna nunca chega ao cliente —
   * a regra da plataforma não a alcança, e barrá-la tira do atendente
   * justamente o lugar onde ele registra por que a conversa esfriou. A primeira
   * versão deste bloqueio usava `blockedReason` e levou a nota junto.
   */
  janelaFechada?: string | null;
  /** Nome do contato da conversa, para interpolar {{nome}}/{{primeiro_nome}} do template escolhido. */
  contactName?: string | null;
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { conversationId, disabled, blockedReason, janelaFechada, contactName },
  ref,
) {
  const [text, setText] = useState("");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const send = useSendMessage();
  const upload = useUploadMedia();
  const createNote = useCreateNote();
  const templates = useMessageTemplates();
  const slash = resolveSlash(text);
  const menuOpen = mode === "reply" && slash.open && !menuDismissed;

  useImperativeHandle(ref, () => ({
    focus: () => taRef.current?.focus(),
  }));

  const isDisabled =
    disabled || !!blockedReason || send.isPending || upload.isPending || createNote.isPending;
  // A janela só alcança o que SAI. Em modo nota o composer segue liberado: a
  // nota interna nunca chega ao cliente, e é onde o atendente registra por que
  // a conversa esfriou — barrá-la tira exatamente o que ainda dá para fazer.
  const respostaBarrada = isDisabled || (mode === "reply" && !!janelaFechada);

  function autoresize() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }

  function handleSubmit() {
    const body = text.trim();
    if (!body || (mode === "note" ? isDisabled : respostaBarrada)) return;
    if (mode === "note") {
      createNote.mutate(
        { conversation_id: conversationId, body },
        {
          onSuccess: () => {
            setText("");
            requestAnimationFrame(() => autoresize());
          },
        },
      );
      return;
    }
    send.mutate(
      { conversation_id: conversationId, body, type: "text" },
      {
        onSuccess: () => {
          setText("");
          requestAnimationFrame(() => autoresize());
        },
      },
    );
  }

  function applyTemplate(t: MessageTemplate) {
    const filled = interpolateTemplate(t.body, { name: contactName ?? null });
    setText(filled);
    setMenuDismissed(true);
    const ta = taRef.current;
    if (!ta) return;
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = filled.length;
      autoresize();
    });
  }

  function applyDraft(draft: string) {
    // O rascunho é uma resposta COMPLETA sugerida — substitui o conteúdo, nunca
    // concatena (inserir no cursor grudaria dois textos completos, gerando uma
    // mensagem sem sentido). O vendedor edita/envia a partir daqui.
    setText(draft);
    requestAnimationFrame(() => {
      taRef.current?.focus();
      autoresize();
    });
  }

  /**
   * Ctrl/Cmd+V com imagem no clipboard cai no MESMO caminho do menu "+":
   * abre o preview com legenda e envia por ali. Nada de atalho paralelo — a
   * validação, o toast de erro e o retry já vivem lá.
   *
   * As três guardas antes de olhar o clipboard não são zelo: em "Nota interna"
   * não existe anexo (a nota é só texto e o envio nem passa pelo upload), com
   * um anexo já em preview a colagem substituiria em silêncio o que o operador
   * escolheu, e desabilitado é desabilitado. Em qualquer um desses casos o
   * Ctrl+V precisa continuar sendo o Ctrl+V de sempre.
   */
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (mode !== "reply" || respostaBarrada || pendingFile) return;
    const imagem = imagemDoClipboard(e.clipboardData, new Date());
    if (!imagem) return; // colagem de texto segue o caminho normal do browser
    e.preventDefault();
    setPendingFile(imagem);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape" && menuOpen) {
      setMenuDismissed(true);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (menuOpen) return; // deixa o Enter pro menu; não envia /query como mensagem
      handleSubmit();
    }
  }

  if (blockedReason) {
    return (
      <div className="border-t border-border bg-muted/40 px-4 py-3 text-center text-xs text-muted-foreground">
        {blockedReason}
      </div>
    );
  }

  return (
    <>
      <div
        className={cn(
          "relative border-t border-border bg-background px-3 py-2",
          mode === "note" && "border-warning/40 bg-warning-bg",
        )}
      >
        <TemplateMenu
          open={menuOpen}
          query={slash.query}
          templates={templates.data ?? []}
          onPick={applyTemplate}
          onClose={() => setMenuDismissed(true)}
        />
        <div className="mb-1.5 flex gap-1">
          <button
            type="button"
            onClick={() => setMode("reply")}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
              mode === "reply"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            {"Responder"}
          </button>
          <button
            type="button"
            onClick={() => setMode("note")}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
              mode === "note"
                ? "bg-warning text-warning-fg"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            {"Nota interna"}
          </button>
        </div>
        <div className="flex items-end gap-2">
          {mode === "reply" && <AttachMenu disabled={respostaBarrada} onPick={setPendingFile} />}
          {mode === "reply" && (
            <DraftReplyButton conversationId={conversationId} disabled={isDisabled} onDraft={applyDraft} />
          )}
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
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (!resolveSlash(e.target.value).open) setMenuDismissed(false);
              autoresize();
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            // O atalho saiu do placeholder e foi para o diálogo de atalhos (`?`)
            // e para o `title` aqui. Dois motivos, nesta ordem: ele some assim
            // que se digita a primeira letra — isto é, some justamente quando
            // você ia quebrar linha —; e, com a coluna do inbox mais estreita
            // depois do conserto do layout, a frase quebrava em duas linhas
            // dentro de um campo de uma linha só.
            //
            // "(só o time vê)" FICA: não é atalho, é consequência. Quem escreve
            // uma nota interna precisa saber que ela não vai para o cliente, e
            // essa informação não pode depender de abrir um diálogo.
            placeholder={
              mode === "note" ? "Escreva uma nota interna… (só o time vê)" : "Escreva uma mensagem…"
            }
            title={
              mode === "note"
                ? "Enter salva a nota · Shift+Enter quebra linha"
                : "Enter envia · Shift+Enter quebra linha"
            }
            className={cn(
              "min-h-9 max-h-40 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm",
              "placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring",
            )}
            disabled={mode === "note" ? isDisabled : respostaBarrada}
            aria-label="Mensagem"
          />
          {text.trim() || mode === "note" ? (
            <Button
              type="button"
              size="icon"
              className="h-9 w-9 shrink-0"
              onClick={handleSubmit}
              disabled={(mode === "note" ? isDisabled : respostaBarrada) || !text.trim()}
              aria-label="Enviar"
            >
              <PaperPlaneTilt size={16} weight="fill" aria-hidden />
            </Button>
          ) : (
            <AudioRecorder conversationId={conversationId} disabled={respostaBarrada} />
          )}
        </div>
      </div>
      <AttachmentPreviewDialog
        file={pendingFile}
        sending={upload.isPending || send.isPending}
        onCancel={() => setPendingFile(null)}
        onSend={async (caption) => {
          if (!pendingFile) return;
          try {
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
          } catch {
            // toast já disparado pelo onError de useUploadMedia; dialog fica aberto p/ retry
            return;
          }
        }}
      />
    </>
  );
});
