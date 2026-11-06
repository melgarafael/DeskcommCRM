"use client";

/**
 * #4151 — O NEGÓCIO EM PÁGINA INTEIRA.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * O negócio só existia como painel lateral no quadro do funil. O painel é bom
 * para AGIR (é uma coluna à direita, com o quadro ainda visível atrás) e ruim
 * para LER: um resumo de caso longo, com descrição, campos do funil, tarefas e
 * linha do tempo, vive espremido em `sm:max-w-md` e a rolagem de uma seção
 * compete com a da outra.
 *
 * ─── O desenho ─────────────────────────────────────────────────────────────
 *
 * Duas colunas no desktop: DADOS DO NEGÓCIO (revisão do documento + campos,
 * com a descrição em área alta) à esquerda; TAREFAS e LINHA DO TEMPO à
 * direita. Abaixo, o CONTATO e as PROPOSTAS — os dois são consulta e cabem na
 * largura toda.
 *
 * Nada aqui é um segundo editor: são os MESMOS componentes do painel
 * (`LeadFieldsForm`, `TarefasDoNegocio`, `LeadTimeline`, `ContatoDoNegocio`,
 * `PropostasDoNegocio`, `ConversaNoDossie`). A página é outro ARRANJO para
 * eles, e é só isso que ela pode ser — uma cópia divergiria no mês seguinte.
 *
 * ─── O que a página NÃO faz, de propósito ──────────────────────────────────
 *
 * Mover de etapa. No quadro esse caminho é `aoMoverPelaLista` → `moverPara`,
 * com a recusa por campos obrigatórios (#1536), o motivo da perda (#1537) e a
 * trava de `updated_at` — um segundo caminho aqui seria uma segunda cópia
 * dessas regras. A etapa aparece como texto, e quem move continua sendo o
 * quadro. O painel lateral também continua inteiro: em tela estreita ele é o
 * caminho, e esta página não o substitui.
 */
import Link from "next/link";

