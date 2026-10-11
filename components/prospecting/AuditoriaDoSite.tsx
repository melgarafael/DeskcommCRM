"use client";

import { useT } from "@/hooks/i18n/useT";
import {
  descreverProblema,
  type ClasseDeSite,
  type ItemDoRaioX,
} from "@/lib/prospecting/site-classify";
import {
  montarEstrategia,
  rotuloDaClasse,
  rotuloDoItem,
  ROTULOS_DO_CHECKLIST,
  type OfertaDaCampanha,
} from "@/lib/prospecting/estrategia-site";

export interface AuditoriaDoSiteDados {
  classe: ClasseDeSite;
  problemas: string[];
  checklist: { tem: string[]; falta: string[] };
  provisorio?: boolean;
}
/**
 * Auditoria do site — só leitura. Mesma seção no painel do inbox
 * (`LeadEnrichment`) e no cockpit da prospecção. Ações (reanalisar, prévia)
 * vivem nos chamadores, nunca aqui.
 */
export function AuditoriaDoSite({
  site,
  nota,
  numAvaliacoes,
  temInstagram,
  ofertas,
  nicho,
  status,
  sobrescritaVocabulario,
}: {
  site: AuditoriaDoSiteDados;
  nota: number | null;
  numAvaliacoes: number | null;
  temInstagram: boolean;
  ofertas: OfertaDaCampanha[];
  nicho: string;
  status: string;
  /** Sobrescrita de vocabulário da org. Ausente = mapa base. */
  sobrescritaVocabulario?: Record<string, string> | null;
}) {
  const t = useT();
  const tem: ItemDoRaioX[] = (site.checklist?.tem ?? []).filter((i): i is ItemDoRaioX => i in ROTULOS_DO_CHECKLIST);
  const falta: ItemDoRaioX[] = (site.checklist?.falta ?? []).filter((i): i is ItemDoRaioX => i in ROTULOS_DO_CHECKLIST);
  const estrategia = montarEstrategia({
    classe: site.classe,
    problemas: site.problemas,
    checklist: { tem, falta },
    nota,
    numAvaliacoes,
    temInstagram,
    ofertas,
    nicho,
    sobrescritaVocabulario: sobrescritaVocabulario ?? null,
    provisorio: site.provisorio ?? false,
    status,
    followUpsEnviados: 0,
  });
  return (
    <div className="mt-3 space-y-3 border-t pt-3">
      <div>
        <h4 className="font-medium">{t("Auditoria do site")}</h4>
        <p className="mt-1 text-xs text-muted-foreground">
          {rotuloDaClasse(site.classe, t)}
          {site.provisorio === true ? ` — ${t("verificação pendente, sem citar na abordagem")}` : ""}
        </p>
      </div>
      {site.problemas.length > 0 && (
        <ul className="list-disc space-y-1 pl-4 text-xs">
          {site.problemas.map((problema) => (
            <li key={problema}>{descreverProblema(problema)}</li>
          ))}
        </ul>
      )}
      {(tem.length > 0 || falta.length > 0) && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <h5 className="text-muted-foreground">{t("O que o site já tem")}</h5>
            <ul className="mt-1 space-y-0.5">
              {tem.map((item) => (
                <li key={item}>+ {rotuloDoItem(item, t)}</li>
              ))}
            </ul>
          </div>
          <div>
            <h5 className="text-muted-foreground">{t("O que falta no site")}</h5>
            <ul className="mt-1 space-y-0.5">
              {falta.map((item) => (
                <li key={item}>− {rotuloDoItem(item, t)}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <div className="text-xs">
        <h4 className="font-medium">{t("Estratégia de abordagem")}</h4>
        <p className="mt-1">{estrategia.cenario}</p>
        <p className="mt-1 text-muted-foreground">{estrategia.angulo}</p>
        {estrategia.ganchos.length > 0 && (
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {estrategia.ganchos.map((gancho, i) => (
              <li key={i}>{gancho}</li>
            ))}
          </ul>
        )}
        {estrategia.objecoes.length > 0 && (
          <div className="mt-2">
            <h5 className="text-muted-foreground">{t("Objeções e respostas")}</h5>
            <ul className="mt-1 space-y-1">
              {estrategia.objecoes.map((o) => (
                <li key={o.objecao}>
                  <span className="font-medium">“{o.objecao}”</span>
                  <br />
                  <span className="text-muted-foreground">{o.resposta}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="mt-2">
          <span className="font-medium">{t("Próximo passo")}: </span>
          {estrategia.proximoPasso}
        </p>
      </div>
    </div>
  );
}
