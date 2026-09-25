"use client";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useRoteirosDoContato } from "@/hooks/contacts/useRoteirosDoContato";
import { useT } from "@/hooks/i18n/useT";
import { rotuloDoStatus, tomDoStatus } from "@/lib/followup/eventos-legiveis";
import { ListChecks } from "@/lib/ui/icons";

interface Props {
  contactId: string;
  /** `ficha` = cartão da Visão geral; `painel` = seção compacta do painel da conversa. */
  variante?: "ficha" | "painel";
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
          <dl className={compacto ? "space-y-1 text-sm" : "grid grid-cols-1 gap-2 text-sm md:grid-cols-2"}>
            {roteiro.campos.map((campo) => (
              <div key={campo.key} data-testid={`roteiro-campo-${campo.key}`}>
                <dt className="text-xs uppercase text-muted-foreground">{campo.label}</dt>
                <dd className={campo.valor === null ? "text-muted-foreground" : ""}>
                  {campo.valor ?? t("não respondido")}
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
