"use client";

import { useT } from "@/hooks/i18n/useT";
import { TIPOS_DE_LINK } from "@/lib/leads/links-de-contato";
import type { Lead } from "@/lib/types/leads";
import { EnvelopeSimple, Phone } from "@/lib/ui/icons";

interface Props {
  lead: Pick<Lead, "contact_phone" | "contact_email" | "contact_links">;
}

/**
 * Telefone, e-mail e links do CONTATO, no card do funil.
 *
 * Some por inteiro quando não há nada a mostrar (negócio sem contato é estado
 * normal) — mesma regra do `ConversaSlot`: o card não reserva altura para o que
 * não existe.
 *
 * Cada link é um `<a>` com `stopPropagation`: o card inteiro abre o dossiê ao
 * clique, e abrir o Instagram de alguém não pode abrir o dossiê por cima. O
 * arrasto não é afetado — o dnd não inicia gesto a partir de elemento
 * interativo.
 *
 * O `href` já chega validado do servidor (`linksParaExibir`), e mesmo assim só
 * se renderiza o que começa com http(s): um card que recebesse um valor
 * estranho por outro caminho (evento em tempo real, cache antigo) não vira
 * `javascript:` clicável.
 */
export function ContatoNoCard({ lead }: Props) {
  const t = useT();
  const telefone = lead.contact_phone;
  const email = lead.contact_email;
  const links = (lead.contact_links ?? []).filter(({ href }) => /^https?:\/\//i.test(href));

  if (!telefone && !email && links.length === 0) return null;

  return (
    <div className="mt-1 space-y-1 text-xs text-text-muted" data-testid="contato-no-card">
      {(telefone || email) && (
        <div className="flex min-w-0 items-center gap-2">
          {telefone && (
            <span className="inline-flex shrink-0 items-center gap-1 tabular-nums">
              <Phone size={12} aria-hidden />
              <span className="sr-only">{t("Telefone")}: </span>
              {telefone}
            </span>
          )}
          {email && (
            <span className="inline-flex min-w-0 items-center gap-1">
              <EnvelopeSimple size={12} aria-hidden />
              <span className="sr-only">{t("E-mail")}: </span>
              <span className="truncate">{email}</span>
            </span>
          )}
        </div>
      )}
      {links.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {links.map(({ tipo, href }) => {
            const definicao = TIPOS_DE_LINK.find((d) => d.id === tipo);
            const rotulo = definicao ? t(definicao.rotulo) : tipo;
            return (
              <a
                key={tipo}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                title={`${rotulo} — ${href}`}
                aria-label={`${t("Abrir")} ${rotulo}`}
                onClick={(e) => e.stopPropagation()}
                className="rounded-md border border-border px-1.5 py-0.5 text-[11px] leading-4 text-text-muted hover:border-accent hover:text-accent"
              >
                {definicao?.curto ?? tipo}
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
