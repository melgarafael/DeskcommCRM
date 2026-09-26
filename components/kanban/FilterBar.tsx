"use client";
import { useEffect, useMemo, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PontoDaEtiqueta } from "@/components/tags/PontoDaEtiqueta";
import { useUser } from "@/hooks/auth/AuthProvider";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useAssignableAgents } from "@/hooks/kanban/useAssignableAgents";
import type { Lead, OwnerKind } from "@/lib/types/leads";
import { marcadoresDoCard } from "@/lib/kanban/marcadores-do-card";
import { OwnerBadge } from "./OwnerBadge";
import {
  agentOwnerFilter,
  parseAgentOwnerFilter,
  type LeadFilters,
} from "@/lib/kanban/filters";
import { categoriaDoMotivo } from "@/lib/leads/motivos-de-perda-do-funil";
import { rotuloDoMotivoDePerda } from "@/lib/schemas/leads";
import { cn } from "@/lib/utils";

interface FilterBarProps {
  filters: LeadFilters;
  onChange: (next: LeadFilters) => void;
  leads: Lead[];
  /**
   * O `settings` do funil do quadro (issue #1537) — é dele que sai a categoria
   * de cada motivo, que não é coluna do lead nem está no card. Sem isto o filtro
   * de categoria não teria o que oferecer.
   */
  settings?: Record<string, unknown>;
}

const STATUS_OPTIONS: Array<{ value: NonNullable<LeadFilters["status"]>; label: string }> = [
  { value: "all", label: "Todos" },
  { value: "open", label: "Abertos" },
  { value: "won", label: "Ganhos" },
  { value: "lost", label: "Perdidos" },
];

