"use client";

import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/hooks/i18n/useT";
import { AuditoriaDoSite } from "@/components/prospecting/AuditoriaDoSite";
import { descreverProblema, type ClasseDeSite } from "@/lib/prospecting/site-classify";
import { siteEfetivo } from "@/lib/prospecting/site-efetivo";
import {
  pontuarCandidato,
  rotuloDaClasse,
  type EstrategiaDoLead,
  type OfertaDaCampanha,
  type Pontuacao,
} from "@/lib/prospecting/estrategia-site";
import type { Prospect } from "@/lib/prospecting/schema";

/** Classes que `vereditoPuro` resolve sem rede: não há verificação a datar. */
const SEM_REDE: ReadonlySet<ClasseDeSite> = new Set(["sem-site", "agregador"]);

export interface PreviaDaAbordagem {
  mensagem: string;
  /** `null` quando a campanha usa o prompt do agente e o site ainda não tem veredito. */
  estrategia: EstrategiaDoLead | null;
  score: Pontuacao | null;
}

/**
 * Célula de auditoria da fila de prospecção: resumo de uma linha + modal.
 * A apresentação completa é `AuditoriaDoSite` (compartilhada com o inbox);
 * aqui moram só o resumo, o modal e os botões que falam com a rota.
 */
export function AuditoriaDoCandidato({
  candidateId,
  data,
  ofertas,
  nicho,
  status,
  disabled,
  temAgente,
  sobrescritaVocabulario,
  onReanalisar,
  onPrevia,
  fonte = "estrategia",
}: {
  candidateId: string;
  data: Prospect;
  ofertas: OfertaDaCampanha[];
  nicho: string;
  status: string;
  disabled: boolean;
  /** Campanha já tem agente escolhido: sem ele a prévia não tem com que gerar. */
  temAgente: boolean;
  sobrescritaVocabulario?: Record<string, string> | null;
  onReanalisar: (candidateId: string) => Promise<void>;
  onPrevia: (candidateId: string) => Promise<PreviaDaAbordagem | null>;
  /** A fonte da abordagem da campanha: pelo prompt do agente a auditoria não entra na mensagem. */
  fonte?: "estrategia" | "agente";
}) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const [previa, setPrevia] = useState<PreviaDaAbordagem | null>(null);
  const [gerando, setGerando] = useState(false);
  const [erroDaPrevia, setErroDaPrevia] = useState<string | null>(null);
  const previaRef = useRef<HTMLDivElement | null>(null);
  // O veredito da LEITURA (morada única em `site-efetivo.ts`): o gravado ou o
  // `sem-site` derivado do `website` vazio. Só depende de rede quem tem site
  // na web e ainda não foi auditado — por isso a linha sem site nunca fica
  // presa em "A verificar".
  const site = siteEfetivo(data, new Date().toISOString());
  // A1: quando a prévia chega, ela rola para a área visível da janela — o texto
  // caía fora do que o modal mostrava (medido: posição 777 numa janela de 726).
  useEffect(() => {
    if (previa) previaRef.current?.scrollIntoView({ block: "nearest" });
  }, [previa]);
  const peloAgente = fonte === "agente";
  function abrir() {
    setPrevia(null);
    setErroDaPrevia(null);
    setAberto(true);
  }
  // O bloco da PRÉVIA vem primeiro no diálogo: é o que o operador abre "Ver detalhes"
  // para conferir. A auditoria do site vem depois, como apoio.
  const blocoDaPrevia = (
    <section aria-label={t("Prévia da abordagem")} className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || gerando || !temAgente}
          onClick={() => {
            setGerando(true);
            setErroDaPrevia(null);
            void onPrevia(candidateId)
              .then(setPrevia)
              .catch((erro: unknown) =>
                // A2: o erro da prévia mora AQUI, na própria janela — subir
                // para o aviso geral da página tirava do operador o contexto
                // (de qual empresa falhou) e deixava o aviso preso ao trocar
                // de campanha.
                setErroDaPrevia(
                  erro instanceof Error ? erro.message : t("Não foi possível gerar a prévia."),
                ),
              )
              .finally(() => setGerando(false));
          }}
        >
          {gerando ? t("Gerando prévia…") : t("Prévia da abordagem")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {peloAgente
          ? t("Esta campanha escreve pelo prompt do agente: a auditoria do site não entra na mensagem.")
          : t("Esta campanha escreve pela estratégia do site: o ângulo vem da auditoria abaixo.")}
      </p>
      {!temAgente && (
        <p className="text-xs text-muted-foreground">
          {t("Escolha o agente na etapa 2 para ver a prévia.")}
        </p>
      )}
      {erroDaPrevia && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
        >
          {erroDaPrevia}
        </p>
      )}
      {previa && (
        <div ref={previaRef} className="rounded-md border p-3 text-xs leading-relaxed">
          <p className="whitespace-pre-wrap">{previa.mensagem}</p>
        </div>
      )}
    </section>
  );
  if (!site) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">{t("A verificar")}</p>
        <Skeleton className="h-4 w-32" />
        {/* Pelo prompt do agente a prévia não depende da auditoria: o detalhe abre já. */}
        {peloAgente && (
          <>
            <Button type="button" variant="outline" size="sm" onClick={abrir}>
              {t("Ver detalhes")}
            </Button>
            <Dialog open={aberto} onOpenChange={setAberto}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{t("Detalhes da empresa")}</DialogTitle>
                  <DialogDescription>{data.name}</DialogDescription>
                </DialogHeader>
                {blocoDaPrevia}
              </DialogContent>
            </Dialog>
          </>
        )}
      </div>
    );
  }
  const temInstagram = /instagram/i.test((data.socials ?? []).join(","));
  const score = pontuarCandidato(data.rating, data.reviews, site.classe, ofertas[0] ?? "site", site.provisorio ?? false, t);
  // Resumo de UMA linha: classe + até 2 problemas. O motivo do score acompanha
  // só quando diz algo além do veredito (senão "sem site próprio" repete).
  const rotulo = rotuloDaClasse(site.classe, t);
  const veredito = [rotulo, ...site.problemas.slice(0, 2).map((p) => descreverProblema(p, t))].join(" · ");
  const mostraMotivo = score.motivo !== rotulo && score.motivo.toLowerCase() !== rotulo.toLowerCase();
  const auditoria = (
    <AuditoriaDoSite
      // Só tem data o veredito que veio da REDE. O derivado (sem site) leva o
      // instante da leitura, e o gravado de sem-site/agregador é `vereditoPuro`
      // (site-classify.ts), que nunca abre conexão — "Verificado em <data>"
      // afirmaria uma verificação que não houve.
      site={data.site && !SEM_REDE.has(site.classe) ? site : { ...site, verificado_em: undefined }}
      nota={data.rating}
      numAvaliacoes={data.reviews}
      temInstagram={temInstagram}
      ofertas={ofertas}
      nicho={nicho}
      status={status}
      sobrescritaVocabulario={sobrescritaVocabulario}
    />
  );
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">
          Score {score.valor}
        </Badge>
        {mostraMotivo && (
          <span className="text-xs text-muted-foreground" title={score.motivo}>
            {score.motivo}
          </span>
        )}
      </div>
      <p className="truncate text-xs" title={veredito}>
        {veredito}
      </p>
      <Button type="button" variant="outline" size="sm" onClick={abrir}>
        {t("Ver detalhes")}
      </Button>
      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("Detalhes da empresa")}</DialogTitle>
            <DialogDescription>{data.name}</DialogDescription>
          </DialogHeader>
          {blocoDaPrevia}
          {/* Aberta pela estratégia do site (é dela que sai o ângulo); recolhida quando
              a campanha escreve pelo prompt do agente. */}
          <details open={!peloAgente} className="rounded-md border p-3">
            <summary className="cursor-pointer text-sm font-medium">
              {t("Auditoria do site")}
            </summary>
            <div className="mt-3 space-y-4 text-sm leading-relaxed">{auditoria}</div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => void onReanalisar(candidateId)}
              >
                {t("Reanalisar site")}
              </Button>
            </div>
          </details>
        </DialogContent>
      </Dialog>
    </div>
  );
}
