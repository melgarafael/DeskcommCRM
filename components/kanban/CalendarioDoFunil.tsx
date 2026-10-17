"use client";
import { useMemo, useState } from "react";

import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { camposDeDataDoNegocio, camposDoFunil, camposPorEscopo } from "@/lib/leads/campos-do-funil";
import {
  chaveDoDia,
  diasDaSemana,
  gradeDoMes,
  negociosPorDia,
} from "@/lib/kanban/calendario-do-funil";
import type { Pipeline, Stage } from "@/lib/kanban/types";
import type { Lead } from "@/lib/types/leads";
import { CaretLeft, CaretRight } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { LeadDossier } from "./LeadDossier";

/**
 * Valor sentinela do "sem segundo campo".
 *
 * `SelectItem` com `value=""` não existe (o Radix recusa): a ausência precisa
 * de um código próprio, que nunca é a chave de um campo real — `customFieldSchema`
 * exige chave começando por letra, e este valor começa por hífen.
 */
const SEM_INTERVALO = "-sem-intervalo";

/** Chips por dia na grade. Passando disso, o excedente vira "+N mais". */
const PORDIA_VISIVEIS = 3;

interface Props {
  pipelineId: string;
  /** O funil inteiro — é de `settings.fields` que saem os campos de data. */
  pipeline: Pipeline;
  stages: Stage[];
  /** Os negócios já filtrados pela barra da página, mesma entrada do quadro. */
  leads: Lead[];
}

/**
 * A visão Calendário do funil (#2770) — a terceira aba, ao lado do quadro.
 *
 * ─── O que ela responde ────────────────────────────────────────────────────
 *
 * "Quem embarca esta semana, quem retorna amanhã, quais eventos caem no mês".
 * As datas moram em campos personalizados do funil (`data_inicio`, `data_fim`,
 * data do evento), então a primeira escolha da tela é QUAL campo olha — e,
 * opcionalmente, um segundo campo para exibir como intervalo (ida e retorno
 * numa mesma célula).
 *
 * ─── O que ficou FORA, de propósito ────────────────────────────────────────
 *
 * Filtro por responsável, etapa e etiqueta, e assinatura ICS: o corpo da issue
 * marca o ICS como opcional e o escopo desta entrega fecha só na visão. O que
 * a barra de filtros da página já faz continua valendo — ela alimenta esta tela
 * com a MESMA lista filtrada que alimenta o quadro, para as duas abas não
 * discordarem sobre quem está no funil.
 *
 * ─── Clicar abre a ficha ───────────────────────────────────────────────────
 *
 * O mesmo `LeadDossier` do quadro, com o mesmo `fieldDefs` e o mesmo nome de
 * etapa: o calendário é outro ÂNGULO do mesmo funil, não outro produto. Ele
 * não redesenha a ficha — quem já sabe abrir um negócio no quadro não aprende
 * nada novo aqui.
 */
/**
 * `funil` no lugar do apelido antigo no corpo, e não por gosto do idioma.
 *
 * O guarda de vocabulário (tests/unit/vocabulario-do-funil.test.ts) varre todo
 * arquivo .tsx procurando a palavra do sistema em texto de tela: a que o
 * construtor do produto fala não é a que quem vende fala — o operador lê
 * "funil". A régua é um regex cru sobre o fonte, então o corpo de um memo que
 * cita a settings do funil pelo apelido antigo já entra como se fosse copy de
 * tela e reprova sem ser defeito. Renomear o apelido local fecha o falso
 * positivo e não esconde nada de quem lê o código.
 */
