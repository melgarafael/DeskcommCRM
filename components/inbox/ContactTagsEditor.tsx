"use client";
import { useState, Fragment } from "react";
import { useT } from "@/hooks/i18n/useT";
import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { PontoDaEtiqueta } from "@/components/tags/PontoDaEtiqueta";
import { SeletorDeCorDaEtiqueta } from "@/components/tags/SeletorDeCorDaEtiqueta";
import { DialogoDeNovaEtiqueta } from "@/components/tags/DialogoDeNovaEtiqueta";
import { useCoresDasEtiquetas } from "@/components/tags/CoresDasEtiquetas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, Plus } from "@/lib/ui/icons";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";
import { useEditLead } from "@/hooks/kanban/useUpdateLead";
import { useContactTagVocabulary } from "@/hooks/contacts/useContactTagVocabulary";
import { useDefinirCorDaEtiqueta } from "@/hooks/tags/useDefinirCorDaEtiqueta";
import { chaveDaEtiqueta } from "@/lib/tags/cor-da-etiqueta";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { ROLE_RANK } from "@/lib/auth/types";
import { sugestoesDeEtiqueta } from "@/lib/contacts/etiquetas";
import {
  normalizarTag,
  normalizarTags,
  TAMANHO_MAXIMO_DA_TAG,
} from "@/lib/contacts/tag-normalizada";

/**
 * O alvo do editor — e ele é a ÚNICA coisa que decide para onde a etiqueta vai.
 * A etiqueta do NEGÓCIO (`crm_leads.tags`) e a do CONTATO (`contacts.tags`) são
 * colunas diferentes, em rotas diferentes, em contextos diferentes: ver o
 * cabeçalho deste arquivo.
 */
type AlvoDoEditor =
  | {
      /** Padrão: a PESSOA (Inbox, ficha, campanha). Grava em `contacts.tags`. */
      entityType?: "contact";
    }
  | {
      /** O NEGÓCIO do funil. Grava em `crm_leads.tags`, nunca no contato. */
      entityType: "lead";
      /**
       * O funil do negócio. `useEditLead` o exige para acertar o cache do quadro
       * (`["board", pipelineId]`) — sem ele a etiqueta gravaria no servidor e o
       * card continuaria mostrando a lista antiga.
       */
      pipelineId: string;
    };

type Props = {
  /** Id do alvo: contato (`/contacts/{id}`) ou negócio (`/leads/{id}`). */
  entityId: string;
  /** Organização ativa — vocabulário de sugestões e régua de papel para a cor. */
  orgId: string;
  /** As etiquetas do alvo, como o servidor as devolveu. */
  tags: string[];
} & AlvoDoEditor;

/**
 * O editor de etiquetas do Inbox, agora também do FUNIL (issue #2979).
 *
 * ─── Duas caixas, um editor ─────────────────────────────────────────────────
 *
 * `crm_leads.tags` (a etiqueta do NEGÓCIO) e `contacts.tags` (a da PESSOA) são
 * colunas distintas, gravadas por rotas distintas — `PATCH /api/v1/leads/{id}`
 * e `PATCH /api/v1/contacts/{id}`. O Inbox e a ficha marcam pessoas; o funil
 * marca negócios (`lib/types/leads.ts` documenta as duas, e
 * `tests/unit/funil-filtro-de-tag-le-as-duas-caixas.test.ts` é o que lê as
 * duas lado a lado no filtro do quadro).
 *
 * O funil usava um campo de texto livre ("vip, recompra") e cada pessoa digitava
 * a sua variação; a etiqueta que não casa com a regra de automação faz a
 * automação disparar para quem não devia. Trazer o editor para cá sem trazer o
 * DESTINO junto seria pior: a etiqueta do negócio iria para o perfil do contato
 * — silenciosamente, porque o PATCH responderia 200 do mesmo jeito. Por isso
 * `entityType` decide a mutação, e não o que estiver disponível na tela.
 *
 * O nome do arquivo continua `ContactTagsEditor` (e não `TagsEditor`): renomear
 * custaria o mesmo diff em cinco chamadores e três suítes, sem mudar um byte de
 * comportamento. Quem lê o `entityType` sabe de quem são as etiquetas.
 */
