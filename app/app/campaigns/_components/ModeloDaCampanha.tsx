"use client";
/**
 * O conteúdo da campanha num número OFICIAL: o modelo aprovado, de onde sai
 * cada variável, e a prévia de como chega ao cliente (#1330, fatia 4).
 *
 * Número oficial só aceita texto livre para quem escreveu nas últimas 24 horas,
 * e a campanha fala com quem não escreveu — por isso, nele, o campo de texto dá
 * lugar a este seletor. O modelo não se cria aqui: a plataforma leva de minutos
 * a horas para aprovar, e o link leva para a tela onde ele se cria e se edita.
 *
 * A lista vem de `GET /api/v1/campaigns/modelos`, que já devolve as variáveis
 * de cada modelo com o tipo e as origens que servem — esta tela não reimplementa
 * o contrato, só o mostra.
 */
import { useMemo } from "react";

import { PreviaDoModelo } from "@/components/channels/PreviaDoModelo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useModelosDaCampanha,
  type ModeloParaCampanha,
  type VariavelDoModelo,
} from "@/hooks/campanhas/useCampanhas";
import { useT } from "@/hooks/i18n/useT";
import type { FonteDaCampanha } from "@/lib/campanhas/modelo";
import { renderTemplatePreview, type PreviaDaMensagem } from "@/lib/channels/meta/render-template";
import { fonteDeTemplates, telaDeModelos } from "@/lib/channels/templates-fonte";

export interface EscolhaDoModelo {
  name: string;
  language: string;
  variables: Record<string, FonteDaCampanha>;
}

export const ROTULO_DA_ORIGEM: Record<FonteDaCampanha["kind"], string> = {
  contact_first_name: "Primeiro nome do contato",
  contact_name: "Nome completo do contato",
  lead_custom: "Campo do negócio",
  fixed: "Texto fixo",
};

export const ROTULO_DA_CATEGORIA: Record<string, string> = {
  MARKETING: "Marketing",
  UTILITY: "Utilidade",
  AUTHENTICATION: "Autenticação",
};

function chaveDoModelo(m: { name: string; language: string }): string {
  return `${m.name}|${m.language}`;
}

/** O que aparece no lugar da variável na prévia: o texto fixo, ou o nome da origem. */
function amostraDaOrigem(
  fonte: FonteDaCampanha | undefined,
  t: (s: string) => string,
): string | null {
  if (!fonte) return null;
  if (fonte.kind === "fixed") return fonte.value.trim() || null;
  if (fonte.kind === "lead_custom") return fonte.key.trim() ? `[${fonte.key.trim()}]` : null;
  return `[${t(ROTULO_DA_ORIGEM[fonte.kind])}]`;
}

/**
 * A prévia do modelo com o que se sabe ANTES de cada contato: o texto fixo como
 * ele é, e o nome da origem no lugar do resto ("[Primeiro nome do contato]").
 * Variável sem origem continua aparecendo como `{{n}}` destacado.
 */
export function previaDaEscolha(
  modelo: ModeloParaCampanha,
  variaveis: Record<string, FonteDaCampanha>,
  t: (s: string) => string,
): PreviaDaMensagem {
  const amostras: Record<string, string> = {};
  for (const v of modelo.variaveis) {
    const amostra = amostraDaOrigem(variaveis[v.chave], t);
    if (amostra) amostras[v.chave] = amostra;
  }
  return renderTemplatePreview(modelo.components, amostras, {
    name: modelo.name,
    language: modelo.language,
    ...(modelo.parameter_format ? { parameterFormat: modelo.parameter_format } : {}),
  });
}

/** Variáveis sem origem completa — a tela mostra e o salvar fica travado. */
export function variaveisIncompletas(
  modelo: ModeloParaCampanha,
  variaveis: Record<string, FonteDaCampanha>,
): VariavelDoModelo[] {
  return modelo.variaveis.filter((v) => {
    const f = variaveis[v.chave];
    if (!f || !v.origens.includes(f.kind)) return true;
    if (f.kind === "fixed") return f.value.trim() === "";
    if (f.kind === "lead_custom") return f.key.trim() === "";
    return false;
  });
}

