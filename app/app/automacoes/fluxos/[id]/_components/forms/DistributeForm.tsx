"use client";

import Link from "next/link";
import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useAttendants, useRoutingConfig } from "@/hooks/team/useAttendants";
import { ROTULO_DA_SITUACAO, situacaoDoAtendente, type SituacaoDoAtendente } from "@/lib/routing/situacao";
import { cn } from "@/lib/utils";
import { useT } from "@/hooks/i18n/useT";
import { DISTRIBUTE_MODES, distributeConfigSchema, type DistributeMode } from "@/lib/followup/graph-schema";
import { MODOS_DE_DISTRIBUICAO } from "@/lib/followup/vocabulario";

import type { ConfigOf } from "./shared";

type Config = ConfigOf<"distribute">;
type Tipo = Config["destino"]["tipo"];

const ROTULO_DO_TIPO: Record<Tipo, string> = {
  atendente: "Uma pessoa específica",
  equipe: "Uma lista de pessoas",
  carteira: "O vendedor dono do cliente (carteira)",
};

const ROTULO_DO_MODO = MODOS_DE_DISTRIBUICAO;

const COR_DA_SITUACAO: Record<SituacaoDoAtendente, string> = {
  pode_receber: "text-success-fg",
  indisponivel: "text-error-fg",
  fora_do_horario: "text-warning-fg",
  lotado: "text-warning-fg",
};

/**
 * O bloco "Distribuir atendimento" (Automações, out/2026). Quem recebe a
 * conversa, como a lista é repartida e se só vale quem está disponível.
 *
 * O config só recebe o que passa no `distributeConfigSchema`; a escolha vazia é
 * aceita (o rascunho salva) e quem cobra é a publicação (`destino_ausente`).
 */
