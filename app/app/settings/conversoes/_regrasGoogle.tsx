"use client";

/**
 * O que cada etapa do funil informa ao Google Ads (migration 0436).
 *
 * Uma linha por etapa ABERTA de cada funil: ligada, ela manda a ação de
 * conversão escolhida quando um negócio entra ali. Ganho é a compra (cartão da
 * conexão, logo acima) e perda não é conversão — por isso nenhuma das duas
 * aparece aqui.
 */
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { salvarRegrasDeConversaoGoogle } from "@/app/actions/settings/salvarRegrasDeConversaoGoogle";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  CANAIS_DE_ENTRADA,
  CATEGORIAS_DE_CONVERSAO,
  type CanalDeEntrada,
  type CategoriaDeConversao,
  type RegraDeConversaoGoogle,
} from "@/lib/conversoes/regras-google";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

import { CriarAcaoNoGoogle } from "./_criarAcaoGoogle";

export interface EtapaAberta {
  id: string;
  nome: string;
  funil: string;
  /** Primeira etapa aberta do funil — onde o lead nasce. */
  primeira: boolean;
}

interface Rascunho {
  enabled: boolean;
  label: string;
  googleActionId: string;
  category: CategoriaDeConversao;
  includedInConversions: boolean;
  channel: CanalDeEntrada;
}

const ERRO_EM_PORTUGUES: Record<string, string> = {
  validation_failed: "Toda etapa ligada precisa de um nome e do ID da ação de conversão.",
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
  forbidden_role: "Só um administrador da organização pode mudar estas regras.",
  mfa_required: "Confirme o segundo fator para salvar esta mudança.",
  etapa_invalida: "Uma das etapas não existe mais ou foi fechada. Atualize a página.",
  erro_ao_gravar: "Não consegui gravar agora. Tente de novo em instantes.",
};

/** A sugestão para uma etapa, pelo lugar e pelo nome. Só preenche; não liga ação nenhuma. */
function recomendado(etapa: EtapaAberta): Pick<Rascunho, "label" | "category"> | null {
  const nome = etapa.nome.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  if (etapa.primeira) return { label: "Nuevo lead", category: "CONTACT" };
  if (/qualific|problema|interess|diagnost/.test(nome))
    return { label: "Lead calificado", category: "QUALIFIED_LEAD" };
  if (/orcament|proposta|cotac/.test(nome))
    return { label: "Presupuesto enviado", category: "REQUEST_QUOTE" };
  if (/agend|consulta|visita|reuniao/.test(nome))
    return { label: "Turno agendado", category: "BOOK_APPOINTMENT" };
  return null;
}