export function FilterBar({ filters, onChange, leads, settings }: FilterBarProps) {
  const t = useT();
  const user = useUser();
  const { data: members } = useAssignableMembers(true);
  const { data: agents } = useAssignableAgents(true);
  const [searchInput, setSearchInput] = useState(filters.search ?? "");

  // Debounce search 250ms
  useEffect(() => {
    const t = setTimeout(() => {
      if ((filters.search ?? "") !== searchInput) {
        onChange({ ...filters, search: searchInput });
      }
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  /**
   * Quem OFERECE lê a MESMA regra de quem FILTRA (`applyFilters`) — ver
   * lib/kanban/marcadores-do-card.ts. Antes eram só `l.tags`, a caixa do
   * negócio: o marcador escrito no CONTATO não aparecia aqui nem casava lá.
   *
   * A varredura alcança o funil inteiro: a rota do quadro devolve todos os
   * cards de uma vez, sem paginar.
   */
  const tagOptions = useMemo(() => {
    const set = new Set<string>();
    for (const l of leads) for (const t of marcadoresDoCard(l)) set.add(t);
    return Array.from(set).sort();
  }, [leads]);

  const filteredAgentId = parseAgentOwnerFilter(filters.owner);

  /**
   * Responsáveis atribuíveis numa lista única — humanos e agentes ordenados
   * juntos. O dono de um lead é UM campo; quem pode ser dono aparece numa lista
   * só. A distinção é geométrica (avatar), nunca posicional.
   */
  const assignees = useMemo(() => {
    type Row = {
      key: string;
      owner: string;
      name: string;
      kind: OwnerKind;
      version: number | null;
    };
    const rows: Row[] = [
      ...(members ?? [])
        .filter((m) => m.user_id !== user.id)
        .map((m) => ({
          key: `u:${m.user_id}`,
          owner: m.user_id,
          name: m.full_name ?? t("Sem nome"),
          kind: "user" as OwnerKind,
          version: null,
        })),
      ...(agents ?? []).map((a) => ({
        key: `a:${a.agent_id}`,
        owner: agentOwnerFilter(a.agent_id),
        name: a.name,
        kind: "ai" as OwnerKind,
        version: a.version_number,
      })),
    ];
    return rows.sort((x, y) => x.name.localeCompare(y.name, "pt-BR"));
  }, [members, agents, user.id, t]);
  const ownerLabel =
    filters.owner === "unassigned"
      ? t("Sem responsável")
      : !filters.owner || filters.owner === "any"
        ? t("Todos")
        : filteredAgentId
          ? (agents?.find((a) => a.agent_id === filteredAgentId)?.name ?? t("Agente"))
          : filters.owner === user.id
            ? t("Eu")
            : (members?.find((m) => m.user_id === filters.owner)?.full_name ??
              t("Responsável"));

  const statusLabel = t(
    STATUS_OPTIONS.find((o) => o.value === (filters.status ?? "all"))?.label ?? "Todos",
  );

  const tagLabel = filters.tag ?? t("Tag: todas");

  /**
   * Motivo e categoria da perda (issue #1537). As opções vêm do que ESTÁ no
   * quadro, não do cadastro: um motivo que nenhum card tem nunca acharia nada.
   * A categoria resolve pela MESMA régua de quem filtra (`applyFilters` →
   * `categoriaDoMotivo`), porque filtrar por uma regra e mostrar por outra é o
   * defeito que o filtro de marcador já teve.
   */
  const motivosPerdidos = useMemo(() => {
    const set = new Set<string>();
    for (const l of leads) if (l.status === "lost" && l.lost_reason) set.add(l.lost_reason);
    return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [leads]);
  const categoriasPerdidas = useMemo(() => {
    const set = new Set<string>();
    for (const motivo of motivosPerdidos) {
      const categoria = categoriaDoMotivo(motivo, settings);
      if (categoria) set.add(categoria);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [motivosPerdidos, settings]);
  /** Só com a aba em Perdidos: fora dela os dois filtros esconderiam tudo. */
  const mostraPerda = (filters.status ?? "all") === "lost" && motivosPerdidos.length > 0;
  // Canônico vira o rótulo traduzido; motivo próprio do funil é dado e sai como está.
  const rotuloDoMotivo = (motivo: string) => {
    const rotulo = rotuloDoMotivoDePerda(motivo);
    return rotulo === motivo ? motivo : t(rotulo);
  };
  const motivoLabel = filters.lostReason ? rotuloDoMotivo(filters.lostReason) : t("Todos");
  const categoriaLabel = filters.lostCategory ?? t("Todas");

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-2">
      <Input
        type="search"
        placeholder={t("Buscar por título…")}
        value={searchInput}
        onChange={(e) => setSearchInput(e.target.value)}
        className="h-9 w-full sm:w-64"
      />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            {t("Responsável")}: {ownerLabel}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>{t("Responsável")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onChange({ ...filters, owner: "any" })}>
            {t("Todos")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onChange({ ...filters, owner: "unassigned" })}>
            {t("Sem responsável")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onChange({ ...filters, owner: user.id })}>
            {t("Eu")}
          </DropdownMenuItem>
          {/*
            Humanos e agentes numa lista SÓ, ordenados juntos por nome. Não existe
            separador entre eles: separador agrupa, e agrupar comunica "as pessoas,
            e depois também os bots" — segregação por posição, que é a mesma ideia
            do badge "AI" colorido que o contrato de UI proíbe. Quem distingue é o
            avatar (disco preenchido = humano, círculo vazado com anel = agente),
            reusando o OwnerBadge do card para os dois não divergirem.
            O separador ACIMA (linha do "Eu") fica: ele divide as opções meta
            (Todos / Sem responsável / Eu) das pessoas, e ali agrupar está certo.
          */}
          {assignees.length > 0 && (
            <>
              <DropdownMenuSeparator />
              {assignees.map((a) => (
                <DropdownMenuItem key={a.key} onClick={() => onChange({ ...filters, owner: a.owner })}>
                  <OwnerBadge
                    ownerKind={a.kind}
                    ownerName={a.name}
                    agentVersion={a.version}
                  />
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            {t("Status")}: {statusLabel}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {STATUS_OPTIONS.map((o) => (
            <DropdownMenuItem
              key={o.value}
              onClick={() => onChange({ ...filters, status: o.value })}
            >
              {t(o.label)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {mostraPerda ? (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                {t("Motivo")}: {motivoLabel}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => onChange({ ...filters, lostReason: undefined })}>
                {t("Todos")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {motivosPerdidos.map((motivo) => (
                <DropdownMenuItem
                  key={motivo}
                  onClick={() => onChange({ ...filters, lostReason: motivo })}
                >
                  {rotuloDoMotivo(motivo)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {categoriasPerdidas.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  {t("Categoria")}: {categoriaLabel}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem
                  onClick={() => onChange({ ...filters, lostCategory: undefined })}
                >
                  {t("Todas")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {categoriasPerdidas.map((categoria) => (
                  <DropdownMenuItem
                    key={categoria}
                    onClick={() => onChange({ ...filters, lostCategory: categoria })}
                  >
                    {categoria}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </>
      ) : null}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={tagOptions.length === 0}>
            {filters.tag ? <PontoDaEtiqueta tag={filters.tag} className="mr-2" /> : null}
            {tagLabel}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => onChange({ ...filters, tag: undefined })}>
            {t("Todas")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {tagOptions.map((tag) => (
            <DropdownMenuItem key={tag} onClick={() => onChange({ ...filters, tag })}>
              <PontoDaEtiqueta tag={tag} className="mr-2" />
              {tag}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <label
        className={cn(
          "flex cursor-pointer select-none items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm",
          filters.overdueOnly && "border-accent bg-accent/10",
        )}
      >
        <input
          type="checkbox"
          checked={!!filters.overdueOnly}
          onChange={(e) => onChange({ ...filters, overdueOnly: e.target.checked })}
        />
        {t("Apenas atrasados")}
      </label>

      {(filters.search ||
        filters.owner ||
        filters.tag ||
        filters.overdueOnly ||
        filters.lostReason ||
        filters.lostCategory ||
        (filters.status && filters.status !== "all")) && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setSearchInput("");
            onChange({ status: "all" });
          }}
        >
          {t("Limpar filtros")}
        </Button>
      )}
    </div>
  );
}
