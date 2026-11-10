/**
 * Semente do módulo "Chamadas" (CRM › Ver tudo em CRM › Chamadas, /app/calls):
 * o histórico de ligações por telefone da Clínica Bem Viver — duas conversas
 * que a IA de voz conduziu até o fim (uma recebida, uma feita por ela), uma
 * ligação perdida e uma que deu ocupado.
 *
 * A bancada não tem servidor de telefone nem linha contratada, e não precisa:
 * a tela só LÊ `voice_calls` (provider 'sip'). Nenhuma ligação é feita — as
 * lições abrem a janela "Nova ligação" e param antes de "Ligar com IA".
 *
 * O status grava o vocabulário do banco (`ended` + `end_reason`), que a rota
 * traduz para o da tela (mapStatusParaApi em app/api/v1/calls/route.ts).
 * Sem `owner_user_id`: as métricas de atendente (Desempenho) contam por ele, e
 * esta semente não deve mudar a foto de outro módulo.
 */
import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";
import { type Contexto, ha, semErro } from "../semear-demonstracao";

const chamadaId = (n: number) => `f1b00001-0000-4000-8000-${String(n).padStart(12, "0")}`;
const IDS = [1, 2, 3, 4].map(chamadaId);

type Fala = ["agent" | "customer", string];

/** Linha de ligação já encerrada, `minutos` atrás, durando `segundos` (null = não atendida). */
function ligacao(
  c: Contexto,
  n: number,
  direction: "inbound" | "outbound",
  peer_phone: string,
  minutos: number,
  segundos: number | null,
  end_reason: string,
  handled_by: "ai" | "human",
  falas: Fala[] | null,
) {
  const inicio = new Date(ha(minutos)).getTime();
  const atendida = segundos !== null ? new Date(inicio + 8_000).toISOString() : null;
  const fim = new Date(inicio + 8_000 + (segundos ?? 22) * 1000).toISOString();
  return {
    id: chamadaId(n),
    organization_id: c.org,
    provider: "sip",
    direction,
    peer_phone,
    status: "ended",
    end_reason,
    handled_by,
    ai_agent_id: handled_by === "ai" ? c.agenteId : null,
    started_at: new Date(inicio).toISOString(),
    answered_at: atendida,
    ended_at: fim,
    duration_ms: segundos === null ? null : segundos * 1000,
    transcript: falas?.map(([speaker, text], i) => ({
      speaker,
      text: demo(text),
      ts: new Date(inicio + 8_000 + i * 15_000).toISOString(),
    })) ?? null,
  };
}

export async function limpar(c: Contexto) {
  semErro(await c.db.from("voice_calls").delete().eq("organization_id", c.org).in("id", IDS), "limpar chamadas");
}

export async function semear(c: Contexto) {
  await limpar(c);
  semErro(
    await c.db.from("voice_calls").insert([
      ligacao(c, 1, "inbound", "+5511976540001", 95, 222, "user_ended", "ai", [
        ["agent", "Clínica Bem Viver, boa tarde! Em que posso ajudar?"],
        ["customer", "Oi, queria saber se tem horário para fisioterapia na quinta de manhã."],
        ["agent", "Tenho às 8h e às 10h na quinta. Qual fica melhor para você?"],
        ["customer", "Às 10h, por favor."],
        ["agent", "Pronto, ficou marcado para quinta às 10h. Até lá!"],
      ]),
      ligacao(c, 2, "outbound", "+5511976540002", 240, 135, "user_ended", "ai", [
        ["agent", "Olá, aqui é da Clínica Bem Viver. Estou ligando para confirmar a sua consulta de amanhã às 9h com o dentista."],
        ["customer", "Confirmado, estarei aí."],
        ["agent", "Obrigada! Até amanhã."],
      ]),
      ligacao(c, 3, "inbound", "+5511976540003", 30, null, "timeout", "human", null),
      ligacao(c, 4, "outbound", "+5511976540004", 26 * 60, null, "busy", "ai", null),
    ]),
    "histórico de chamadas",
  );
}
