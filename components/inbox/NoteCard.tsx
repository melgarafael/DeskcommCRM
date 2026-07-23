"use client";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Note as NoteIcon, Trash } from "@/lib/ui/icons";
import type { Note } from "@/lib/types/messaging";

interface Props {
  note: Note;
  onDelete?: () => void;
}

/** Onda 5.2: nota interna inline no thread — nunca vai ao cliente, destaque âmbar (token `warning`). */
export function NoteCard({ note, onDelete }: Props) {
  const time = format(new Date(note.created_at), "HH:mm", { locale: ptBR });

  return (
    <div className="group flex w-full justify-center px-4 py-1">
      <div className="max-w-[85%] rounded-xl border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning-fg shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide opacity-80">
            <NoteIcon size={12} weight="fill" aria-hidden />
            <span>{note.created_by_name ?? "Alguém"}</span>
            <span aria-hidden>·</span>
            <span>Nota interna · só o time vê</span>
          </div>
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              className="opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
              aria-label="Excluir nota"
            >
              <Trash size={12} weight="bold" />
            </button>
          )}
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words leading-snug">{note.body}</p>
        <div className="mt-1 text-right text-[10px] opacity-70">{time}</div>
      </div>
    </div>
  );
}
