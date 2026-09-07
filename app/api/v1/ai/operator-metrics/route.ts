/**
 * GET /api/v1/ai/operator-metrics — o papel que organiza o sistema, medido.
 *
 * ═══ AS TRÊS MEDIDAS QUE A SPEC 16 §7 PROMETEU ═══
 *
 * A spec escreveu: *"Métricas que passam a existir: taxa de ação por turno,
 * promessas declaradas vs quitadas, turnos em que o Operador quis agir e não
 * pôde. Se ele parar de agir, alguém vê."* Nenhuma das três existia — o desfecho
 * do papel morria num `log.info` de contêiner, e sem uma linha por execução não
 * havia denominador para calcular nada.
 *
 * Agora existe: `event_log` recebe `agent.operator_turn` a cada execução, e o
 * payload foi escolhido para que cada medida seja uma CONTAGEM, não uma varredura
 * de linhas — por isso `promessa_assumida_por` e `promessa_sem_dono_porque` são
 * escalares no payload em vez de derivados de um array.
 *
 * ═══ "QUITADAS" VIROU "ASSUMIDAS", E A TROCA É DELIBERADA ═══
 *
 * O sistema não sabe se a promessa foi CUMPRIDA — agendar um retorno não é
 * cumprir, e mandar mensagem depois também não. Ele sabe se alguém ficou
 * responsável. Medir "quitadas" seria publicar um número que nenhuma linha apura,
 * que é o mesmo defeito do aviso que dizia "ninguém cumpriu ainda".
 *
 * ═══ CLIENT DE SESSÃO ═══
 *
 * `event_log` tem isolamento por organização, e a RLS faz a tenancy. O filtro
 * explícito por `organization_id` continua no SQL porque um usuário pode
 * pertencer a mais de uma organização — a RLS deixaria passar as duas.
 */
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

/** Janela fixa. Um seletor de período aqui seria configuração antes de haver uso. */
const DIAS = 30;

export async function GET(): Promise<Response> {
  const authz = await requireRole("manager", { resource: "ai_operator_metrics" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;

  const db = await createClient();
  const desde = new Date(Date.now() - DIAS * 24 * 60 * 60 * 1000).toISOString();

  /** Uma contagem, sem trazer linha nenhuma (`head: true`). */
  async function contar(
    aplicar: (q: ReturnType<typeof base>) => ReturnType<typeof base>,
  ): Promise<number> {
    const { count, error } = await aplicar(base());
    if (error) throw new Error(error.message);
    return count ?? 0;
  }
  function base() {
    return db
      .from("event_log")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org!.orgId)
      .eq("event_type", "agent.operator_turn")
      .gte("created_at", desde);
  }

  try {
    const [turnos, agiu, comPromessa, assumidas, semDono, semFerramenta] = await Promise.all([
      contar((q) => q),
      // Pelo menos uma ferramenta chamada. O primeiro elemento existir é o teste
      // mais barato de "array não vazio" que o PostgREST oferece.
      contar((q) => q.not("payload->ferramentas_chamadas->>0", "is", null)),
      contar((q) => q.not("payload->>promessas_declaradas", "eq", "0")),
      contar((q) => q.not("payload->>promessa_assumida_por", "is", null)),
      contar((q) => q.not("payload->>promessa_sem_dono_porque", "is", null)),
      contar((q) => q.eq("payload->>promessa_sem_dono_porque", "operador_sem_ferramentas")),
    ]);

    return ok({
      dias: DIAS,
      turnos,
      agiu,
      promessas: { declaradas: comPromessa, assumidas, semDono },
      // "Quis agir e não pôde": o papel rodou, havia promessa, e ele não tinha
      // nenhuma capacidade marcada. A ação que cabe ao dono é na tela, não no
      // cliente — por isso este número é separado do "não agiu".
      quisAgirENaoPode: semFerramenta,
    });
  } catch (err) {
    return fail("read_failed", err instanceof Error ? err.message : t("falha ao ler"), 500);
  }
}
