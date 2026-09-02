"use client";
/**
 * O painel que responde "o que eu liguei está funcionando?".
 *
 * Configurar sem observar é meia entrega: o humano liga seis capacidades e
 * nunca descobre que uma delas falha em toda tentativa, ou que outra ocupa uma
 * das vagas há um mês sem nunca ter sido usada.
 *
 * Cada linha aqui carrega uma recomendação, não só um número — invariante 5 da
 * doutrina do sistema vivo ("um número na tela que não muda uma decisão é
 * ruído"). A classificação vive em `lib/ai/agents/uso-de-capacidades.ts`.
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";
import type { CapacidadeComUso, SinalDeUso } from "@/lib/ai/agents/uso-de-capacidades";

interface Props {
  agentId: string;
  active: boolean;
}

interface Resposta {
  data: {
    janela_em_dias: number;
    versao_lida: { id: string; status: string } | null;
    resumo: { usos: number; falhas: number; precisam_de_atencao: number };
    capacidades: CapacidadeComUso[];
  };
}

const SINAL: Record<SinalDeUso, { rotulo: string; classe: string }> = {
  so_falha: {
    rotulo: "falhando sempre",
    classe: "border-destructive/50 bg-destructive/10 text-destructive",
  },
  falhando: {
    rotulo: "falhas",
    classe: "border-destructive/40 text-destructive",
  },
  fora_da_configuracao: {
    rotulo: "usada sem estar ligada",
    classe: "border-amber-500/40 text-amber-700 dark:text-amber-400",
  },
  nunca_usada: {
    rotulo: "nunca usada",
    classe: "border-amber-500/40 text-amber-700 dark:text-amber-400",
  },
  recem_ligada: {
    rotulo: "ligada agora",
    classe: "border-border/60 text-muted-foreground",
  },
  so_em_teste: {
    rotulo: "só em teste",
    classe: "border-border/60 text-muted-foreground",
  },
  saudavel: {
    rotulo: "funcionando",
    classe: "border-emerald-500/40 text-emerald-700 dark:text-emerald-400",
  },
};

/** `draft`/`published` são palavras do banco, não do dono da clínica. */
const NOME_DA_VERSAO: Record<string, string> = {
  draft: "que você está editando",
  published: "que está no ar",
  superseded: "antiga",
};

function formatarData(iso: string | null): string {
  if (!iso) return "nunca";
  return new Date(iso).toLocaleString("pt-PT", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function UsoDasCapacidades({ agentId, active }: Props) {
  const query = useQuery({
    queryKey: ["ai", "agents", agentId, "tool-usage"],
    queryFn: async () => {
      const res = await apiClient.get<Resposta>(
        `/api/v1/ai/agents/${agentId}/tool-usage`,
      );
      return res.data;
    },
    enabled: active,
    staleTime: 30_000,
  });

  if (query.isLoading) {
    return <p className="text-sm text-muted-foreground">Carregando o uso das capacidades…</p>;
  }
  if (query.isError || !query.data) {
    return (
      <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        Não foi possível carregar o uso das capacidades.
      </p>
    );
  }

  const { janela_em_dias, resumo, capacidades, versao_lida } = query.data;

  return (
    <div className="flex flex-col gap-4" data-testid="uso-das-capacidades">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm">
            <strong data-testid="uso-total">{resumo.usos}</strong>{" "}
            {resumo.usos === 1 ? "uso" : "usos"} nos últimos {janela_em_dias} dias
            {resumo.falhas > 0 ? (
              <>
                {" · "}
                <strong className="text-destructive" data-testid="uso-falhas">
                  {resumo.falhas}
                </strong>{" "}
                {resumo.falhas === 1 ? "falha" : "falhas"}
              </>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground">
            {resumo.precisam_de_atencao > 0
              ? `${resumo.precisam_de_atencao} ${
                  resumo.precisam_de_atencao === 1
                    ? "capacidade pede uma decisão sua"
                    : "capacidades pedem uma decisão sua"
                }.`
              : "Nada pedindo decisão no momento."}
            {versao_lida
              ? ` O que está ligado vem da versão ${
                  NOME_DA_VERSAO[versao_lida.status] ?? versao_lida.status
                }.`
              : null}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => query.refetch()}
          disabled={query.isFetching}
        >
          {query.isFetching ? "Atualizando…" : "Atualizar"}
        </Button>
      </div>

      {capacidades.length === 0 ? (
        <p
          data-testid="uso-vazio"
          className="rounded-md border border-border/60 p-4 text-sm text-muted-foreground"
        >
          Este agente ainda não tem nenhuma capacidade ligada, e nenhuma foi usada. Ligue
          o que ele pode fazer na aba Configuração.
        </p>
      ) : (
        <ul className="grid gap-2">
          {capacidades.map((c) => (
            <li
              key={c.name}
              data-testid={`uso-${c.name}`}
              data-sinal={c.sinal}
              className="rounded-md border border-border/60 p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{c.rotulo}</span>
                <Badge variant="outline" className={`text-[11px] ${SINAL[c.sinal].classe}`}>
                  {SINAL[c.sinal].rotulo}
                </Badge>
                {!c.ligada ? (
                  <Badge variant="outline" className="text-[11px] text-muted-foreground">
                    desligada
                  </Badge>
                ) : null}
                <span className="text-xs text-muted-foreground">· {c.o_que_toca}</span>
              </div>

              <p className="pt-1 text-xs text-muted-foreground">{c.recomendacao}</p>

              <div className="flex flex-wrap gap-x-4 pt-2 font-mono text-[11px] text-muted-foreground">
                <span>
                  usos <strong className="text-foreground">{c.total}</strong>
                </span>
                <span>
                  falhas{" "}
                  <strong className={c.falhas > 0 ? "text-destructive" : "text-foreground"}>
                    {c.falhas}
                  </strong>
                </span>
                <span>
                  em teste <strong className="text-foreground">{c.em_teste}</strong>
                </span>
                <span>última vez {formatarData(c.ultima_vez)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