export function ContactTagsEditor(props: Props) {
  const { entityId, orgId, tags } = props;
  const t = useT();
  const [draft, setDraft] = useState("");
  // Issue #2718 — tom escolhido ANTES do "+": a etiqueta nasce colorida.
  const [cor, setCor] = useState<string | null>(null);
  const noNegocio = props.entityType === "lead";
  // Os DOIS hooks são chamados em toda renderização (regra dos hooks) e nenhum
  // deles dispara nada enquanto `mutate` não for chamado — o id vazio do hook
  // não escolhido é só o que impede um disparo acidental. Quem separa os
  // caminhos é `apply()`, e só ele.
  const daPessoa = useUpdateContact(noNegocio ? "" : entityId);
  const doNegocio = useEditLead(noNegocio ? props.pipelineId : "");
  const pendente = daPessoa.isPending || doNegocio.isPending;
  // Os textos dizem de QUEM é a etiqueta: "Adicionar tag ao contato" num
  // formulário de negócio ensinaria o operador a esperar o destino errado.
  const rotuloVazio = noNegocio ? t("Sem tags no negócio.") : t("Sem tags no contato.");
  const rotuloCampo = noNegocio ? t("Adicionar tag ao negócio") : t("Adicionar tag ao contato");
  const { definirCor } = useDefinirCorDaEtiqueta();
  const { data: vocabulary, isError: erroNoVocabulario } = useContactTagVocabulary(orgId);
  // #2855 — com texto, pergunta também ao vocabulário inteiro (curado + em uso,
  // sem o teto de contatos lidos). Sem texto é a MESMA chave da linha acima:
  // uma requisição só.
  const { data: encontradas, isError: erroNaBusca } = useContactTagVocabulary(orgId, draft.trim());
  const vocabularyError = erroNoVocabulario || erroNaBusca;
  // A cor de quem JÁ está no contato vem do MESMO mapa que o chip usa (#2771):
  // uma leitura só, sem pergunta por tag, e o gatilho abre já com o tom atual
  // marcado — abrir a paleta de uma etiqueta colorida como se ela não tivesse
  // cor faria "Confirmar" apagar o que estava lá.
  const cores = useCoresDasEtiquetas();
  // #2789 — a sugestão escolhida, enquanto o diálogo está aberto. `null` = fechado.
  // `corInicial` é o tom que o diálogo MOSTROU ao abrir: confirmar compara com
  // ele, não com o mapa ao vivo, que pode chegar depois e não foi visto.
  const [sugestao, setSugestao] = useState<{ tag: string; corInicial: string | null } | null>(null);
  const { activeOrg } = useAuth();
  // A mesma régua do SeletorDeCorDaEtiqueta: POST /api/v1/tags/vocabulario exige
  // manager + MFA, então para quem a rota recusaria o clique continua DIRETO —
  // a tela não oferece o que a escrita recusa (#2718).
  const podeDefinirCor =
    !!activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;

  function apply(next: string[]) {
    if (noNegocio) {
      // A MESMA lista de etiquetas, a OUTRA caixa: `crm_leads.tags`, por
      // `PATCH /api/v1/leads/{id}` — nunca o perfil do contato.
      doNegocio.mutate({ leadId: entityId, patch: { tags: next } });
      return;
    }
    daPessoa.mutate({ tags: next });
  }

  /** Grava a etiqueta com o tom escolhido. Devolve a tag gravada, ou `null` se recusada (duplicada/cheia). */
  function criar(raw: string, escolhida: string | null): string | null {
    const tag = normalizarTag(raw);
    if (!tag || tags.some((v) => normalizarTag(v) === tag) || tags.length >= 20)
      return null;
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

  // Sem sugestão cada operador digitava a sua variação da mesma tag (#852).
  // A comparação é entre formas NORMALIZADAS: um contato que já tem "VIP"
  // (gravado antes, pelo diálogo de contato, que não normaliza) recebia o chip
  // "+ vip" e ficava com as duas — a duplicação que a sugestão veio impedir.
  // E o chip MOSTRA a forma normalizada, não a que a fonte mandou: o rótulo
  // precisa ser o que o clique grava mesmo que a lista chegue crua (a rota a
  // normaliza hoje, mas a fonte está marcada para trocar).
  //
  // #3180 — e o texto digitado ENTRA no filtro, com a MESMA chave larga da
  // busca (sem caixa, sem acento, casando no meio da palavra) que a ficha do
  // contato já usa (#2732): `sugestoesDeEtiqueta`. Sem texto, a lista sai na
  // ordem da FONTE — as mais usadas primeiro —, nunca reordenada no alfabeto.
  // #2855 — o que a busca no vocabulário inteiro achou entra DEPOIS das em uso:
  // a ordem por uso do #3180 continua valendo para o que já estava na lista.
  const conhecidas = normalizarTags([
    ...(vocabulary ?? []),
    ...(draft.trim() ? (encontradas ?? []) : []),
  ]);
  const suggestions = sugestoesDeEtiqueta({
    conhecidas,
    selecionadas: tags,
    digitado: draft,
  });

  return (
    <div className="mt-2 space-y-2 rounded-md border border-border p-2">
      <div className="flex flex-wrap gap-1">
        {tags.length > 0 ? (
          tags.map((tag) => (
            <Fragment key={tag}>
              <ChipDeEtiqueta tag={tag} className="h-5 gap-1 px-1.5 text-[10px]">
                <button
                  type="button"
                  onClick={() => remove(tag)}
                  disabled={pendente}
                  aria-label={`${t("Remover tag")} ${tag}`}
                  className="rounded-sm hover:text-destructive"
                >
                  <X size={10} weight="bold" aria-hidden />
                </button>
              </ChipDeEtiqueta>
              {/* #2771 — a MESMA paleta da criação, ao lado de quem já está no
                  contato. Sem rota nova e sem reimplementation: o gatilho chama
                  o `definir_cor` que a rota já aceita, e o hook já invalida o
                  mapa — o chip repinta na hora, sem F5. Para `agent` o seletor
                  devolve `null`, como na #2718: a rota exigiria manager + MFA. */}
              <SeletorDeCorDaEtiqueta
                cor={cores[chaveDaEtiqueta(tag)] ?? null}
                onChange={(tom) => void definirCor(tag, tom)}
                tag={tag}
                rotulo={`${t("Cor da etiqueta")} ${tag}`}
                disabled={pendente}
              />
            </Fragment>
          ))
        ) : (
          <span className="text-xs text-muted-foreground">{rotuloVazio}</span>
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
          disabled={pendente || tags.length >= 20}
          className="h-7 text-xs"
          aria-label={rotuloCampo}
        />
        <SeletorDeCorDaEtiqueta
          cor={cor}
          onChange={setCor}
          tag={draft.trim() || undefined}
          disabled={pendente || tags.length >= 20}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-11 min-w-11 px-2 lg:h-7 lg:min-w-0"
          onClick={() => add(draft)}
          disabled={pendente || !draft.trim() || tags.length >= 20}
          aria-label={t("Adicionar tag")}
        >
          <Plus size={12} weight="regular" aria-hidden />
        </Button>
      </div>

      {vocabularyError && <p role="alert" className="text-xs text-destructive">{t("Não foi possível carregar as tags.")}</p>}
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1">
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
              disabled={pendente || tags.length >= 20}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:border-solid hover:text-foreground disabled:opacity-50"
            >
              <PontoDaEtiqueta tag={tag} />
              + {tag}
            </button>
          ))}
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
          disabled={pendente}
        />
      ) : null}
    </div>
  );
}
