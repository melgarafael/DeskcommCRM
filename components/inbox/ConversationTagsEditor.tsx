"use client";
import { useState, Fragment } from "react";
import { useT } from "@/hooks/i18n/useT";
import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { PontoDaEtiqueta } from "@/components/tags/PontoDaEtiqueta";
import { SeletorDeCorDaEtiqueta } from "@/components/tags/SeletorDeCorDaEtiqueta";
import { DialogoDeNovaEtiqueta } from "@/components/tags/DialogoDeNovaEtiqueta";
import { useCoresDasEtiquetas } from "@/components/tags/CoresDasEtiquetas";
import { chaveDaEtiqueta } from "@/lib/tags/cor-da-etiqueta";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { ROLE_RANK } from "@/lib/auth/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, Plus } from "@/lib/ui/icons";
import {
  useUpdateConversationTags,
  useConversationTagVocabulary,
} from "@/hooks/inbox/useConversationTags";
import { useDefinirCorDaEtiqueta } from "@/hooks/tags/useDefinirCorDaEtiqueta";
import { sugestoesDeEtiqueta, etiquetaParaGravar, opcaoDeCriar } from "@/lib/contacts/etiquetas";

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
  const { data: vocabulary, isError: erroNoVocabulario } = useConversationTagVocabulary(orgId);
  // #2855 — com texto, pergunta também ao vocabulário inteiro (curado + em uso).
  // Sem texto é a MESMA chave da linha acima: uma requisição só.
  const { data: encontradas, isError: erroNaBusca } = useConversationTagVocabulary(orgId, draft.trim());
  const vocabularyError = erroNoVocabulario || erroNaBusca;
  // A cor de quem JÁ está na conversa vem do MESMO mapa que o chip usa (#2771):
  // uma leitura só, e o gatilho abre já com o tom atual marcado.
  const cores = useCoresDasEtiquetas();
  // #2789 — a sugestão escolhida, enquanto o diálogo está aberto. `null` = fechado.
  // `corInicial` é o tom que o diálogo MOSTROU ao abrir: confirmar compara com
  // ele, não com o mapa ao vivo, que pode chegar depois e não foi visto.
  const [sugestao, setSugestao] = useState<{ tag: string; corInicial: string | null } | null>(null);
  const { activeOrg } = useAuth();
  // A mesma régua do SeletorDeCorDaEtiqueta: a rota exige manager + MFA, então
  // para quem ela recusaria o clique continua DIRETO (#2718).
  const podeDefinirCor =
    !!activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;

  /**
   * O vocabulário que este editor conhece: o da organização (as MAIS usadas
   * primeiro, ordem que a rota entrega) e, com texto digitado, o que a busca no
   * vocabulário inteiro achou — sem repetir, e DEPOIS das em uso (#2855, #3180).
   */
  const conhecidas = [
    ...new Set([...(vocabulary ?? []), ...(draft.trim() ? (encontradas ?? []) : [])]),
  ];

  // Normalização espelha o Zod do PATCH (trim+lowercase); dedup no set.
  function apply(next: string[]) {
    mutation.mutate({ conversation_id: conversationId, tags: next });
  }

  /** Grava a etiqueta com o tom escolhido. Devolve a tag gravada, ou `null` se recusada (duplicada/cheia). */
  function criar(raw: string, escolhida: string | null): string | null {
    // #3180 — o que se digita NÃO vira variante de uma etiqueta que já existe:
    // quando o texto casa pela chave larga (sem caixa, sem acento), é a grafia
    // EXISTENTE que se grava. É o mesmo caminho da ficha do contato
    // (`etiquetaParaGravar`), e é ele que faz o Enter aplicar a etiqueta em vez
    // de criar mais uma.
    const tag = etiquetaParaGravar({ conhecidas, selecionadas: tags, digitado: raw });
    if (!tag || tags.length >= 20) return null;
    apply([...tags, tag]);
    // A cor é VOCABULÁRIO, não da linha (#2718): chamada independente do
    // attach — a SQL faz append do verbete, e falhar aqui não desfaz a tag.
    if (escolhida) void definirCor(tag, escolhida);
    return tag;
  }

  /** Caminho DIGITADO: consome o tom escolhido no gatilho 🎨 e limpa o rascunho. */
  function add(raw: string) {
    if (criar(raw, cor)) {
      setDraft("");
      setCor(null);
    }
  }

  function remove(tag: string) {
    apply(tags.filter((v) => v !== tag));
  }

  // #3180 — o texto digitado ENTRA no filtro: a mesma chave larga da busca
  // (`lib/contacts/etiquetas`), sem caixa e sem acento, casando no MEIO da
  // palavra. Sem texto, as sugestões saem na ordem da FONTE — e a fonte
  // (`GET /api/v1/conversation-tags`) entrega as mais usadas primeiro
  // (`uso_em_conversas`), não as oito primeiras do alfabeto.
  const suggestions = sugestoesDeEtiqueta({
    conhecidas,
    selecionadas: tags,
    digitado: draft,
  });

  // #3180 (critério 3) — a etiqueta NOVA, a ÚLTIMA opção da lista e só quando
  // o texto não casa com nenhuma existente: `null` = não há o que criar.
  const nova = opcaoDeCriar({ conhecidas, selecionadas: tags, digitado: draft });

  return (
    <section>
      <h3 className="text-xs font-semibold text-text">
        {t("Tags da conversa")}
      </h3>

      <div className="mt-2 flex flex-wrap gap-1">
        {tags.length > 0 ? (
          tags.map((tag) => (
            <Fragment key={tag}>
              <ChipDeEtiqueta tag={tag} className="h-5 gap-1 px-1.5 text-[10px]">
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
              {/* #2771 — mesma paleta, mesmo caminho do editor do contato. */}
              <SeletorDeCorDaEtiqueta
                cor={cores[chaveDaEtiqueta(tag)] ?? null}
                onChange={(tom) => void definirCor(tag, tom)}
                tag={tag}
                rotulo={`${t("Cor da etiqueta")} ${tag}`}
                disabled={mutation.isPending}
              />
            </Fragment>
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
          className="h-11 min-w-11 px-2 lg:h-7 lg:min-w-0"
          onClick={() => add(draft)}
          disabled={mutation.isPending || !draft.trim() || tags.length >= 20}
          aria-label={t("Adicionar tag")}
        >
          <Plus size={12} weight="regular" aria-hidden />
        </Button>
      </div>

      {vocabularyError && <p role="alert" className="text-xs text-destructive">{t("Não foi possível carregar as tags.")}</p>}
      {(suggestions.length > 0 || nova !== null) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {suggestions.map((tag) => (
            <button
              key={tag}
              type="button"
              // #2789 — passa pela caixa de diálogo para escolher a cor antes de
              // enviar; sem permissão o clique continua direto (a rota recusaria).
              onClick={() =>
                podeDefinirCor
                  ? setSugestao({ tag, corInicial: cores[chaveDaEtiqueta(tag)] ?? null })
                  : add(tag)
              }
              disabled={mutation.isPending || tags.length >= 20}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:border-solid hover:text-foreground disabled:opacity-50"
            >
              <PontoDaEtiqueta tag={tag} />
              + {tag}
            </button>
          ))}
          {/* #3180 (critério 3) — CRIAR fica por ÚLTIMO e só quando o texto não
              casa com nenhuma etiqueta existente: assim a lista diz, sem
              ambiguidade, o que já existe e o que nasceria. Clicar (ou o Enter
              no campo, que passa pelo mesmo caminho) grava. */}
          {nova !== null && (
            <button
              type="button"
              onClick={() => add(draft)}
              disabled={mutation.isPending || tags.length >= 20}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:border-solid hover:text-foreground disabled:opacity-50"
            >
              {t("Criar")} «{nova}»
            </button>
          )}
        </div>
      )}

      {/* Montado só com a sugestão escolhida: cada abertura nasce com o tom do
          vocabulário pré-marcado, sem estado herdado da abertura anterior. */}
      {sugestao ? (
        <DialogoDeNovaEtiqueta
          tag={sugestao.tag}
          corInicial={sugestao.corInicial}
          onFechar={() => setSugestao(null)}
          onConfirmar={(tom) => {
            // No diálogo, `null` é "Sem cor" escolhido de propósito: a cor do
            // vocabulário só é regravada quando a escolha difere da que foi mostrada.
            const gravada = criar(sugestao.tag, null);
            if (gravada && tom !== sugestao.corInicial) void definirCor(gravada, tom);
            setSugestao(null);
          }}
          disabled={mutation.isPending}
        />
      ) : null}
    </section>
  );
}