export function RegrasDeConversaoGoogle({
  etapas,
  regras,
  idioma,
  podeCriarAcao,
}: {
  etapas: EtapaAberta[];
  regras: RegraDeConversaoGoogle[];
  idioma: Idioma;
  /** A instalação tem developer token e a conta autorizou o escopo do Google Ads. */
  podeCriarAcao: boolean;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const inicial = useMemo(() => {
    const porEtapa = new Map(regras.map((r) => [r.stageId, r]));
    return Object.fromEntries(
      etapas.map((e) => {
        const r = porEtapa.get(e.id);
        const rascunho: Rascunho = r
          ? {
              enabled: r.enabled,
              label: r.label,
              googleActionId: r.googleActionId,
              category: r.category,
              includedInConversions: r.includedInConversions,
              channel: r.channel,
            }
          : {
              enabled: false,
              label: "",
              googleActionId: "",
              category: "DEFAULT",
              includedInConversions: true,
              channel: "todos",
            };
        return [e.id, rascunho];
      }),
    ) as Record<string, Rascunho>;
  }, [etapas, regras]);

  const [rascunhos, setRascunhos] = useState(inicial);
  const ligadas = etapas.filter((e) => rascunhos[e.id]?.enabled).length;

  function mudar(id: string, parcial: Partial<Rascunho>) {
    setRascunhos((atual) => ({ ...atual, [id]: { ...atual[id]!, ...parcial } }));
  }

  function usarRecomendado() {
    setRascunhos((atual) => {
      const novo = { ...atual };
      for (const e of etapas) {
        const sugestao = recomendado(e);
        if (!sugestao) continue;
        const r = novo[e.id]!;
        novo[e.id] = {
          ...r,
          enabled: true,
          label: r.label || sugestao.label,
          category: r.label ? r.category : sugestao.category,
        };
      }
      return novo;
    });
    toast.message(
      t("Etapas recomendadas ligadas. Informe ou crie a ação de conversão de cada uma e salve."),
    );
  }

  function salvar() {
    startTransition(async () => {
      const resultado = await salvarRegrasDeConversaoGoogle(
        etapas.map((e) => {
          const r = rascunhos[e.id]!;
          return {
            stage_id: e.id,
            enabled: r.enabled,
            label: r.label,
            google_action_id: r.googleActionId,
            category: r.category,
            included_in_conversions: r.includedInConversions,
            channel: r.channel,
          };
        }),
      );
      if (resultado.ok) {
        toast.success(t("Regras salvas."));
        router.refresh();
        return;
      }
      toast.error(t(ERRO_EM_PORTUGUES[resultado.error] ?? "Não consegui salvar agora."));
    });
  }

  if (etapas.length === 0) {
    return (
      <Card className="p-6 text-sm text-muted-foreground">
        {t("Crie um funil com etapas para escolher o que cada etapa informa ao Google Ads.")}
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-4 p-6" data-testid="regras-google-por-etapa">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h3 className="font-medium">{t("O que cada etapa do funil informa ao Google Ads")}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(
              "Quanto mais cedo você avisa, mais dados a campanha tem para aprender — mas só a venda ensina o Google a buscar quem compra. Cada etapa ligada envia a sua ação de conversão uma vez por negócio, quando ele entra ali.",
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground" data-testid="etapas-enviando">
            {ligadas} {t("de")} {etapas.length} {t("etapas enviando")}
          </span>
          <Button type="button" variant="outline" onClick={usarRecomendado}>
            {t("Usar o recomendado")}
          </Button>
        </div>
      </div>

      <ul className="flex flex-col gap-3">
        {etapas.map((e) => {
          const r = rascunhos[e.id]!;
          return (
            <li key={e.id} className="rounded-md border p-4" data-testid={`regra-${e.id}`}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{e.nome}</p>
                  <p className="text-xs text-muted-foreground">
                    {e.funil}
                    {" · "}
                    {r.enabled
                      ? `${r.label || t("sem nome")} · ${
                          CATEGORIAS_DE_CONVERSAO.find((c) => c.valor === r.category)?.rotulo ??
                          r.category
                        }`
                      : t("não envia conversão")}
                  </p>
                </div>
                <Switch
                  aria-label={t("Enviar conversão nesta etapa")}
                  checked={r.enabled}
                  onCheckedChange={(v) => mudar(e.id, { enabled: v })}
                />
              </div>

              {r.enabled && (
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={`nome-${e.id}`}>{t("Nome da conversão")}</Label>
                    <Input
                      id={`nome-${e.id}`}
                      value={r.label}
                      maxLength={100}
                      onChange={(ev) => mudar(e.id, { label: ev.target.value })}
                      placeholder={t("ex.: Lead qualificado")}
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={`acao-${e.id}`}>{t("Ação de conversão (ID)")}</Label>
                    <div className="flex gap-2">
                      <Input
                        id={`acao-${e.id}`}
                        inputMode="numeric"
                        value={r.googleActionId}
                        onChange={(ev) =>
                          mudar(e.id, { googleActionId: ev.target.value.replace(/\D/g, "") })
                        }
                        placeholder="123456789"
                      />
                      <CriarAcaoNoGoogle
                        idioma={idioma}
                        habilitado={podeCriarAcao}
                        nome={r.label}
                        categoria={r.category}
                        incluirEmConversoes={r.includedInConversions}
                        onCriada={(id, nomeFinal) =>
                          mudar(e.id, { googleActionId: id, label: r.label || nomeFinal })
                        }
                      />
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={`categoria-${e.id}`}>{t("Categoria da conversão")}</Label>
                    <select
                      id={`categoria-${e.id}`}
                      className="rounded-md border bg-background p-2 text-sm"
                      value={r.category}
                      onChange={(ev) =>
                        mudar(e.id, { category: ev.target.value as CategoriaDeConversao })
                      }
                    >
                      {CATEGORIAS_DE_CONVERSAO.map((c) => (
                        <option key={c.valor} value={c.valor}>
                          {t(c.rotulo)}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground">
                      {t("É como o Google agrupa a conversão nos relatórios e nos lances.")}
                    </p>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={`canal-${e.id}`}>{t("Canal de entrada")}</Label>
                    <select
                      id={`canal-${e.id}`}
                      className="rounded-md border bg-background p-2 text-sm"
                      value={r.channel}
                      onChange={(ev) => mudar(e.id, { channel: ev.target.value as CanalDeEntrada })}
                    >
                      {CANAIS_DE_ENTRADA.map((c) => (
                        <option key={c.valor} value={c.valor}>
                          {t(c.rotulo)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-center gap-3 md:col-span-2">
                    <Switch
                      id={`incluida-${e.id}`}
                      checked={r.includedInConversions}
                      onCheckedChange={(v) => mudar(e.id, { includedInConversions: v })}
                    />
                    <Label htmlFor={`incluida-${e.id}`}>
                      {t('Incluir na coluna "Conversões" (os lances otimizam por ela)')}
                    </Label>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <p className="text-xs text-muted-foreground">
        {t(
          "As conversões só saem quando o negócio muda de etapa — pela equipe, pela IA ou por automação — e só para quem veio de anúncio do Google. Movimentos anteriores a ligar a regra não são enviados.",
        )}
      </p>
      <div>
        <Button type="button" onClick={salvar} disabled={isPending}>
          {isPending ? t("Salvando...") : t("Salvar regras")}
        </Button>
      </div>
    </Card>
  );
}