export function DistributeForm({ config, onChange }: { config: Config; onChange: (c: Config) => void }) {
  const t = useT();
  const { data: members } = useAssignableMembers(true);
  const [erro, setErro] = useState<string | null>(null);

  const gravar = (candidato: Config) => {
    const parsed = distributeConfigSchema.safeParse(candidato);
    if (!parsed.success) {
      setErro(parsed.error.issues[0]?.message ?? t("Configuração inválida."));
      return;
    }
    setErro(null);
    onChange(parsed.data);
  };

  const trocarTipo = (tipo: Tipo) => {
    const destino: Config["destino"] =
      tipo === "atendente"
        ? { tipo, usuario_id: "" }
        : tipo === "equipe"
          ? { tipo, modo: "rodizio", membros: [] }
          : { tipo };
    gravar({ ...config, destino });
  };

  // Automações: o bloco lê o modo da empresa e a disponibilidade da equipe para
  // dizer, ANTES de publicar, se a distribuição dele vai mesmo acontecer.
  const { data: routing } = useRoutingConfig();
  const { data: equipe } = useAttendants();
  const modoDaEmpresa = routing?.data?.mode;
  const agora = new Date();
  const situacaoDe = (id: string): SituacaoDoAtendente | null => {
    const a = equipe?.data?.find((x) => x.user_id === id);
    if (!a) return null;
    if (config.so_disponiveis === false) return "pode_receber";
    return situacaoDoAtendente(
      { isAvailable: a.is_available, capacity: a.capacity, currentLoad: a.current_load, schedule: a.schedule },
      agora,
      config.limite_por_atendente,
    );
  };
  const equipeDe = equipe?.data ?? [];
  const nomeDe = (id: string) =>
    members?.find((m) => m.user_id === id)?.full_name ??
    equipeDe.find((x) => x.user_id === id)?.email ??
    id.slice(0, 8);
  const d = config.destino;

  return (
    <div className="grid gap-3" data-testid="distribute-form">
      <p className="text-xs text-text-muted">
        {t("Entrega a conversa a alguém da equipe — nenhuma mensagem sai para o cliente. Conversa que já tem dono não é trocada.")}
      </p>

      {modoDaEmpresa === "round_robin" || modoDaEmpresa === "load" ? (
        <p className="rounded-md border border-warning bg-warning-bg p-2 text-xs text-warning-fg" data-testid="aviso-modo-da-empresa">
          {t(
            "A empresa está distribuindo sozinha (Rodízio ou Menor carga). A conversa ganha dono assim que chega e este bloco vai só seguir por Distribuído. Para este bloco decidir, troque para Pelos fluxos de Automações em",
          )}{" "}
          <Link href="/app/settings/atendimento" className="underline">
            {t("Distribuição de atendimento")}
          </Link>
          .
        </p>
      ) : null}

      <div className="space-y-1">
        <Label htmlFor="distribute-tipo">{t("Para quem vai")}</Label>
        <Select value={d.tipo} onValueChange={(v) => trocarTipo(v as Tipo)}>
          <SelectTrigger id="distribute-tipo">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(ROTULO_DO_TIPO) as Tipo[]).map((tipo) => (
              <SelectItem key={tipo} value={tipo}>
                {t(ROTULO_DO_TIPO[tipo])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {d.tipo === "atendente" && (
        <div className="space-y-1">
          <Label htmlFor="distribute-atendente">{t("Atendente")}</Label>
          <Select value={d.usuario_id || undefined} onValueChange={(v) => gravar({ ...config, destino: { ...d, usuario_id: v } })}>
            <SelectTrigger id="distribute-atendente">
              <SelectValue placeholder={t("Escolha uma pessoa")} />
            </SelectTrigger>
            <SelectContent>
              {(members ?? []).map((m) => (
                <SelectItem key={m.user_id} value={m.user_id}>
                  {m.full_name ?? m.user_id.slice(0, 8)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {d.usuario_id && situacaoDe(d.usuario_id) ? (
            <p className={cn("text-xs", COR_DA_SITUACAO[situacaoDe(d.usuario_id)!])} data-testid={`situacao-${d.usuario_id}`}>
              {t("Agora:")} {t(ROTULO_DA_SITUACAO[situacaoDe(d.usuario_id)!])}
            </p>
          ) : null}
        </div>
      )}

      {d.tipo === "equipe" && (
        <>
          <div className="space-y-1">
            <Label htmlFor="distribute-modo">{t("Como repartir")}</Label>
            <Select
              value={d.modo}
              onValueChange={(v) => gravar({ ...config, destino: { ...d, modo: v as DistributeMode } })}
            >
              <SelectTrigger id="distribute-modo">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DISTRIBUTE_MODES.map((modo) => (
                  <SelectItem key={modo} value={modo}>
                    {t(ROTULO_DO_MODO[modo])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label>{t("Pessoas da lista")}</Label>
            {d.membros.length === 0 && <p className="text-xs text-text-muted">{t("Ninguém escolhido ainda.")}</p>}
            <ul className="space-y-1" data-testid="distribute-membros">
              {d.membros.map((m, i) => (
                <li key={m.usuario_id} className="flex items-center gap-2 text-sm">
                  <span className="flex-1 truncate">{nomeDe(m.usuario_id)}</span>
                  {situacaoDe(m.usuario_id) ? (
                    <span
                      className={cn("text-xs", COR_DA_SITUACAO[situacaoDe(m.usuario_id)!])}
                      data-testid={`situacao-${m.usuario_id}`}
                    >
                      {t(ROTULO_DA_SITUACAO[situacaoDe(m.usuario_id)!])}
                    </span>
                  ) : null}
                  {d.modo === "percentual" && (
                    <Input
                      aria-label={t("Peso")}
                      className="h-8 w-20"
                      type="number"
                      min={1}
                      max={100}
                      value={m.peso ?? 1}
                      onChange={(e) => {
                        const membros = d.membros.map((x, j) =>
                          j === i ? { ...x, peso: Math.min(100, Math.max(1, Number(e.target.value) || 1)) } : x,
                        );
                        gravar({ ...config, destino: { ...d, membros } });
                      }}
                    />
                  )}
                  <button
                    type="button"
                    className="text-xs text-error-fg hover:underline"
                    onClick={() =>
                      gravar({ ...config, destino: { ...d, membros: d.membros.filter((_, j) => j !== i) } })
                    }
                  >
                    {t("Remover")}
                  </button>
                </li>
              ))}
            </ul>
            <Select
              value=""
              onValueChange={(v) => {
                if (!v || d.membros.some((m) => m.usuario_id === v)) return;
                gravar({ ...config, destino: { ...d, membros: [...d.membros, { usuario_id: v, peso: 1 }] } });
              }}
            >
              <SelectTrigger aria-label={t("Adicionar pessoa")}>
                <SelectValue placeholder={t("+ Adicionar pessoa")} />
              </SelectTrigger>
              <SelectContent>
                {(members ?? [])
                  .filter((m) => !d.membros.some((x) => x.usuario_id === m.user_id))
                  .map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      {m.full_name ?? m.user_id.slice(0, 8)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        </>
      )}

      {d.tipo === "carteira" && (
        <p className="text-xs text-text-muted">
          {t("Vai para o vendedor marcado como dono do cliente na ficha do contato. Cliente sem dono sai por Ninguém disponível.")}
        </p>
      )}

      <div className="flex items-start justify-between gap-3 rounded-md border border-border p-2">
        <div>
          <Label htmlFor="distribute-disponiveis">{t("Só quem está disponível")}</Label>
          <p className="text-xs text-text-muted">
            {t("Respeita a disponibilidade, o horário e a capacidade de cada atendente (Configurações › Atendimento).")}
          </p>
        </div>
        <Switch
          id="distribute-disponiveis"
          checked={config.so_disponiveis !== false}
          onCheckedChange={(v) => gravar({ ...config, so_disponiveis: v })}
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="distribute-limite">{t("Limite de conversas abertas por pessoa (opcional)")}</Label>
        <Input
          id="distribute-limite"
          type="number"
          min={1}
          max={500}
          value={config.limite_por_atendente ?? ""}
          placeholder={t("Sem limite")}
          onChange={(e) => {
            const n = Number(e.target.value);
            const { limite_por_atendente: _antigo, ...resto } = config;
            gravar(e.target.value === "" || !n ? resto : { ...resto, limite_por_atendente: Math.min(500, Math.max(1, n)) });
          }}
        />
      </div>

      <p className="text-xs text-text-muted">
        {t("Ligue a saída Distribuído ao próximo passo e a saída Ninguém disponível a uma espera ou a um aviso para o gestor.")}
      </p>

      {erro && (
        <p className="text-xs text-error-fg" role="alert">
          {erro}
        </p>
      )}
    </div>
  );
}
