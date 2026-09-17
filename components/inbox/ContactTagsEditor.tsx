"use client";
import { useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, Plus } from "@/lib/ui/icons";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";
import { useContactTagVocabulary } from "@/hooks/contacts/useContactTagVocabulary";
import { normalizarTag, TAMANHO_MAXIMO_DA_TAG } from "@/lib/contacts/tag-normalizada";

interface Props {
  contactId: string;
  orgId: string;
  tags: string[];
}

/** Edita as tags do CONTATO (distinto de ConversationTagsEditor, que edita as
 * tags da conversa) — aberto pelo botão "Tag" do painel do Inbox. */
export function ContactTagsEditor({ contactId, orgId, tags }: Props) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const mutation = useUpdateContact(contactId);
  const { data: vocabulary } = useContactTagVocabulary(orgId);

  function apply(next: string[]) {
    mutation.mutate({ tags: next });
  }

  function add(raw: string) {
    const tag = normalizarTag(raw);
    if (!tag || tags.some((v) => normalizarTag(v) === tag) || tags.length >= 20) return;
    apply([...tags, tag]);
    setDraft("");
  }

  function remove(tag: string) {
    apply(tags.filter((v) => v !== tag));
  }

  // Sem sugestão cada operador digitava a sua variação da mesma tag (#852).
  // A comparação é entre formas NORMALIZADAS: um contato que já tem "VIP"
  // (gravado antes, pelo diálogo de contato, que não normaliza) recebia o chip
  // "+ vip" e ficava com as duas — a duplicação que a sugestão veio impedir.
  // E o chip MOSTRA a forma normalizada, não a que a fonte mandou: o rótulo
  // precisa ser o que o clique grava mesmo que a lista chegue crua (a rota a
  // normaliza hoje, mas a fonte está marcada para trocar).
  const jaTem = new Set(tags.map(normalizarTag));
  const suggestions = [...new Set((vocabulary ?? []).map(normalizarTag))]
    .filter((v) => v && !jaTem.has(v))
    .slice(0, 8);

  return (
    <div className="mt-2 space-y-2 rounded-md border border-border p-2">
      <div className="flex flex-wrap gap-1">
        {tags.length > 0 ? (
          tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="h-5 gap-1 px-1.5 text-[10px]">
              {tag}
              <button
                type="button"
                onClick={() => remove(tag)}
                disabled={mutation.isPending}
                aria-label={`${t("Remover tag")} ${tag}`}
                className="rounded-sm hover:text-destructive"
              >
                <X size={10} weight="bold" aria-hidden />
              </button>
            </Badge>
          ))
        ) : (
          <span className="text-xs text-muted-foreground">{t("Sem tags no contato.")}</span>
        )}
      </div>

      <div className="flex gap-1">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(draft);
            }
          }}
          placeholder={t("Nova tag…")}
          maxLength={TAMANHO_MAXIMO_DA_TAG}
          disabled={mutation.isPending || tags.length >= 20}
          className="h-7 text-xs"
          aria-label={t("Adicionar tag ao contato")}
        />
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2"
          onClick={() => add(draft)}
          disabled={mutation.isPending || !draft.trim() || tags.length >= 20}
          aria-label={t("Adicionar tag")}
        >
          <Plus size={12} weight="regular" aria-hidden />
        </Button>
      </div>

      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {suggestions.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => add(tag)}
              disabled={mutation.isPending || tags.length >= 20}
              className="rounded-full border border-dashed border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:border-solid hover:text-foreground disabled:opacity-50"
            >
              + {tag}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