/** Ao escolher um modelo: a mídia do cabeçalho já vem com o link salvo na aba de modelos. */
function variaveisIniciais(modelo: ModeloParaCampanha): Record<string, FonteDaCampanha> {
  const saida: Record<string, FonteDaCampanha> = {};
  for (const v of modelo.variaveis) {
    const salvo = modelo.saved_values[v.chave];
    if (v.tipo === "midia" && salvo) saida[v.chave] = { kind: "fixed", value: salvo };
  }
  return saida;
}

export function ModeloDaCampanha({
  channelSessionId,
  provider,
  valor,
  onChange,
}: {
  channelSessionId: string;
  /** Só para apontar a tela de modelos certa; a decisão de modo é do servidor. */
  provider: string | null | undefined;
  valor: EscolhaDoModelo | null;
  onChange: (valor: EscolhaDoModelo | null) => void;
}) {
  const t = useT();
  const consulta = useModelosDaCampanha(channelSessionId);
  const modelos = useMemo(() => consulta.data?.modelos ?? [], [consulta.data]);
  const escolhido = valor
    ? (modelos.find((m) => chaveDoModelo(m) === chaveDoModelo(valor)) ?? null)
    : null;
  const fonte = fonteDeTemplates(provider);

  const previa = useMemo(
    () => (escolhido && valor ? previaDaEscolha(escolhido, valor.variables, t) : null),
    [escolhido, valor, t],
  );

  const incompletas = escolhido && valor ? variaveisIncompletas(escolhido, valor.variables) : [];

  function trocarModelo(chave: string) {
    const m = modelos.find((x) => chaveDoModelo(x) === chave);
    onChange(m ? { name: m.name, language: m.language, variables: variaveisIniciais(m) } : null);
  }

  function trocarOrigem(v: VariavelDoModelo, kind: FonteDaCampanha["kind"] | "") {
    if (!valor) return;
    const variables = { ...valor.variables };
    if (kind === "") delete variables[v.chave];
    else if (kind === "fixed")
      variables[v.chave] = {
        kind,
        value:
          valor.variables[v.chave]?.kind === "fixed"
            ? (valor.variables[v.chave] as { value: string }).value
            : "",
      };
    else if (kind === "lead_custom") variables[v.chave] = { kind, key: "" };
    else variables[v.chave] = { kind };
    onChange({ ...valor, variables });
  }

  function trocarTexto(v: VariavelDoModelo, texto: string) {
    if (!valor) return;
    const atual = valor.variables[v.chave];
    if (!atual) return;
    const novo: FonteDaCampanha =
      atual.kind === "fixed"
        ? { kind: "fixed", value: texto }
        : atual.kind === "lead_custom"
          ? { kind: "lead_custom", key: texto }
          : atual;
    onChange({ ...valor, variables: { ...valor.variables, [v.chave]: novo } });
  }

  return (
    <div className="space-y-4" data-testid="modelo-da-campanha">
      <p className="text-sm text-muted-foreground">
        {t(
          "Número oficial só aceita texto livre para quem escreveu nas últimas 24 horas. Para falar com quem não escreveu, a campanha manda um modelo aprovado.",
        )}
      </p>

      <div className="space-y-2">
        <Label htmlFor="modelo">{t("Modelo aprovado")}</Label>
        <div className="flex flex-wrap items-center gap-2">
          <select
            id="modelo"
            className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-sm"
            value={valor ? chaveDoModelo(valor) : ""}
            onChange={(e) => trocarModelo(e.target.value)}
            disabled={consulta.isLoading}
          >
            <option value="">
              {consulta.isLoading ? t("Carregando modelos…") : t("Escolha um modelo")}
            </option>
            {modelos.map((m) => (
              <option key={chaveDoModelo(m)} value={chaveDoModelo(m)} disabled={!m.aprovado}>
                {m.name} ({m.language})
                {m.category ? ` · ${t(ROTULO_DA_CATEGORIA[m.category] ?? m.category)}` : ""}
                {m.aprovado ? "" : ` · ${m.status}`}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void consulta.refetch()}
            disabled={consulta.isFetching}
          >
            {consulta.isFetching ? t("Atualizando…") : t("Atualizar lista")}
          </Button>
        </div>
        {fonte && (
          <p className="text-sm text-muted-foreground">
            {t("Não achou o modelo?")}{" "}
            <a href={telaDeModelos(fonte)} target="_blank" rel="noreferrer" className="underline">
              {t("Criar ou editar modelos")}
            </a>
            {" — "}
            {t("a plataforma precisa aprovar antes de ele aparecer aqui.")}
          </p>
        )}
        {!consulta.isLoading && modelos.length === 0 && (
          <p className="text-sm text-warning-fg">
            {t(
              "Este número ainda não tem modelos. Crie um e sincronize a lista na tela de modelos.",
            )}
          </p>
        )}
        {escolhido?.category === "MARKETING" && (
          <p className="text-sm text-muted-foreground">
            {t(
              "Modelo de marketing: a plataforma cobra cada mensagem entregue e limita quantas promoções cada pessoa recebe — quem passar do limite aparece como falha com o motivo.",
            )}
          </p>
        )}
      </div>

      {escolhido && valor && escolhido.variaveis.length > 0 && (
        <fieldset className="space-y-3" data-testid="variaveis-do-modelo">
          <legend className="text-sm font-medium">{t("De onde sai cada variável")}</legend>
          {escolhido.variaveis.map((v) => {
            const f = valor.variables[v.chave];
            return (
              <div key={v.chave} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div className="min-w-0 text-sm">
                  <span className="font-mono text-xs">{v.rotulo}</span>
                  {(v.contexto_antes || v.contexto_depois) && (
                    <p className="truncate text-xs text-muted-foreground">
                      …{v.contexto_antes}
                      <strong>{`{{${v.chave.split(":").pop()}}}`}</strong>
                      {v.contexto_depois}…
                    </p>
                  )}
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  {v.origens.length === 0 ? (
                    <p className="text-sm text-warning-fg">
                      {t("Este tipo de variável ainda não pode ser preenchido por campanha.")}
                    </p>
                  ) : (
                    <>
                      <select
                        aria-label={`${t("Origem")}: ${v.rotulo}`}
                        className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
                        value={f?.kind ?? ""}
                        onChange={(e) =>
                          trocarOrigem(v, e.target.value as FonteDaCampanha["kind"] | "")
                        }
                      >
                        <option value="">{t("Escolha a origem")}</option>
                        {v.origens.map((o) => (
                          <option key={o} value={o}>
                            {t(ROTULO_DA_ORIGEM[o])}
                          </option>
                        ))}
                      </select>
                      {f?.kind === "fixed" && (
                        <Input
                          aria-label={`${t("Texto fixo")}: ${v.rotulo}`}
                          value={f.value}
                          onChange={(e) => trocarTexto(v, e.target.value)}
                          placeholder={
                            v.tipo === "midia" ? "https://…" : t("O mesmo texto para todos")
                          }
                        />
                      )}
                      {f?.kind === "lead_custom" && (
                        <Input
                          aria-label={`${t("Campo do negócio")}: ${v.rotulo}`}
                          value={f.key}
                          onChange={(e) => trocarTexto(v, e.target.value)}
                          placeholder={t("Chave do campo, ex.: produto")}
                        />
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
          <p className="text-sm text-muted-foreground">
            {t(
              "Quem não tiver o dado que a mensagem usa fica de fora, com o motivo na lista — mensagem com buraco não sai.",
            )}
          </p>
        </fieldset>
      )}

      {incompletas.length > 0 && (
        <p className="text-sm text-warning-fg" data-testid="variaveis-incompletas">
          {t("Falta escolher a origem de:")} {incompletas.map((v) => v.rotulo).join(", ")}
        </p>
      )}

      {previa && <PreviaDoModelo previa={previa} tom="neutro" />}
    </div>
  );
}
