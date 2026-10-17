"use client";
/**
 * AS ETIQUETAS DA FICHA DO CONTATO — seletor com autocompletar (issue #2732).
 *
 * ─── Por que o campo virou seletor ──────────────────────────────────────────
 *
 * Era um `<Input>` de texto livre separado por vírgula. Cada pessoa redigitava
 * a etiqueta à sua maneira e a organização acumulava variantes que quebram
 * filtro, segmento de campanha e condição de automação. Aqui o autocompletar
 * oferece o que JÁ existe — o vocabulário da organização mais as
 * `canonical_tags` do funil — e o clique grava a grafia existente.
 *
 * ─── Por que o componente é burro, e recebe o vocabulário por prop ──────────
 *
 * A leitura do vocabulário é um hook com react-query (`useContactTagVocabulary`
 * sobre `GET /api/v1/contact-tags`), e as `canonical_tags` saem do funil padrão
 * que a tela já carrega. Trazer os dois para cá acoplaria o componente a duas
 * consultas e o deixaria impossível de testar sem rede — então ele recebe as
 * duas listas prontas, como `ChipDeEtiqueta` recebe a cor.
 *
 * ─── Criar etiqueta nova: quem decide é quem chama ──────────────────────────
 *
 * `podeCriarEtiqueta` chega calculado pela tela (o guard de papel é um só, em
 * `_client.tsx`, com `roleAtLeast` — a comparação canônica de papel do cliente).
 * Sem a permissão, um texto que não casa com NENHUMA etiqueta conhecida não
 * vira etiqueta: o campo mostra o motivo e não grava. Com ela, aparece a opção
 * "Criar etiqueta", e é o único caminho pelo qual uma etiqueta nova entra.
 */
import { useMemo, useState } from "react";

import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { TAMANHO_MAXIMO_DA_TAG } from "@/lib/contacts/tag-normalizada";
import {
  chaveDeComparacaoDeEtiqueta,
  etiquetaExistentePara,
  etiquetaParaGravar,
  etiquetasConhecidas,
  sugestoesDeEtiqueta,
} from "@/lib/contacts/etiquetas";
import { Plus, X } from "@/lib/ui/icons";

interface Props {
  /** As etiquetas do contato, na grafia gravada. */
  value: string[];
  onChange: (next: string[]) => void;
  /** Etiquetas já usadas na organização (`useContactTagVocabulary`). */
  vocabulario?: readonly string[] | null;
  /** `pipelines.settings.canonical_tags` do funil padrão. */
  canonicalTags?: readonly string[] | null;
  /** Só gerente/admin criam etiqueta nova (calculado pela tela). */
  podeCriarEtiqueta: boolean;
  disabled?: boolean;
  /** `id` do `<input>`, para o `<Label htmlFor>` de quem monta a ficha. */
  inputId?: string;
}

/** O teto de etiquetas por contato — o MESMO dos editores do produto. */
const MAXIMO_DE_ETIQUETAS = 20;

export function EtiquetasDoContato({
  value,
  onChange,
  vocabulario,
  canonicalTags,
  podeCriarEtiqueta,
  disabled = false,
  inputId = "etiquetas-do-contato",
}: Props) {
  const t = useT();
  const [draft, setDraft] = useState("");

  const conhecidas = useMemo(
    () => etiquetasConhecidas({ vocabulario, canonicalTags }),
    [vocabulario, canonicalTags],
  );
  const sugestoes = useMemo(
    () => sugestoesDeEtiqueta({ conhecidas, selecionadas: value, digitado: draft }),
    [conhecidas, value, draft],
  );

  const digitou = draft.trim() !== "";
  const existente = etiquetaExistentePara(conhecidas, draft);
  const jaSelecionada = value.some(
    (v) => chaveDeComparacaoDeEtiqueta(v) === chaveDeComparacaoDeEtiqueta(draft),
  );
  // O texto é NOVO quando não casa com nada conhecido nem com o que já está no
  // contato. Só nesse caso "criar" faz sentido — e só com permissão.
  const textoNovo = digitou && !existente && !jaSelecionada;
  const podeCriarAgora = podeCriarEtiqueta && textoNovo;
  const semPermissaoParaCriar = !podeCriarEtiqueta && textoNovo;
  const noTeto = value.length >= MAXIMO_DE_ETIQUETAS;

  function adicionar(tag: string) {
    if (disabled || noTeto) return;
    const k = chaveDeComparacaoDeEtiqueta(tag);
    if (k === "" || value.some((v) => chaveDeComparacaoDeEtiqueta(v) === k)) return;
    onChange([...value, tag]);
    setDraft("");
  }

  function remover(tag: string) {
    if (disabled) return;
    onChange(value.filter((v) => v !== tag));
  }

  function confirmar() {
    const alvo = etiquetaParaGravar({
      conhecidas,
      selecionadas: value,
      digitado: draft,
      podeCriarEtiqueta,
    });
    if (alvo) adicionar(alvo);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {value.length === 0 ? (
          <span className="text-xs text-muted-foreground">
            {t("Nenhuma etiqueta neste contato.")}
          </span>
        ) : (
          value.map((tag) => (
            <ChipDeEtiqueta key={tag} tag={tag}>
              <button
                type="button"
                onClick={() => remover(tag)}
                disabled={disabled}
                aria-label={`${t("Remover etiqueta")} ${tag}`}
                className="ml-1 rounded-sm hover:text-destructive"
              >
                <X size={10} weight="bold" aria-hidden />
              </button>
            </ChipDeEtiqueta>
          ))
        )}
      </div>

      <Input
        id={inputId}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            confirmar();
          }
          if (e.key === "Escape") setDraft("");
        }}
        placeholder={t("Digite para buscar etiquetas…")}
        maxLength={TAMANHO_MAXIMO_DA_TAG}
        disabled={disabled || noTeto}
        autoComplete="off"
        aria-label={t("Adicionar etiqueta")}
      />

      {(sugestoes.length > 0 || podeCriarAgora) && (
        <div
          role="group"
          aria-label={t("Sugestões de etiquetas")}
          className="flex flex-wrap gap-1"
        >
          {sugestoes.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => adicionar(tag)}
              disabled={disabled || noTeto}
              data-testid={`sugestao-${chaveDeComparacaoDeEtiqueta(tag)}`}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:border-solid hover:text-foreground disabled:opacity-50"
            >
              {tag}
            </button>
          ))}
          {podeCriarAgora && (
            <button
              type="button"
              onClick={confirmar}
              disabled={disabled || noTeto}
              data-testid="criar-etiqueta"
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:border-solid hover:text-foreground disabled:opacity-50"
            >
              <Plus size={10} weight="bold" aria-hidden />
              {t("Criar etiqueta")} “{draft.trim()}”
            </button>
          )}
        </div>
      )}

      {semPermissaoParaCriar && (
        <p className="text-xs text-muted-foreground">
          {t("Só gerentes e administradores podem criar etiquetas novas.")}
        </p>
      )}
    </div>
  );
}