import { useActiveOrg, useUser } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { useLeadTimeline } from "@/hooks/leads/useLeadTimeline";
import { ROLE_RANK } from "@/lib/auth/types";
import { formatValorDoNegocio, MOEDA_PADRAO } from "@/lib/money";
import { CaretLeft } from "@/lib/ui/icons";
import type { Lead } from "@/lib/types/leads";
import type { CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import { ContatoDoNegocio } from "@/components/kanban/ContatoDoNegocio";
import { ConversaNoDossie } from "@/components/kanban/ConversaNoDossie";
import { LeadFieldsForm } from "@/components/kanban/LeadFieldsForm";
import { LeadTimeline } from "@/components/kanban/LeadTimeline";
import { PropostasDoNegocio } from "@/components/kanban/PropostasDoNegocio";
import { RevisaoDoDocumento } from "@/components/kanban/RevisaoDoDocumento";
import { TarefasDoNegocio } from "@/components/kanban/TarefasDoNegocio";

interface Props {
  lead: Lead;
  pipelineId: string;
  stageName: string;
  fieldDefs: CustomFieldDef[];
  /** O quadro com o filtro de quem abriu o painel: o destino do "Voltar". */
  voltar: string;
}

function formatValor(cents: number | null, currency: string | null): string {
  if (cents === null) return "—";
  return formatValorDoNegocio(cents, currency ?? MOEDA_PADRAO, { semCentavos: true });
}

export function NegocioEmPagina({ lead, pipelineId, stageName, fieldDefs, voltar }: Props) {
  const t = useT();
  const timeline = useLeadTimeline(lead.id, lead.contact_id);

  // As MESMAS réguas do dossiê (`LeadDossier`): proposta é `manager`+, tarefa é
  // `agent`+ com o suporte temporário só lendo. Divergir aqui daria uma tela
  // onde o botão aparece e a rota recusa.
  const user = useUser();
  const activeOrg = useActiveOrg();
  const podeCriarProposta =
    user.is_platform_admin || (activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager) || false;
  const podeEditarTarefas =
    (user.is_platform_admin && !user.support) ||
    (activeOrg ? ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent : false);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 lg:p-6" data-negocio-em-pagina={lead.id}>
      <Link
        href={voltar}
        className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-text-muted underline-offset-2 hover:text-text hover:underline"
      >
        <CaretLeft size={14} aria-hidden />
        {t("Voltar ao quadro")}
      </Link>

      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border pb-3">
        <h1 className="text-xl font-semibold leading-7 text-text">{lead.title}</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="font-medium tabular-nums text-text">
            {formatValor(lead.value_cents, lead.currency)}
          </span>
          <span className="text-text-muted">{stageName}</span>
        </div>
      </header>

      <ConversaNoDossie
        conversa={lead.conversa}
        contactId={lead.contact_id}
        phone={lead.contact_phone}
      />

      {/* O GRID. Em telas estreitas ele empilha (uma coluna), e a ordem de
          leitura continua a mesma do painel: dados → o que falta fazer →
          o que aconteceu. */}
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <section
          data-coluna="negocio"
          aria-labelledby="pagina-do-negocio-dados"
          className="flex min-w-0 flex-col gap-3"
        >
          <h2
            id="pagina-do-negocio-dados"
            className="text-xs font-medium uppercase tracking-wide text-text-muted"
          >
            {t("Dados do negócio")}
          </h2>
          {/* A revisão do documento fica ACIMA do formulário, como no painel: é
              o histórico do que o documento disse, e o formulário é o destino
              do que for confirmado. Sem `aoDecidir`, porque o controle do
              formulário aqui não é compartilhado — a confirmação recarrega a
              fila e o campo chega no próximo salvamento. */}
          <RevisaoDoDocumento leadId={lead.id} podeDecidir={podeEditarTarefas} />
          <LeadFieldsForm
            lead={lead}
            pipelineId={pipelineId}
            fieldDefs={fieldDefs}
            // A ÁREA ALTA da descrição é o motivo de a página existir: no
            // painel ela tem 3 linhas.
            descricaoAlta
          />
          <PropostasDoNegocio leadId={lead.id} pipelineId={pipelineId} podeCriar={podeCriarProposta} />
        </section>

        <section
          data-coluna="acompanhamento"
          aria-labelledby="pagina-do-negocio-acompanhamento"
          className="flex min-w-0 flex-col gap-4"
        >
          <h2
            id="pagina-do-negocio-acompanhamento"
            className="text-xs font-medium uppercase tracking-wide text-text-muted"
          >
            {t("Acompanhamento")}
          </h2>
          <TarefasDoNegocio
            leadId={lead.id}
            contactId={lead.contact_id}
            podeEditar={podeEditarTarefas}
            aberto
          />
          <div
            // Os MESMOS sinais observáveis do painel: "a assinatura morreu" e
            // "nada aconteceu" têm a mesma aparência, que é silêncio.
            data-realtime-status={timeline.realtimeStatus.toLowerCase()}
            data-refetch-divergencias={timeline.seguranca.divergencias}
            className="flex flex-col gap-2"
          >
            <h3 id="pagina-do-negocio-linha-do-tempo" className="text-xs font-medium uppercase tracking-wide text-text-muted">
              {t("Linha do tempo")}
            </h3>
            <LeadTimeline
              itens={timeline.itens}
              chegouAoVivo={timeline.chegouAoVivo}
              isLoading={timeline.isLoading}
              isError={timeline.isError}
            />
          </div>
        </section>
      </div>

      <section
        aria-labelledby="pagina-do-negocio-contato"
        className="flex flex-col gap-2 border-t border-border pt-4"
      >
        <h2
          id="pagina-do-negocio-contato"
          className="text-xs font-medium uppercase tracking-wide text-text-muted"
        >
          {t("Contato")}
        </h2>
        <ContatoDoNegocio contactId={lead.contact_id} pipelineId={pipelineId} leadId={lead.id} />
      </section>
    </div>
  );
}
