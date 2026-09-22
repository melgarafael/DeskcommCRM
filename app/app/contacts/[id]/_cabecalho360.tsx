"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/hooks/i18n/useT";
import { PencilSimple } from "@/lib/ui/icons";
import { comoMoeda } from "@/lib/format/moeda";
import { ROTULO_RECOMPRA } from "@/lib/comercial/radar-compras";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import type { Contact } from "@/lib/types/contacts";
import { useResumo360 } from "./_resumo360";

/**
 * Cabeçalho 360°: identidade + fatos comerciais (última compra, acumulado,
 * situação de recompra, negócios em aberto). Responsável NÃO aparece porque o
 * campo não existe no contato — inventar dono seria mentir; negócios em aberto
 * com link cumprem o papel sem falsificar.
 */
export function Cabecalho360({
  contact,
  contactId,
  onEdit,
}: {
  contact: Contact;
  contactId: string;
  onEdit: () => void;
}) {
  const { resumo, isLoading } = useResumo360(contactId);
  const t = useT();
  const displayName = rotuloDoContato(contact);
  const h = resumo?.historico ?? null;

  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-medium tracking-tight break-words text-text">{displayName}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {contact.email && <span>{contact.email}</span>}
          {contact.email && contact.phone_number && <span>•</span>}
          {contact.phone_number && <span>{phoneForDisplay(contact.phone_number)}</span>}
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {contact.tags.map((t) => (
            <Badge key={t} variant="neutral">
              {t}
            </Badge>
          ))}
          {contact.tipo_pessoa === "J" && <Badge variant="info">PJ</Badge>}
          {contact.tipo_pessoa === "F" && <Badge variant="neutral">PF</Badge>}
          {h && h.situacao !== "ok" && (
            <Badge variant="warning">{ROTULO_RECOMPRA[h.situacao]}</Badge>
          )}
          {h && h.situacao === "ok" && <Badge variant="success">{t("Em dia")}</Badge>}
          {contact.is_blocked && <Badge variant="warning">{t("Bloqueado")}</Badge>}
          {contact.is_anonymized && <Badge variant="destructive">{t("Anonimizado")}</Badge>}
        </div>
        {isLoading ? (
          <Skeleton className="mt-3 h-12 w-72" />
        ) : h ? (
          <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground uppercase">{t("Última compra")}</dt>
              <dd className="font-medium text-text tabular-nums">
                {h.ultima_compra.split("-").reverse().join("/")} · {t("há")} {h.dias_sem_compra}d
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground uppercase">{t("Valor acumulado")}</dt>
              <dd className="font-medium text-text tabular-nums">
                {comoMoeda(h.faturamento_cents, "BRL")} · {h.qtd_pedidos} {t("pedido(s)")}
              </dd>
            </div>
            {resumo && resumo.leadsAbertos > 0 ? (
              <div>
                <dt className="text-xs text-muted-foreground uppercase">
                  {t("Negócios em aberto")}
                </dt>
                <dd className="font-medium text-text tabular-nums">{resumo.leadsAbertos}</dd>
              </div>
            ) : null}
          </dl>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            {t("Ainda sem compras registradas.")}
          </p>
        )}
      </div>
      {!contact.is_anonymized && (
        <Button variant="outline" onClick={onEdit} className="shrink-0">
          <PencilSimple size={16} weight="bold" aria-hidden />
          <span>{t("Editar")}</span>
        </Button>
      )}
    </header>
  );
}
