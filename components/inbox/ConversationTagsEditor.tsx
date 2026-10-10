"use client";
import { useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { PontoDaEtiqueta } from "@/components/tags/PontoDaEtiqueta";
import { SeletorDeCorDaEtiqueta } from "@/components/tags/SeletorDeCorDaEtiqueta";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, Plus } from "@/lib/ui/icons";
import {
  useUpdateConversationTags,
  useConversationTagVocabulary,
} from "@/hooks/inbox/useConversationTags";
import { useDefinirCorDaEtiqueta } from "@/hooks/tags/useDefinirCorDaEtiqueta";

interface Props {
  conversationId: string;
  orgId: string;
  tags: string[];
}

/** G3-05: aplica/remove tags de atendimento na conversa, com sugestão canônica. */
export function ConversationTagsEditor({ conversationId, orgId, tags }: Props) {
  const t = useT();
  const [draft, setDraft] = useState("");
  // Issue #2718 — tom escolhido ANTES do "+": a etiqueta nasce colorida.
  const [cor, setCor] = useState<string | null>(null);
  const mutation = useUpdateConversationTags();
  const { definirCor } = useDefinirCorDaEtiqueta();
  const { data: vocabulary } = useConversationTagVocabulary(orgId);

  // Normalização espelha o Zod do PATCH (trim+lowercase); dedup no set.
  function apply(next: string[]) {
    mutation.mutate({ conversation_id: conversationId, tags: next });
  }

  function add(raw: string) {
    const tag = raw.trim().toLowerCase().slice(0, 40);
    if (!tag || tags.includes(tag) || tags.length >= 20) return;
    const escolhida = cor;
    apply([...tags, tag]);
    setDraft("");
    setCor(null);
    // A cor é VOCABULÁRIO, não da linha (#2718): chamada independente do
    // attach — a SQL faz append do verbete, e falhar aqui não desfaz a tag.
    if (escolhida) void definirCor(tag, escolhida);
  }

  function remove(tag: string) {
    apply(tags.filter((v) => v !== tag));
  }

  const suggestions = (vocabulary ?? []).filter((v) => !tags.includes(v)).slice(0, 8);

  return (
    <section>
      <h3 className="text-xs font-semibold text-text">
        {t("Tags da conversa")}
      </h3>

      <div className="mt-2 flex flex-wrap gap-1">
        {tags.length > 0 ? (
          tags.map((tag) => (
            <ChipDeEtiqueta key={tag} tag={tag} className="h-5 gap-1 px-1.5 text-[10px]">
              <button
                type="button"
                onClick={() => remove(tag)}
                disabled={mutation.isPending}
                aria-label={`${t("Remover tag")} ${tag}`}
                className="rounded-sm hover:text-destructive"
              >
                <X size={10} weight="bold" aria-hidden />
              </button>
            </ChipDeEtiqueta>
          ))
        ) : (
          <span className="text-xs text-muted-foreground">{t("Sem tags.")}</span>
        )}
      </div>

      <div className="mt-2 flex gap-1">
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
          maxLength={40}
          disabled={mutation.isPending || tags.length >= 20}
          className="h-7 text-xs"
          aria-label={t("Adicionar tag à conversa")}
        />
        <SeletorDeCorDaEtiqueta
          cor={cor}
          onChange={setCor}
          tag={draft.trim() || undefined}
          disabled={mutation.isPending || tags.length >= 20}
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
        <div className="mt-2 flex flex-wrap gap-1">
          {suggestions.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => add(tag)}
              disabled={mutation.isPending || tags.length >= 20}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:border-solid hover:text-foreground disabled:opacity-50"
            >
              <PontoDaEtiqueta tag={tag} />
              + {tag}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
