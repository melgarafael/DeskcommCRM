"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";

import { useAuth } from "@/hooks/auth/AuthProvider";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { useContactTagVocabulary } from "@/hooks/contacts/useContactTagVocabulary";
import { useConversationTagVocabulary } from "@/hooks/inbox/useConversationTags";
import { useConversationCounts } from "@/hooks/inbox/useConversationCounts";
import { useT } from "@/hooks/i18n/useT";
import { CaretRight } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import {
  hrefDaVisao,
  visaoAtiva,
  type VisaoDoInbox,
} from "@/lib/inbox/visao-do-inbox";

/**
 * O SUBMENU DO INBOX (redesign kvgroup, seção 4.2): cada item é uma VISÃO da
 * lista, escrita na URL (`?view=`, `?channel=`, `?tag=`, `?filter=ai`). Quem
 * aplica o filtro é o `InboxLayout`, que lê a mesma URL; este componente só
 * monta links — recarregar ou compartilhar a página mantém a visão.
 *
 * Substitui os chips "Não lidos"/"Grupos", os seletores "Todos os números" e
 * "Todas as tags" e a aba "Automático" da coluna da lista.
 */
export function SubmenuDoInbox({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const pathname = usePathname();
  const params = useSearchParams();
  const naInbox = pathname === "/app/inbox" || pathname.startsWith("/app/inbox/");
  const atual = naInbox ? visaoAtiva(params) : null;

  const { activeOrg } = useAuth();
  const orgId = activeOrg?.orgId ?? null;
  const { data: counts } = useConversationCounts(orgId);
  const { data: canais } = useChannelSessions({ refetchInterval: 30_000 });
  const { data: tagsDeConversa } = useConversationTagVocabulary(orgId);
  const { data: tagsDeContato } = useContactTagVocabulary(orgId);
  const tags = useMemo(
    () =>
      [...new Set([...(tagsDeConversa ?? []), ...(tagsDeContato ?? [])])].sort((a, b) =>
        a.localeCompare(b),
      ),
    [tagsDeConversa, tagsDeContato],
  );

  const [canaisAbertos, setCanaisAbertos] = useState(atual?.tipo === "canal");
  const [tagsAbertas, setTagsAbertas] = useState(atual?.tipo === "tag");

  const link = (visao: VisaoDoInbox) => hrefDaVisao(naInbox ? params : null, visao);
  const ativo = (visao: VisaoDoInbox) =>
    atual !== null &&
    atual.tipo === visao.tipo &&
    (visao.tipo === "canal"
      ? atual.tipo === "canal" && atual.id === visao.id
      : visao.tipo === "tag"
        ? atual.tipo === "tag" && atual.nome === visao.nome
        : true);

  const item = (visao: VisaoDoInbox, rotulo: string, extra?: ReactNode, chave?: string) => (
    <li key={chave ?? rotulo}>
      <Link
        href={link(visao)}
        onClick={onNavigate}
        aria-current={ativo(visao) ? "page" : undefined}
        className={cn(
          "flex h-[30px] items-center gap-2 rounded-[6px] px-2.5 text-[13px] transition-colors",
          ativo(visao)
            ? "bg-[var(--kv-surface-2)] font-medium text-text"
            : "text-text-muted hover:bg-[var(--kv-hover)] hover:text-text",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{rotulo}</span>
        {extra}
      </Link>
    </li>
  );

  const grupoRecolhivel = (
    rotulo: string,
    aberto: boolean,
    alternar: () => void,
    filhos: ReactNode,
  ) => (
    <li>
      <button
        type="button"
        onClick={alternar}
        aria-expanded={aberto}
        className="flex h-[30px] w-full items-center gap-2 rounded-[6px] px-2.5 text-left text-[13px] text-text-muted transition-colors hover:bg-[var(--kv-hover)] hover:text-text"
      >
        <span className="min-w-0 flex-1 truncate">{rotulo}</span>
        <CaretRight
          size={12}
          aria-hidden
          className={cn("shrink-0 transition-transform", aberto && "rotate-90")}
        />
      </button>
      {aberto && <ul className="ml-2.5 space-y-0.5 border-l border-border pl-2">{filhos}</ul>}
    </li>
  );

  const automatico = counts?.automatico ?? 0;

  return (
    <ul
      aria-label={t("Visões do Inbox")}
      className="mt-0.5 ml-[18px] space-y-0.5 border-l border-border pl-2"
      data-testid="submenu-do-inbox"
    >
      {item({ tipo: "todas" }, t("Todas as conversas"))}
      {item(
        { tipo: "ia" },
        t("Com agente de IA"),
        automatico > 0 ? (
          <span className="rounded-full bg-[var(--kv-surface-2)] px-1.5 text-[11px] tabular-nums text-text-muted">
            {automatico}
          </span>
        ) : null,
      )}
      {item({ tipo: "nao-lidas" }, t("Não lidas"))}
      {item({ tipo: "grupos" }, t("Grupos"))}
      {(canais?.length ?? 0) > 0 &&
        grupoRecolhivel(
          t("Números e canais"),
          canaisAbertos,
          () => setCanaisAbertos((v) => !v),
          canais!.map((c) =>
            item(
              { tipo: "canal", id: c.id },
              channelLabel(c),
              <span
                aria-hidden
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full",
                  c.status === "WORKING" ? "bg-[var(--kv-online)]" : "bg-text-subtle",
                )}
              />,
              c.id,
            ),
          ),
        )}
      {tags.length > 0 &&
        grupoRecolhivel(
          t("Tags"),
          tagsAbertas,
          () => setTagsAbertas((v) => !v),
          tags.map((tag) => item({ tipo: "tag", nome: tag }, tag, undefined, `tag:${tag}`)),
        )}
    </ul>
  );
}

