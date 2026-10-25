"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { formatDistanceToNowStrict } from "date-fns";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useCase } from "@/hooks/ai/useCases";
import { STATUS_BADGE_VARIANT, STATUS_LABEL, caseEventLabel } from "@/lib/ai/case-copy";
import { useT } from "@/hooks/i18n/useT";
import { CaseChatPanel } from "./CaseChatPanel";
import { CaseReplyPanel } from "./CaseReplyPanel";

export function CaseDetail({ caseId }: { caseId: string | null }) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const { data, isLoading } = useCase(caseId);

  if (caseId === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 py-16 text-center">
        <p className="text-sm font-medium">{t("Selecione um caso à esquerda")}</p>
        <p className="text-xs text-muted-foreground">{t("Os detalhes e a resposta aparecem aqui.")}</p>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto break-words">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{data.contact_name ?? t("Contato sem nome")}</h2>
          <p className="text-xs text-muted-foreground">{data.contact_phone ?? t("Sem telefone")}</p>
          <Link
            className="relative text-xs underline underline-offset-4 pointer-coarse:inline-block pointer-coarse:before:absolute pointer-coarse:before:-inset-3.5 pointer-coarse:before:content-['']"
            href={`/app/inbox/${data.conversation_id}`}
          >
            {t("Ver conversa")}
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {data.source === "guardrail_autofallback" ? (
            <Badge
              variant="neutral"
              title={t(
                "Aberto automaticamente pelo sistema — a IA prometeu passar pra humano mas não abriu o caso, então o sistema abriu por ela.",
              )}
            >
              {t("Aberto automaticamente")}
            </Badge>
          ) : null}
          <Badge variant={STATUS_BADGE_VARIANT[data.status]}>{t(STATUS_LABEL[data.status])}</Badge>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs font-medium text-muted-foreground">{t("O que o cliente precisa")}</p>
          <p className="mt-1 text-sm">{data.summary}</p>
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs font-medium text-muted-foreground">{t("Por que a IA travou")}</p>
          <p className="mt-1 text-sm">{data.blocker}</p>
        </div>
      </div>

      <CaseReplyPanel caseId={data.id} status={data.status} />

      {/*
        DEPOIS da decisão, e a ordem é CONTRATO.

        `escalacao-ciclo.spec.ts` acha o campo de decisão por
        `page.locator("textarea").first()`. Subir o chat aqui faria o e2e
        digitar a decisão do atendente dentro da pergunta à IA — e os dois e2e
        que dependem desse localizador ficariam vermelhos com um sintoma que
        não aponta para este arquivo. Quem mede é `tests/unit/case-detail.test.tsx`.
      */}
      <CaseChatPanel caseId={data.id} />

      <div>
        <h3 className="mb-2 text-sm font-semibold">{t("Linha do tempo")}</h3>
        <ul className="space-y-2">
          {data.events.map((ev) => (
            <li key={ev.id} className="text-xs text-muted-foreground">
              <span className="text-text">{t(caseEventLabel(ev))}</span>
              {ev.body ? <>: {ev.body}</> : null}
              {" · "}
              {formatDistanceToNowStrict(new Date(ev.created_at), { addSuffix: true, locale: localeDaData })}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
