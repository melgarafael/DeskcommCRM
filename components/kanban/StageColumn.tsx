"use client";
import { Droppable } from "@hello-pangea/dnd";
import { useRef, useState, type CSSProperties } from "react";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";
import type { Lead } from "@/lib/types/leads";
import type { Stage } from "@/lib/kanban/types";
import { buildCardInput } from "@/lib/kanban/card-state";
import { intervaloDaColuna } from "@/lib/kanban/selecao";
import { formatSomaPorMoeda, formatValorDoNegocio, MOEDA_PADRAO, somaPorMoeda } from "@/lib/money";
import { KanbanCard, type GestoDeSelecao } from "./KanbanCard";

interface StageColumnProps {
  stage: Stage;
  leads: Lead[];
  pipelineId: string;
  /** owner_user_id → nome, resolvido no board. O dono agente vem no lead. */
  ownerNames?: Map<string, string | null>;
  /** ids que o radar classificou como esfriando (fonte única, não recalculada). */
  coolingIds?: Set<string>;
  /** Propostas de retomada vivas, por lead. */
  reactivations?: Map<string, { proposalId: string; expiresAt: string }>;
  /** `settings.canonical_tags` do pipeline — a única tag que fica no card. */
  canonicalTags?: string[];
  selectedLeadIds?: Set<string>;
  /** leadId → quantos eventos remotos já chegaram (muda = pulsa de novo). */
  pulses?: Map<string, number>;
  /**
   * Marca/desmarca um conjunto de uma vez — a etapa inteira, ou o intervalo do
   * shift+clique. Existe separado de `onSelect` porque a coluna é a única que
   * sabe a ordem VISÍVEL dos cards (é ela que recebe a lista já filtrada), e
   * resolver o intervalo no board significaria reconstruir essa ordem lá.
   */
  onSelectMany?: (leadIds: string[], marcar: boolean) => void;
  /** Abrir o dossiê — atravessa o board até o card, como `pulses`. */
  onOpen?: (leadId: string) => void;
  /** `manager`+ — mesmo corte de papel da rota que renomeia a etapa. */
  podeRenomear?: boolean;
  onRenomear?: (nome: string) => void;
}

