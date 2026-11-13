/**
 * A porta da CAPTURA DO ROTEIRO para a revisão por quilometragem (issue #4376).
 *
 * O passo 1 da régua de mercado é uma pergunta do fluxo ("quantos km o carro
 * está?"), e a resposta cai em `crm_leads.custom_fields` pelo `destino:
 * 'negocio'` (#3363). É esse o momento em que o CRM tem km e data de retirada
 * na mesma linha — e é aqui que a projeção precisa nascer, senão a conta fica
 * para a memória de alguém.
 *
 * ═══ POR QUE ESTE ARQUIVO FALA SQL DIRETO ═══
 *
 * O roteiro inteiro (`lib/followup/atendimento.ts`) usa `pg` — é o caminho
 * migrado do PostgREST. Trazer um cliente `supabase-js` para cá só para gravar
 * uma data misturaria dois clientes no mesmo fluxo. As duas consultas são:
 *
 *   1. uma leitura só (negócio + funil + fuso da organização), porque a conta
 *      precisa dos três e três idas ao banco não pagam nada;
 *   2. a escrita pela função que JÁ EXISTE (`fn_lead_anotar_campos`, migration
 *      0502) — a mesma da ação `set_lead_date_field` (#3727) e do PATCH do
 *      card. Nada de `update ... || jsonb_build_object` paralelo: a trava de
 *      linha e a auditoria moram naquela função.
 */
import { diaLocal, fusoDaOrganizacao } from "@/lib/automation/cron-de-data";
import { armarProximaRevisao, type ResultadoDaArmacao } from "@/lib/revisao-por-km/decisao";
import { configuracaoDeRevisaoPorKm } from "@/lib/revisao-por-km/conta";
import { revisaoPorKmLigadaComMemo } from "@/lib/revisao-por-km/modulo";

/** O mínimo que a revisão precisa do pool — o teste injeta um dublê. */
export interface BancoDaRevisao {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

interface LinhaDoNegocio {
  campos: unknown;
  settings: unknown;
  fuso: string | null;
}

function objeto(valor: unknown): Record<string, unknown> | null {
  return valor !== null && typeof valor === "object" && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : null;
}

/**
 * Depois de a resposta do roteiro ser gravada no card: se o campo gravado é o
 * km da configuração do funil, projeta e grava a data prevista.
 *
 * `campoGravado` é a chave que a pergunta acabou de escrever. Serve de filtro
 * barato: pergunta de cidade não recalcula revisão de quem já teve o aviso
 * armado — o que rearmaria o gatilho sem quilometragem nova.
 */
export async function armarProximaRevisaoPeloFluxo(
  db: BancoDaRevisao,
  args: { organizationId: string; leadId: string; campoGravado?: string },
): Promise<ResultadoDaArmacao> {
  // ── O PORTÃO (adaptação do #4536 para módulo opcional) ─────────────────────
  //
  // ANTES da leitura do negócio: sem isto, toda resposta de roteiro de toda
  // instalação pagaria a consulta abaixo para um módulo que ninguém ligou. Este é
  // o caminho quente (o turno do agente), por isso a chave vem com memo de
  // processo. Desligado, o caminho do WhatsApp não toca no pool `pg` a mais.
  if (!(await revisaoPorKmLigadaComMemo())) {
    return { status: "nenhuma_escrita", motivo: "modulo_desligado" };
  }

  const { rows } = await db.query(
    `select l.custom_fields as campos, p.settings as settings, o.timezone as fuso
       from crm_leads l
       join crm_pipelines p
         on p.id = l.pipeline_id and p.organization_id = l.organization_id
       join organizations o on o.id = l.organization_id
      where l.organization_id = $1 and l.id = $2 and l.status = 'open'`,
    [args.organizationId, args.leadId],
  );
  const linha = rows[0] as LinhaDoNegocio | undefined;
  if (!linha) return { status: "nenhuma_escrita", motivo: "sem_km" };

  const settings = objeto(linha.settings);
  const campos = objeto(linha.campos) ?? {};

  const leitura = configuracaoDeRevisaoPorKm(settings);
  if (!leitura.ok) {
    return leitura.motivo === "ausente"
      ? { status: "nenhuma_escrita", motivo: "sem_configuracao" }
      : { status: "nenhuma_escrita", motivo: "configuracao_invalida", detalhe: leitura.motivo };
  }
  const config = leitura.config;

  const chavesDeLeitura = [
    config.campo_km,
    config.campo_km_da_ultima_revisao ?? "",
    config.campo_da_ultima_revisao ?? "",
  ].filter((chave) => chave !== "");
  if (args.campoGravado !== undefined && !chavesDeLeitura.includes(args.campoGravado)) {
    return { status: "nenhuma_escrita", motivo: "sem_km", detalhe: args.campoGravado };
  }

  return armarProximaRevisao(
    { settings, campos, hoje: diaLocal(new Date(), fusoDaOrganizacao(linha.fuso)) },
    async (camposParaGravar) => {
      const escrita = await db.query(
        `select fn_lead_anotar_campos($1::uuid, $2::uuid, $3::jsonb) as campos`,
        [args.organizationId, args.leadId, JSON.stringify(camposParaGravar)],
      );
      const gravado = (escrita.rows[0] as { campos?: unknown } | undefined)?.campos;
      return gravado !== null && gravado !== undefined;
    },
  );
}
