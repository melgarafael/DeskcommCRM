"use client";

import { format } from "date-fns";

import { useT } from "@/hooks/i18n/useT";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
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
  checklist: { tem: string[]; falta: string[]; inconclusivo?: boolean };
  /** Contatos empresariais publicados no site; nunca indicam consentimento de marketing. */
  contatos_publicos?: { emails: string[]; telefones: string[]; fontes?: string[] };
  /** Registra o uso ou a tentativa do fallback externo para páginas JS. */
  metodo?: "firecrawl" | "firecrawl-sem-resultado";
  provisorio?: boolean;
  /** Quando o veredito foi medido (ISO). Ausente em dado antigo: a data não aparece. */
  verificado_em?: string;
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
  const locale = useLocaleDeData();
  const verificadoEm = site.verificado_em ? new Date(site.verificado_em) : null;
  const tem: ItemDoRaioX[] = (site.checklist?.tem ?? []).filter((i): i is ItemDoRaioX => i in ROTULOS_DO_CHECKLIST);
  const falta: ItemDoRaioX[] = (site.checklist?.falta ?? []).filter((i): i is ItemDoRaioX => i in ROTULOS_DO_CHECKLIST);
  const estrategia = montarEstrategia(
    {
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
    },
    t,
  );
  return (
    <div className="mt-3 space-y-3 border-t pt-3">
      <div>
        <h4 className="font-medium">{t("Auditoria do site")}</h4>
        <p className="mt-1 text-xs text-muted-foreground">
          {rotuloDaClasse(site.classe, t)}
          {site.provisorio === true
            ? ` — ${t("verificação pendente, sem citar na abordagem")}`
            : site.classe === "nao-medido"
              ? ` — ${t("não medido, sem citar na abordagem")}`
              : ""}
        </p>
        {verificadoEm && !Number.isNaN(verificadoEm.getTime()) && (
          <p className="text-xs text-muted-foreground">
            {t("Verificado em")} {format(verificadoEm, "P", { locale })}
          </p>
        )}
        {site.metodo === "firecrawl" && (
          <p className="text-xs text-muted-foreground">
            {t("Conteúdo renderizado pelo Firecrawl (serviço externo)")}
          </p>
        )}
        {site.metodo === "firecrawl-sem-resultado" && (
          <p className="text-xs text-muted-foreground">
            {t("Firecrawl foi acionado para tentar ler esta página; o resultado não foi usado.")}
          </p>
        )}
      </div>
      {site.problemas.length > 0 && (
        <ul className="list-disc space-y-1 pl-4 text-xs">
          {site.problemas.map((problema) => (
            <li key={problema}>{descreverProblema(problema, t)}</li>
          ))}
        </ul>
      )}
      {site.checklist?.inconclusivo === true && (
        <p className="text-xs text-muted-foreground">
          {t(
            "Checklist inconclusivo: a captura não trouxe conteúdo suficiente para confirmar estes itens. Não cite estas ausências.",
          )}
        </p>
      )}
      {(site.contatos_publicos?.emails.length ?? 0) > 0 || (site.contatos_publicos?.telefones.length ?? 0) > 0 ? (
        <div className="rounded-md border bg-muted/20 p-3 text-xs">
          <h5 className="font-medium">{t("Contatos publicados no site")}</h5>
          <p className="mt-1 text-muted-foreground">
            {t("Dados encontrados em páginas públicas do site; confira antes de usar. A publicação não comprova consentimento para marketing.")}
          </p>
          <ul className="mt-2 space-y-1">
            {(site.contatos_publicos?.emails ?? []).map((email) => (
              <li key={email}><a className="underline underline-offset-2" href={`mailto:${email}`}>{email}</a></li>
            ))}
            {(site.contatos_publicos?.telefones ?? []).map((telefone) => (
              <li key={telefone}><a className="underline underline-offset-2" href={`tel:${telefone}`}>{telefone}</a></li>
            ))}
          </ul>
          {(site.contatos_publicos?.fontes?.length ?? 0) > 0 && (
            <p className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-muted-foreground">
              <span>{t("Fonte:")}</span>
              {site.contatos_publicos?.fontes?.map((fonte, indice) => (
                <a
                  key={fonte}
                  className="underline underline-offset-2"
                  href={fonte}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {indice === 0 ? t("Página inicial") : t("Página de contato")}
                </a>
              ))}
            </p>
          )}
        </div>
      ) : null}
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
      <div className="text-xs leading-relaxed">
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
            <ul className="mt-1 space-y-2">
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
        {estrategia.proximoPasso && (
          <p className="mt-2">
            <span className="font-medium">{t("Próximo passo")}: </span>
            {estrategia.proximoPasso}
          </p>
        )}
      </div>
    </div>
  );
}