export function StageColumn({
  stage,
  leads,
  pipelineId,
  ownerNames,
  coolingIds,
  reactivations,
  canonicalTags,
  selectedLeadIds,
  pulses,
  onSelectMany,
  onOpen,
  podeRenomear = false,
  onRenomear,
}: StageColumnProps) {
  const t = useT();
  // O TOTAL É POR MOEDA (#1531). Antes ele somava todos os `value_cents` e
  // escrevia o resultado na moeda do primeiro negócio: R$ 5.000 e 5.000 € saíam
  // "R$ 10.000,00", um valor que não existe. Agora cada moeda tem o seu total,
  // lado a lado e sem conversão ("R$ 5.000,00 + 5000,00 €"). Com uma moeda só o
  // texto é exatamente o de antes — é o caso comum, e nele nada muda. (Antes
  // disso, o total saía SEMPRE em R$ por um `formatBRL` local com a moeda em
  // duro; `formatValorDoNegocio` é a fonte única e a régua ×100 do negócio.)
  //
  // `currency` NULL conta como `MOEDA_PADRAO`, porque é o que o card mostra
  // (`KanbanCard`): o total não pode discordar do card que está logo abaixo.
  const moedaDoLead = (l: Lead) => l.currency ?? MOEDA_PADRAO;
  const totais = somaPorMoeda(leads, (l) => l.value_cents, moedaDoLead);
  // A ordem: primeiro a moeda com MAIS NEGÓCIOS COM VALOR na coluna (empate em
  // ordem alfabética), depois as demais em ordem alfabética. Conta negócios, não
  // soma valores — "mais valor" compararia centavos de moedas diferentes, o
  // mesmo erro que esta regra acaba. E não depende da posição dos cards: mover
  // um card na coluna não embaralha o cabeçalho.
  //
  // ponytail: o ideal é a moeda da ORGANIZAÇÃO primeiro, mas ela não chega ao
  // quadro (`ActiveOrg` traz o fuso e não a moeda). Como o negócio nasce na
  // moeda da organização (API e conversa), a mais frequente é, na prática, ela;
  // numa organização anterior a isso, os negócios antigos em BRL podem ganhar.
  // Upgrade: `currency` no embed `organizations(...)` de `lib/auth/server.ts`,
  // em `ActiveOrg`, e daí page → `PipelinePageClient` → `KanbanBoard` → uma prop
  // aqui que substitui `primeira`.
  const primeira = [
    ...somaPorMoeda(leads, (l) => (l.value_cents == null ? null : 1), moedaDoLead),
  ].sort(([ma, na], [mb, nb]) => nb - na || ma.localeCompare(mb))[0]?.[0];
  // A faixa aparece quando alguma moeda soma mais de zero — o `total > 0` de
  // antes, por moeda. Coluna sem valor nenhum não mostra "R$ 0,00".
  const temTotal = [...totais.values()].some((cents) => cents > 0);

  // A linha "ponderado" (issue #1535): o que ESTA coluna representa quando a
  // etapa tem chance calibrada. Ganho e perda valem 100 e 0 NA REGRA
  // (`lib/leads/previsao.ts`), não na coluna. `null` = etapa sem calibração, e
  // aí a linha não aparece: exibir "R$ 0,00" seria um número que ninguém
  // calibrou lendo como uma promessa de zero.
  //
  // Também por moeda, com a mesma função de moeda e a mesma `primeira` do total:
  // mesmas moedas, na mesma ordem. Arredonda por negócio, como antes.
  const probDaColuna = stage.is_won ? 100 : stage.is_lost ? 0 : (stage.win_probability ?? null);
  const ponderados =
    probDaColuna === null
      ? null
      : somaPorMoeda(
          leads,
          (l) => (l.value_cents == null ? null : Math.round((l.value_cents * probDaColuna) / 100)),
          moedaDoLead,
        );

  const idsVisiveis = leads.map((l) => l.id);
  const selecionadosAqui = idsVisiveis.filter((id) => selectedLeadIds?.has(id)).length;
  const todosSelecionados = idsVisiveis.length > 0 && selecionadosAqui === idsVisiveis.length;

  // A âncora do shift+clique. `useRef` e não `useState` de propósito: mudar a
  // âncora não muda nada na tela, e um `setState` aqui remontaria a coluna
  // inteira — inclusive o `Droppable` — a cada card marcado.
  const ancora = useRef<string | null>(null);

  const aoSelecionar = (leadId: string, gesto: GestoDeSelecao) => {
    if (gesto === "intervalo") {
      const faixa = intervaloDaColuna(idsVisiveis, ancora.current, leadId);
      ancora.current = leadId;
      onSelectMany?.(faixa, true);
      return;
    }
    ancora.current = leadId;
    onSelectMany?.([leadId], !selectedLeadIds?.has(leadId));
  };

  const alternarEtapa = () => {
    ancora.current = null;
    onSelectMany?.(idsVisiveis, !todosSelecionados);
  };
  const accentStyle: CSSProperties | undefined = stage.color
    ? { backgroundColor: stage.color }
    : undefined;

  return (
    <div
      /*
        `w-[85vw] max-w-80 snap-center md:w-80` — a coluna cabe na tela do
        celular, e uma por vez.

        Com `w-80` fixo (320px) numa tela de 360px a coluna ocupava 89% da
        largura útil e a de ao lado aparecia como uma fatia de poucos pixels: um
        quadro que parece CORTADO em vez de rolável, sem pista de que há mais
        etapa adiante. 85vw deixa uma sobra, que é onde a coluna seguinte se
        anuncia — e `snap-center` faz a rolagem parar nela em vez de deixar o
        dedo no meio de duas.

        `max-w-80` segura o crescimento no tablet: 85% de 1023px seriam 870px, e
        coluna de etapa não vira painel. De `md` para cima volta o `w-80` de
        sempre, onde a graça é justamente ver várias etapas ao mesmo tempo.
      */
      className="bg-surface-muted/40 flex min-h-full w-[85vw] max-w-80 shrink-0 snap-center flex-col rounded-lg border border-border md:w-80"
      data-etapa-do-quadro={stage.id}
    >
      {/* Cabeçalho e total PRESOS no alto do quadro enquanto os cards rolam: com
          uma etapa comprida, é o que diz em que etapa se está olhando. O fundo
          opaco (`bg-background`) é o que impede os cards de aparecerem por baixo;
          por dentro, a mesma camada translúcida da coluna, para o tom não mudar. */}
      <div className="sticky top-0 z-10 rounded-t-lg bg-background" data-cabecalho-da-etapa>
        <div className="bg-surface-muted/40 rounded-t-lg">
          <div className="group/etapa flex items-center gap-2 border-b border-border px-3 py-2.5">
            {/* "Selecionar a etapa inteira" é o gesto que faz a ação em lote valer a
            pena: sem ele, mover trinta cards deixa de ser trinta arrastes e vira
            trinta cliques com modificador. Fica no cabeçalho porque é ali que a
            etapa é um objeto — o mesmo lugar onde já se lê a contagem dela.
            Indeterminado quando a seleção é parcial: "alguns" e "nenhum" não
            podem ter a mesma aparência num controle que o próximo clique
            inverte. */}
            <input
              type="checkbox"
              checked={todosSelecionados}
              ref={(el) => {
                if (el) el.indeterminate = selecionadosAqui > 0 && !todosSelecionados;
              }}
              disabled={idsVisiveis.length === 0}
              onChange={alternarEtapa}
              aria-label={
                todosSelecionados
                  ? `${t("Desmarcar todos em")} ${stage.name}`
                  : `${t("Selecionar todos em")} ${stage.name}`
              }
              className={cn(
                "h-4 w-4 shrink-0 cursor-pointer accent-accent transition-opacity",
                "focus:opacity-100 disabled:cursor-default",
                // `pointer-coarse:opacity-100` pelo mesmo motivo da caixa do
                // card (ver `components/kanban/KanbanCard.tsx`): no toque o
                // hover nunca acontece, e "selecionar a etapa inteira" é o gesto
                // que faz a ação em lote valer a pena. Sem ele, mover trinta
                // cards no celular eram trinta arrastes.
                selecionadosAqui > 0
                  ? "opacity-100"
                  : "opacity-0 group-hover/etapa:opacity-100 pointer-coarse:opacity-100",
              )}
            />
            <span
              className={cn("h-2 w-2 rounded-full", !stage.color && "bg-text-muted/40")}
              style={accentStyle}
              aria-hidden
            />
            {podeRenomear && onRenomear ? (
              // `key` pelo nome: remonta (e descarta o rascunho) quando o nome
              // GRAVADO muda — mesmo contrato de `NomeDaEtapa` em Configurações,
              // para uma edição feita em outra aba não ficar escondida atrás de
              // um rascunho velho aqui.
              // Dentro do <h2>: a coluna segue sendo título para quem navega
              // por leitor de tela, com ou sem permissão de renomear.
              <h2 className="flex min-w-0 flex-1">
                <NomeDaEtapaNoQuadro key={stage.name} nome={stage.name} onConfirmar={onRenomear} />
              </h2>
            ) : (
              <h2 className="flex-1 truncate text-sm font-semibold text-text">{stage.name}</h2>
            )}
            <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-medium text-text-muted tabular-nums">
              {selecionadosAqui > 0 ? `${selecionadosAqui}/${leads.length}` : leads.length}
            </span>
          </div>

          {temTotal && (
            <div className="border-b border-border px-3 py-1.5 text-[11px] text-text-muted tabular-nums">
              {formatSomaPorMoeda(totais, formatValorDoNegocio, { primeira })}
              {ponderados !== null && (
                <span className="ml-2">
                  · {t("ponderado")}{" "}
                  {formatSomaPorMoeda(ponderados, formatValorDoNegocio, { primeira })}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <Droppable droppableId={stage.id} type="LEAD">
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={cn(
              "flex flex-1 flex-col gap-2 p-2 transition-colors",
              snapshot.isDraggingOver && "bg-accent/5",
            )}
          >
            {leads.map((lead, idx) => (
              <KanbanCard
                key={lead.id}
                card={buildCardInput(lead, {
                  stageName: stage.name,
                  ownerNames,
                  coolingIds,
                  reactivations,
                  canonicalTags,
                })}
                lead={lead}
                index={idx}
                pipelineId={pipelineId}
                isSelected={selectedLeadIds?.has(lead.id)}
                isSelecting={(selectedLeadIds?.size ?? 0) > 0}
                pulseCount={pulses?.get(lead.id) ?? 0}
                onSelect={aoSelecionar}
                onOpen={onOpen}
              />
            ))}
            {provided.placeholder}
            {leads.length === 0 && !snapshot.isDraggingOver && (
              <div className="flex h-20 items-center justify-center text-[11px] text-text-muted">
                {t("vazio")}
              </div>
            )}
          </div>
        )}
      </Droppable>
    </div>
  );
}

/**
 * O nome da etapa, editado no lugar — direto no cabeçalho da coluna.
 *
 * Mesmo contrato de `NomeDaEtapa` (Configurações › Funis, que chama a MESMA
 * rota `PATCH /api/v1/pipelines/:id/stages/:stageId`): salva ao CONFIRMAR
 * (Enter ou sair do campo), nunca a cada tecla — um PATCH por caractere
 * dispararia a validação de nome duplicado no meio da digitação. O rascunho é
 * local; o `key={stage.name}` de quem chama remonta o campo quando o nome
 * GRAVADO muda, então uma edição feita em outra aba não fica escondida atrás
 * de um rascunho velho.
 */
function NomeDaEtapaNoQuadro({
  nome,
  onConfirmar,
}: {
  nome: string;
  onConfirmar: (nome: string) => void;
}) {
  const t = useT();
  const [rascunho, setRascunho] = useState(nome);
  // O Escape desfoca, e o desfoque chama `confirmar` na MESMA tecla: o
  // `rascunho` que ele lê ainda é o texto digitado, e sem esta marca o Escape
  // salvava o que devia desfazer (medido em renomear-etapa-no-quadro.test.tsx).
  const cancelado = useRef(false);

  function confirmar() {
    const limpo = rascunho.trim();
    if (cancelado.current || !limpo || limpo === nome) {
      cancelado.current = false;
      setRascunho(nome);
      return;
    }
    onConfirmar(limpo);
  }

  return (
    <input
      value={rascunho}
      maxLength={80}
      aria-label={`${t("Nome da etapa")} «${nome}»`}
      data-testid="nome-etapa-quadro"
      onChange={(e) => setRascunho(e.target.value)}
      onBlur={confirmar}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          cancelado.current = true;
          e.currentTarget.blur();
        }
      }}
      className="min-w-0 flex-1 truncate rounded-sm bg-transparent px-1 py-0.5 text-sm font-semibold text-text outline-hidden hover:bg-surface focus:bg-surface"
    />
  );
}
