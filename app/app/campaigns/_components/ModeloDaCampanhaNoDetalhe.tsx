"use client";
/**
 * O modelo de uma campanha oficial, no detalhe: qual é, de que categoria, de
 * onde sai cada variável e a prévia. Só leitura — mudar é na edição do rascunho.
 */
import { PreviaDoModelo } from "@/components/channels/PreviaDoModelo";
import { useModelosDaCampanha, type CampanhaDetalhada } from "@/hooks/campanhas/useCampanhas";
import { useT } from "@/hooks/i18n/useT";

import { ROTULO_DA_CATEGORIA, ROTULO_DA_ORIGEM, previaDaEscolha } from "./ModeloDaCampanha";

export function ModeloDaCampanhaNoDetalhe({ campanha }: { campanha: CampanhaDetalhada }) {
  const t = useT();
  const doCanal = useModelosDaCampanha(campanha.channel_session_id);
  const nome = campanha.provider_template_name ?? "";
  const idioma = campanha.provider_template_language ?? "";
  const variaveis = campanha.provider_template_variables ?? {};
  const modelo =
    doCanal.data?.modelos.find((m) => m.name === nome && m.language === idioma) ?? null;

  if (!nome) {
    return <p className="text-sm text-muted-foreground">{t("Nenhum modelo escolhido ainda.")}</p>;
  }

  return (
    <div className="space-y-2" data-testid="modelo-no-detalhe">
      <p className="text-sm">
        {t("Modelo aprovado")}: <strong>{nome}</strong> ({idioma})
        {modelo?.category ? ` · ${t(ROTULO_DA_CATEGORIA[modelo.category] ?? modelo.category)}` : ""}
      </p>
      {modelo && !modelo.aprovado && (
        <p className="text-sm text-warning-fg">
          {t("Este modelo não está aprovado na plataforma agora")} ({modelo.status}).
        </p>
      )}
      {modelo && modelo.variaveis.length > 0 && (
        <ul className="space-y-1 text-sm text-muted-foreground">
          {modelo.variaveis.map((v) => {
            const f = variaveis[v.chave];
            return (
              <li key={v.chave}>
                <span className="font-mono text-xs">{v.rotulo}</span> —{" "}
                {f ? t(ROTULO_DA_ORIGEM[f.kind]) : t("sem origem")}
                {f?.kind === "fixed"
                  ? `: ${f.value}`
                  : f?.kind === "lead_custom"
                    ? `: ${f.key}`
                    : ""}
              </li>
            );
          })}
        </ul>
      )}
      {modelo && <PreviaDoModelo previa={previaDaEscolha(modelo, variaveis, t)} tom="neutro" />}
    </div>
  );
}