export function CalendarioDoFunil({ pipelineId, pipeline: funil, stages, leads }: Props) {
  const t = useT();
  const tag = useTagDeIdioma();
  const { data: members } = useAssignableMembers(true);
  const ownerNames = useMemo(
    () => new Map((members ?? []).map((m) => [m.user_id, m.full_name])),
    [members],
  );

  const campos = useMemo(
    () => camposDeDataDoNegocio(funil.settings),
    [funil.settings],
  );

  const [visao, setVisao] = useState<"mes" | "semana">("mes");
  const [ancora, setAncora] = useState(() => new Date());
  const [campoEscolhido, setCampoEscolhido] = useState<string | null>(null);
  const [campoFinalEscolhido, setCampoFinalEscolhido] = useState<string | null>(null);
  const [dossieId, setDossieId] = useState<string | null>(null);

  /**
   * Derivado, não sincronizado por efeito: o campo escolhido só vale se AINDA
   * existe no funil (renomearam, apagaram, outro funil na URL). Sem isto o
   * seletor apontaria para uma chave que ninguém tem e a grade ficaria vazia
   * sem dizer por quê — o padrão, aqui, é o primeiro campo de data do funil.
   */
  const campo =
    campoEscolhido && campos.some((c) => c.key === campoEscolhido)
      ? campoEscolhido
      : (campos[0]?.key ?? null);
  const campoFinal =
    campoFinalEscolhido &&
    campoFinalEscolhido !== SEM_INTERVALO &&
    campoFinalEscolhido !== campo &&
    campos.some((c) => c.key === campoFinalEscolhido)
      ? campoFinalEscolhido
      : null;

  const porDia = useMemo(
    () => (campo ? negociosPorDia(leads, campo, campoFinal) : new Map<string, Lead[]>()),
    [leads, campo, campoFinal],
  );

  // O tipo declarado é `(Date | null)[]` NOS DOIS ramos: a grade do mês tem
  // buracos e a da semana não, e o consumidor logo abaixo lê os dois com a
  // mesma régua — tipar pela união dos dois arrays faria `some`/`map` virarem
  // chamada de união incompatível no typecheck.
  const dias: (Date | null)[] = useMemo(
    () =>
      visao === "mes"
        ? gradeDoMes(ancora.getFullYear(), ancora.getMonth())
        : diasDaSemana(ancora),
    [visao, ancora],
  );

  const hoje = chaveDoDia(new Date());
  const noPeriodo = dias.some(
    (dia) => dia !== null && (porDia.get(chaveDoDia(dia))?.length ?? 0) > 0,
  );

  const leadDoDossie = dossieId ? (leads.find((l) => l.id === dossieId) ?? null) : null;

  const rotuloDoPeriodo =
    visao === "mes"
      ? new Intl.DateTimeFormat(tag, { month: "long", year: "numeric" }).format(
          new Date(ancora.getFullYear(), ancora.getMonth(), 1),
        )
      : `${new Intl.DateTimeFormat(tag, { day: "numeric", month: "short", year: "numeric" }).format(
          dias[0]!,
        )} – ${new Intl.DateTimeFormat(tag, { day: "numeric", month: "short" }).format(
          dias[dias.length - 1]!,
        )}`;

  function mover(delta: number) {
    setAncora((atual) =>
      visao === "mes"
        ? new Date(atual.getFullYear(), atual.getMonth() + delta, 1)
        : new Date(atual.getFullYear(), atual.getMonth(), atual.getDate() + 7 * delta),
    );
  }

  if (campos.length === 0) {
    // Sem campo de data cadastrado não há o que calendariar. Dizer isto é mais
    // honesto que uma grade vazia, que pareceria "seu funil não tem negócio".
    return (
      <div className="flex flex-1 items-center justify-center rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
        {t("Este funil não tem campo de data para montar o calendário.")}
      </div>
    );
  }

  const cabecalho = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(tag, { weekday: "short" }).format(new Date(2026, 2, 1 + i)),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="calendario-do-funil">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label={visao === "mes" ? t("Mês anterior") : t("Semana anterior")}
            data-testid="calendario-anterior"
            onClick={() => mover(-1)}
          >
            <CaretLeft size={16} aria-hidden />
          </Button>
          <h2 className="min-w-0 truncate text-base font-semibold capitalize">
            {rotuloDoPeriodo}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label={visao === "mes" ? t("Próximo mês") : t("Próxima semana")}
            data-testid="calendario-proximo"
            onClick={() => mover(1)}
          >
            <CaretRight size={16} aria-hidden />
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={campo ?? undefined} onValueChange={setCampoEscolhido}>
            <SelectTrigger
              aria-label={t("Campo de data")}
              data-testid="calendario-campo"
              className="h-9 w-auto text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {campos.map((c) => (
                <SelectItem key={c.key} value={c.key}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={campoFinal ?? SEM_INTERVALO}
            onValueChange={(valor) =>
              setCampoFinalEscolhido(valor === SEM_INTERVALO ? null : valor)
            }
          >
            <SelectTrigger
              aria-label={t("Campo de data final")}
              data-testid="calendario-campo-final"
              className="h-9 w-auto text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SEM_INTERVALO}>{t("Sem intervalo")}</SelectItem>
              {campos
                .filter((c) => c.key !== campo)
                .map((c) => (
                  <SelectItem key={c.key} value={c.key}>
                    {c.label}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>

          <div className="flex items-center gap-0.5 rounded-md border bg-muted p-0.5">
            <button
              type="button"
              data-testid="calendario-mes"
              aria-pressed={visao === "mes"}
              onClick={() => setVisao("mes")}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                visao === "mes"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t("Mês")}
            </button>
            <button
              type="button"
              data-testid="calendario-semana"
              aria-pressed={visao === "semana"}
              onClick={() => setVisao("semana")}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                visao === "semana"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t("Semana")}
            </button>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="grid grid-cols-7 border-b bg-muted/40">
          {cabecalho.map((rotulo, i) => (
            <div
              key={`${rotulo}-${i}`}
              className="py-2 text-center text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
            >
              {rotulo}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 divide-x divide-y">
          {dias.map((dia, i) => {
            if (!dia) {
              return (
                <div key={`vazio-${i}`} className="min-h-[104px] bg-muted/15" aria-hidden />
              );
            }

            const chave = chaveDoDia(dia);
            const doDia = porDia.get(chave) ?? [];
            const excedente = doDia.length - PORDIA_VISIVEIS;

            return (
              <div
                key={chave}
                data-testid={`calendario-dia-${chave}`}
                className={cn(
                  "flex min-h-[104px] flex-col gap-1 p-1.5",
                  chave === hoje && "bg-primary/5",
                )}
              >
                <span
                  className={cn(
                    "flex h-6 w-6 items-center justify-center self-start rounded-full text-xs font-semibold",
                    chave === hoje
                      ? "bg-primary font-bold text-primary-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {dia.getDate()}
                </span>

                {doDia.slice(0, PORDIA_VISIVEIS).map((lead) => (
                  <button
                    key={lead.id}
                    type="button"
                    data-testid={`calendario-negocio-${lead.id}`}
                    title={lead.title}
                    onClick={() => setDossieId(lead.id)}
                    className="w-full truncate rounded-md bg-primary/10 px-1.5 py-0.5 text-left text-[10px] font-medium text-primary transition-colors hover:bg-primary/20"
                  >
                    {lead.title}
                  </button>
                ))}

                {excedente > 0 ? (
                  <span className="pl-1 text-[10px] font-semibold text-muted-foreground">
                    +{excedente} {t("mais")}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {leads.length > 0 && !noPeriodo && (
        <p className="text-sm text-muted-foreground">
          {porDia.size === 0
            ? t("Nenhum negócio com este campo de data.")
            : t("Nenhum negócio com este campo de data neste período.")}
        </p>
      )}

      {leadDoDossie && (
        <LeadDossier
          open
          onOpenChange={(aberto) => {
            if (!aberto) setDossieId(null);
          }}
          lead={leadDoDossie}
          pipelineId={pipelineId}
          fieldDefs={camposPorEscopo(camposDoFunil(funil.settings), "negocio")}
          stageName={stages.find((s) => s.id === leadDoDossie.stage_id)?.name ?? "—"}
          ownerNames={ownerNames}
        />
      )}
    </div>
  );
}
