"use client";

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useEscolherNegocioDoRoteiro } from "@/hooks/contacts/useEscolherNegocioDoRoteiro";
import { useRoteirosDoContato } from "@/hooks/contacts/useRoteirosDoContato";
import { useT } from "@/hooks/i18n/useT";
import { rotuloDoStatus, tomDoStatus } from "@/lib/followup/eventos-legiveis";
import type { NegocioNaTela } from "@/lib/followup/negocio-do-roteiro";
import { ListChecks } from "@/lib/ui/icons";

interface Props {
  contactId: string;
  /** `ficha` = cartão da Visão geral; `painel` = seção compacta do painel da conversa. */
  variante?: "ficha" | "painel";
}

/**
 * A ESCOLHA do negócio desta execução (#3363), no lugar em que o roteiro
 * aparece. Só é desenhada quando a execução diz que falta escolha — 2+ cards
 * abertos e nada fixado. Sem default: o seletor começa vazio e o botão só
 * habilita com uma escolha feita; é a decisão de produto ("quando houver vários
 * candidatos, será exigida escolha") na única tela em que uma pessoa vê o
 * roteiro e os negócios do contato ao mesmo tempo.
 */
function EscolhaDoNegocio({
  contactId,
  enrollmentId,
  negocio,
}: {
  contactId: string;
  enrollmentId: string;
  negocio: NegocioNaTela;
}) {
  const t = useT();
  const [escolhido, setEscolhido] = useState("");
  const escolher = useEscolherNegocioDoRoteiro(contactId);

  if (negocio.vinculo !== null) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="roteiro-negocio-fixado">
        {t("Respostas no negócio")}: {negocio.vinculo.titulo ?? t("Sem título")}
      </p>
    );
  }

  if (!negocio.escolha_pendente) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="roteiro-negocio-sem-card">
        {t(
          "Este contato não tem negócio aberto: as respostas de negócio ficam pendentes até abrir um.",
        )}
      </p>
    );
  }

  return (
    <div className="space-y-1 rounded-md border border-border p-2">
      <p className="text-xs text-muted-foreground">
        {t(
          "Este contato tem mais de um negócio aberto: até alguém escolher, as respostas de negócio não são gravadas.",
        )}
      </p>
      <select
        aria-label={t("Negócio desta execução")}
        data-testid="roteiro-escolha-do-negocio"
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        value={escolhido}
        onChange={(e) => setEscolhido(e.target.value)}
      >
        <option value="">{t("Escolha o negócio")}</option>
        {negocio.candidatos.map((c) => (
          <option key={c.id} value={c.id}>
            {c.titulo ?? t("Sem título")}
          </option>
        ))}
      </select>{" "}
      <Button
        type="button"
        size="sm"
        data-testid="roteiro-confirmar-negocio"
        disabled={escolhido === "" || escolher.isPending}
        onClick={() => {
          if (escolhido === "") return;
          escolher.mutate({ enrollmentId, leadId: escolhido });
        }}
      >
        {t("Confirmar negócio")}
      </Button>
    </div>
  );
}

/**
 * O que os ROTEIROS de atendimento coletaram deste contato (achado 1 da prova
 * prática do #1130: o dado ia para o banco e não aparecia em tela nenhuma). O
 * resumo é montado dos campos — rótulo da pergunta e o valor que o cliente deu —,
 * sem modelo.
 *
 * Módulo desligado, ou contato sem roteiro: não desenha nada. A tela de quem não
 * usa o módulo fica exatamente como era.
 */
export function RoteirosDoContato({ contactId, variante = "ficha" }: Props) {
  const t = useT();
  const { activeOrg } = useAuth();
  const ligado = activeOrg?.modulos_ligados?.includes("fluxos_atendimento") === true;
  const { data, isLoading } = useRoteirosDoContato(contactId, ligado);

  if (!ligado) return null;
  if (isLoading) return <Skeleton className="h-16 w-full" />;
  if (!data || data.length === 0) return null;

  const compacto = variante === "painel";
  const conteudo = (
    <div className="space-y-4" data-testid="roteiros-do-contato">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <ListChecks size={16} aria-hidden className="text-text-muted" />
        {t("Respostas dos roteiros de atendimento")}
      </h3>
      {data.map((roteiro) => (
        <section key={roteiro.enrollment_id} className="space-y-2" data-testid={`roteiro-${roteiro.enrollment_id}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">{roteiro.nome}</p>
            <Badge variant={tomDoStatus(roteiro.status)}>{rotuloDoStatus(roteiro.status, t)}</Badge>
          </div>
          {roteiro.negocio !== undefined && (
            <EscolhaDoNegocio
              contactId={contactId}
              enrollmentId={roteiro.enrollment_id}
              negocio={roteiro.negocio}
            />
          )}
          <dl className={compacto ? "space-y-1 text-sm" : "grid grid-cols-1 gap-2 text-sm md:grid-cols-2"}>
            {roteiro.campos.map((campo) => (
              <div key={campo.key} data-testid={`roteiro-campo-${campo.key}`}>
                <dt className="text-xs uppercase text-muted-foreground">{campo.label}</dt>
                <dd className={campo.valor === null ? "text-muted-foreground" : ""}>
                  {campo.valor ??
                    (campo.onde === "negocio" ? t("no card do negócio") : t("não respondido"))}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );

  return compacto ? conteudo : <Card className="p-4">{conteudo}</Card>;
}
