/**
 * O AVISO DO JEV NA CENTRAL — para a falha que não passa sozinha, e que se
 * fecha sozinho quando o Jev volta a responder.
 *
 * Mora aqui, e não no worker de clima, para servir às duas pilhas pelo cliente
 * admin (o agent-engine já o usa): a tarefa do Jev que vier a avisar avisa pelo
 * MESMO aviso, e uma segunda cópia do dedupe abriria dois. HOJE só o worker do
 * clima abre e fecha: as tarefas do turno (a manipulação, o roteador) deixam a
 * falha que pede ação na "Última falha" do cartão, com o nome da tarefa. Com o
 * clima pausado, um aviso aberto antes da pausa só fecha quando ele religar.
 *
 * ═══ O TÍTULO É A CHAVE ═══
 *
 * `kind='other'` sem referência, e o título fixo como chave — o mesmo desenho de
 * `lib/agent-engine/edge/llm/run-model-call.ts`: kind novo exigiria reconstruir
 * o CHECK de `agent_inbox_items.kind`, e o título fixo faz uma chave recusada
 * virar UM aviso, não um por mensagem do dia. A busca casa o título em TODO
 * idioma visível (trocar o idioma não abre um segundo) e também os títulos
 * ANTIGOS (`TITULOS_ANTIGOS_DO_AVISO_DO_JEV`): sem eles, o aviso aberto numa
 * instalação que atualizou com ele na tela nunca mais se fecharia.
 *
 * Nunca lança: o aviso é o alerta, não a medição.
 */
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMAS, type Idioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";
import type { createAdminClient } from "@/lib/supabase/admin";

import type { MotivoComRede } from "./cliente";
import { AVISO_DO_JEV, avisoDoJevNaCentral, TITULOS_ANTIGOS_DO_AVISO_DO_JEV } from "./textos";

type Admin = ReturnType<typeof createAdminClient>;

/** Todo título que já foi deste aviso, em todo idioma visível. */
export const TITULOS_DO_AVISO_DO_JEV = [
  ...new Set(
    [AVISO_DO_JEV.titulo, ...TITULOS_ANTIGOS_DO_AVISO_DO_JEV].flatMap((titulo) =>
      IDIOMAS.map((i) => traduzir(titulo, i)),
    ),
  ),
];

/**
 * Organizações em que ESTE processo já sabe que não há aviso do Jev aberto.
 * Sem esta memória, cada medição bem-sucedida faria uma escrita na Central.
 *
 * ponytail: memória por processo. O dreno do agent-worker e o do cron são dois
 * processos; quem abriu o aviso é quem o esqueceu daqui, então é ele que o
 * fecha no próximo sucesso. Se um processo reiniciar, a primeira medição
 * confere uma vez.
 */
const semAvisoDoJevAberto = new Set<string>();

/**
 * Abre o aviso, ou ATUALIZA o aberto para o desfecho de agora (motivo, se a
 * reserva mediu, gravidade): sem isso, uma chave recusada coberta pela reserva
 * seguia dizendo "a IA de sempre mede no lugar dele" depois que a reserva
 * também caiu. O texto sai no idioma da organização porque a Central mostra o
 * corpo como veio.
 *
 * ponytail: busca e escrita em duas idas, sem trava. Dois drains medindo a mesma
 * organização no mesmo instante podem abrir dois avisos iguais — a mesma corrida
 * que `abrirItemDeOrcamento` (ai-response-worker) declara. Aviso repetido é
 * ruído; ausente seria o Jev parado sem nada na tela. Fecha de vez só com
 * índice único parcial (org, título) em `kind='other' and status='open'`, que é
 * migration e exige antes deduplicar os avisos abertos de todo clone.
 */
export async function avisarNaCentral(
  admin: Admin,
  a: {
    organizationId: string;
    idioma: Idioma;
    motivo: MotivoComRede;
    temReserva: boolean;
    quedaSustentada?: boolean;
  },
): Promise<void> {
  semAvisoDoJevAberto.delete(a.organizationId);
  const { title, body } = avisoDoJevNaCentral(
    a.motivo,
    a.temReserva,
    (t) => traduzir(t, a.idioma),
    a.quedaSustentada,
  );
  // Sem reserva, o clima parou de vez: ninguém é chamado quando o cliente se irrita.
  const severity = a.temReserva ? "warn" : "critical";
  const { data: abertos, error: erroDaBusca } = await admin
    .from("agent_inbox_items")
    .select("id, title, body, severity")
    .eq("organization_id", a.organizationId)
    .eq("kind", "other")
    .in("title", TITULOS_DO_AVISO_DO_JEV)
    .eq("status", "open")
    .limit(1);
  if (erroDaBusca) {
    logger.warn("busca do aviso do Jev falhou — aviso não aberto", {
      organization_id: a.organizationId,
      error: erroDaBusca.message,
    });
    return;
  }

  const aberto = (abertos ?? [])[0] as { id: string; title: string; body: string; severity: string } | undefined;
  if (aberto && aberto.title === title && aberto.body === body && aberto.severity === severity) return;
  const { error } = aberto
    ? await admin
        .from("agent_inbox_items")
        .update({ title, body, severity })
        .eq("id", aberto.id)
        .eq("organization_id", a.organizationId)
    : await admin.from("agent_inbox_items").insert({
        organization_id: a.organizationId,
        kind: "other",
        severity,
        title,
        body,
      });
  if (error) {
    logger.warn("aviso do Jev na Central não foi gravado", {
      organization_id: a.organizationId,
      error: error.message,
    });
  }
}

/**
 * O Jev voltou a responder: o aviso aberto deixa de ser verdade e se fecha. Sem
 * isto, depois de trocar a chave ou pôr crédito, a Central seguia dizendo que
 * o Jev parou até alguém fechá-la à mão.
 *
 * Só escreve na primeira medição depois de um aviso (ver `semAvisoDoJevAberto`).
 */
export async function fecharAvisoDoJev(admin: Admin, organizationId: string): Promise<void> {
  if (semAvisoDoJevAberto.has(organizationId)) return;
  const { error } = await admin
    .from("agent_inbox_items")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("organization_id", organizationId)
    .eq("kind", "other")
    .in("title", TITULOS_DO_AVISO_DO_JEV)
    .eq("status", "open");
  if (error) {
    logger.warn("aviso do Jev não foi fechado", { organization_id: organizationId, error: error.message });
    return;
  }
  semAvisoDoJevAberto.add(organizationId);
}
