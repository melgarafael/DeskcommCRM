"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { useAutomaticoAtivo } from "@/hooks/ai/useAutomaticoAtivo";
import { useT } from "@/hooks/i18n/useT";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { apiClient } from "@/lib/api/client";
import { rotuloDoContato, type ContatoNomeavel } from "@/lib/contacts/rotulo-do-contato";
import { automaticoNoComando, consultasDoPainel, haQuantoTempo, montarColunas, type ConversaDoPainel } from "@/lib/inbox/painel-de-atendimento";
import { Robot } from "@/lib/ui/icons";

interface Conversa extends ConversaDoPainel {
  last_message_preview: string | null;
  contacts?: (ContatoNomeavel & NonNullable<ConversaDoPainel["contacts"]>) | null;
}

interface RespostaDaLista {
  data: Conversa[];
  meta?: { has_more?: boolean };
}

function Coluna<C extends Conversa>({
  titulo,
  itens,
  destaque,
  vazio,
  tempo,
  rotulo,
  automaticoDaOrg,
  rotuloIA,
}: {
  titulo: string;
  itens: C[];
  destaque?: boolean;
  vazio: string;
  tempo: (c: C) => string;
  rotulo: (c: Conversa) => string;
  automaticoDaOrg: boolean | undefined;
  rotuloIA: string;
}) {
  return (
    <section className="flex max-h-[28rem] min-h-0 flex-col rounded-lg border border-border bg-surface md:max-h-none">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{titulo}</h2>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
            destaque && itens.length > 0 ? "bg-red-600 text-white" : "bg-surface-elevated text-text-muted"
          }`}
        >
          {itens.length}
        </span>
      </header>
      <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
        {itens.length === 0 && <li className="px-4 py-6 text-center text-sm text-text-muted">{vazio}</li>}
        {itens.map((c) => (
          <li key={c.id}>
            <Link href={`/app/inbox?id=${c.id}`} className="block px-4 py-3 hover:bg-surface-elevated">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{rotulo(c)}</span>
                <span className={`shrink-0 text-xs ${destaque ? "font-semibold text-red-500" : "text-text-muted"}`}>
                  {tempo(c)}
                </span>
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-text-muted">
                {automaticoNoComando(c, automaticoDaOrg) && <Robot className="mr-1 inline h-3 w-3" aria-label={rotuloIA} />}
                {c.last_message_preview ?? ""}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function PainelDeAtendimento() {
  const t = useT();
  const { activeOrg } = useAuth();
  const orgId = activeOrg?.orgId ?? null;
  const { data: numeros } = useChannelSessions();
  const [numero, setNumero] = useState<string>("");

  const { data: automaticoDaOrg } = useAutomaticoAtivo();
  const fuso = activeOrg?.timezone;
  const consultas = consultasDoPainel({ numero, automaticoDaOrg, fuso });

  const abertas = useQuery({
    queryKey: ["painel-de-atendimento", consultas.abertas],
    queryFn: () => apiClient.get<RespostaDaLista>(consultas.abertas),
    refetchInterval: 15_000,
    enabled: !!orgId,
  });
  const fila = useQuery({
    queryKey: ["painel-de-atendimento", consultas.fila],
    queryFn: () => apiClient.get<RespostaDaLista>(consultas.fila),
    refetchInterval: 15_000,
    enabled: !!orgId,
  });
  const encerradas = useQuery({
    queryKey: ["painel-de-atendimento", consultas.encerradas],
    queryFn: () => apiClient.get<RespostaDaLista>(consultas.encerradas),
    refetchInterval: 60_000,
    enabled: !!orgId,
  });
  const casos = useQuery({
    queryKey: ["painel-de-atendimento", "casos"],
    queryFn: () => apiClient.get<{ data: { open_count?: number } }>("/api/v1/ai/cases?status=open"),
    refetchInterval: 30_000,
    enabled: !!orgId,
  });

  const colunas = useMemo(
    () => montarColunas([...(abertas.data?.data ?? []), ...(fila.data?.data ?? []), ...(encerradas.data?.data ?? [])], fuso),
    [abertas.data, fila.data, encerradas.data, fuso],
  );
  const casosAbertos = casos.data?.data?.open_count ?? 0;
  const rotulo = (c: Conversa) => rotuloDoContato(c.contacts, t);
  const rotuloIA = t("Automático atendendo");
  const haTempo = (iso: string) => t("há {tempo}").replace("{tempo}", haQuantoTempo(iso));
  // Cada consulta devolve no máximo 100: se há mais, a coluna não é a lista inteira.
  const truncado = [abertas, fila, encerradas].some((lista) => lista.data?.meta?.has_more === true);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4 md:h-[calc(100dvh-var(--faixas-de-cima,0px)-3.5rem-var(--space-6)-max(var(--space-6),var(--rodape-ocupado,0px)))] md:overflow-visible md:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-2xl font-semibold tracking-tight">{t("Painel de atendimento")}</h1>
        <select
          aria-label={t("Número")}
          value={numero}
          onChange={(e) => setNumero(e.target.value)}
          className="h-9 min-w-0 max-w-full rounded-md border border-border bg-background px-3 text-sm"
        >
          <option value="">{t("Todos os números")}</option>
          {(numeros ?? []).map((n) => (
            <option key={n.id} value={n.id}>
              {channelLabel(n, t)}
            </option>
          ))}
        </select>
        {/* Só aparece se a consulta deu certo: quem não pode ver casos receberia um "0" que mente. */}
        {casos.isSuccess && (
          <Link
            href="/app/ai/cases"
            className={`h-9 rounded-md border px-3 text-sm leading-9 ${
              casosAbertos > 0 ? "border-red-600 font-semibold text-red-500" : "border-border text-text-muted"
            }`}
          >
            {t("Casos da IA")}: {casosAbertos}
          </Link>
        )}
      </header>
      {(abertas.isError || fila.isError || encerradas.isError) && (
        <p className="text-sm text-red-500">{t("Não deu para carregar as conversas agora.")}</p>
      )}
      {truncado && (
        <p className="text-xs text-text-muted">
          {t("Há mais de 100 conversas em alguma lista. Quem espera sem dono são as 100 com mais tempo de espera; as demais são as 100 com a mensagem mais recente.")}
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 md:min-h-0 md:flex-1 md:grid-cols-3 md:grid-rows-[minmax(0,1fr)]">
        <Coluna
          titulo={t("Aguardando atendimento")}
          itens={colunas.aguardando}
          destaque
          vazio={t("Ninguém esperando.")}
          rotulo={rotulo}
          automaticoDaOrg={automaticoDaOrg}
          rotuloIA={rotuloIA}
          tempo={(c) => t("esperando há {tempo}").replace("{tempo}", haQuantoTempo(c.esperandoDesde))}
        />
        <Coluna
          titulo={t("Em atendimento")}
          itens={colunas.emAtendimento}
          vazio={t("Nenhuma conversa em andamento.")}
          rotulo={rotulo}
          automaticoDaOrg={automaticoDaOrg}
          rotuloIA={rotuloIA}
          tempo={(c) => (c.last_message_at ? haTempo(c.last_message_at) : "")}
        />
        <Coluna
          titulo={t("Atendidos hoje")}
          itens={colunas.atendidosHoje}
          vazio={t("Nada encerrado hoje ainda.")}
          rotulo={rotulo}
          automaticoDaOrg={automaticoDaOrg}
          rotuloIA={rotuloIA}
          tempo={(c) => {
            const quando = c.service_closed_at ?? c.status_changed_at;
            return quando ? haTempo(quando) : "";
          }}
        />
      </div>
    </div>
  );
}
