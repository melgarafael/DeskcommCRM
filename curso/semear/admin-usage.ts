/**
 * Semente do módulo Usage (Admin): três empresas de exemplo com 90 dias de uso,
 * cada uma num retrato diferente da tabela "Uso por tenant".
 *
 *  - NutriVida Consultório: a que mais usa — agente "Luna" publicado, IA
 *    respondendo todo dia desde 88 dias atrás.
 *  - FisioMove Reabilitação: começou há 40 dias, agente "Téo" publicado.
 *    Some do gráfico quando o período volta mais que isso.
 *  - OdontoVita: atende só com pessoas, sem agente publicado — a linha mostra
 *    "Nenhum agente publicado" e IA zerada.
 *
 * A Clínica Bem Viver entra com o que a base já semeia (27 mensagens, 12
 * conversas, a Bia publicada e nunca chamada: IA zerada).
 *
 * As mensagens levam `metadata.historico_importado = 'true'`: o gatilho de
 * mensagem não emite evento nem acorda atendimento para elas (mesmo corte do
 * importador de histórico). As conversas nascem fechadas pelo mesmo motivo:
 * aberta e sem dono, a conversa pede roteamento.
 *
 * O total fica abaixo de 1.000 mensagens e 1.000 chamadas de IA em 90 dias:
 * a rota soma linhas lidas de uma vez, e o banco devolve no máximo 1.000.
 *
 * ⚠️ `created_at` das empresas fica DEPOIS do da Clínica Bem Viver: a base trata
 * a org mais antiga como a da instalação e apaga as outras.
 */
import { type Contexto, exigir, semErro } from "../semear-demonstracao";

const ORG = {
  nutri: "a8000000-0000-4000-8000-000000000001",
  fisio: "a8000000-0000-4000-8000-000000000002",
  odonto: "a8000000-0000-4000-8000-000000000003",
};
const MIN = 60_000;
const DIA = 1_440 * MIN;
const agora = Date.now();

type Perfil = {
  org: string;
  /** dias atrás em que o uso começou */
  desde: number;
  /** mensagens num dia útil típico */
  porDia: number;
  /** a cada quantos dias nasce uma conversa nova */
  conversaACada: number;
  /** chamadas de IA por mensagem (0 = sem agente) */
  ia: number;
  falas: string[];
  pacientes: string[];
};

const PERFIS: Perfil[] = [
  {
    org: ORG.nutri, desde: 88, porDia: 4, conversaACada: 4, ia: 0.5,
    falas: [
      "Oi! Queria marcar uma consulta com a nutricionista.",
      "Claro! Temos horário na terça às 9h ou na quinta às 14h. Qual prefere?",
      "Posso levar meus exames de sangue na primeira consulta?",
      "Pode sim, e ajuda bastante a montar o seu plano alimentar.",
      "Vocês fazem bioimpedância?",
      "Fazemos, e ela já está incluída na primeira consulta.",
    ],
    pacientes: ["Larissa Fontes", "Thiago Barreto", "Vanessa Prates", "Rodrigo Sales", "Aline Coutinho", "Márcio Peixoto", "Priscila Duarte", "Henrique Lobo"],
  },
  {
    org: ORG.fisio, desde: 40, porDia: 6, conversaACada: 3, ia: 0.45,
    falas: [
      "Bom dia, a sessão de RPG de amanhã está confirmada?",
      "Confirmada, às 8h com a Dra. Carla. Até amanhã!",
      "Preciso do relatório de evolução para o convênio.",
      "Vou pedir para a fisioterapeuta preparar e te aviso quando estiver pronto.",
      "Qual o valor do pacote de 10 sessões?",
      "O pacote de 10 sessões sai por R$ 900,00 e pode ser parcelado.",
    ],
    pacientes: ["Silvia Moura", "Rogério Bastos", "Débora Antunes", "Fábio Quintana", "Joana Pires", "Caio Albuquerque"],
  },
  {
    org: ORG.odonto, desde: 75, porDia: 2, conversaACada: 5, ia: 0,
    falas: [
      "Oi, queria agendar uma limpeza para sábado.",
      "Temos sábado às 10h com o Dr. Ricardo. Posso confirmar?",
      "Vocês aceitam o convênio OdontoPrev?",
      "Aceitamos sim! Traga a carteirinha no dia.",
    ],
    pacientes: ["Renata Albuquerque", "Marcos Tavares", "Patrícia Lemos", "Gustavo Prado", "Luana Reis"],
  },
];

/** Fim de semana tem metade do movimento; a variação por dia vem de uma conta fixa (sem acaso: a foto não muda entre capturas). */
function mensagensNoDia(p: Perfil, d: number) {
  const dia = new Date(agora - d * DIA).getUTCDay();
  const base = dia === 0 || dia === 6 ? Math.ceil(p.porDia / 2) : p.porDia;
  return base + ((d * 7 + p.porDia) % 3);
}

export async function semear(c: Contexto) {
  const principal = exigir(await c.db.from("organizations").select("created_at").eq("id", c.org).single(), "criação da org principal") as { created_at: string };
  const depois = (min: number) => new Date(Math.min(new Date(principal.created_at).getTime() + min * MIN, agora - (10 - min) * 1000)).toISOString();

  // apagar a empresa leva junto (cascata) número, contatos, conversas, mensagens, agente e chamadas de IA
  semErro(await c.db.from("organizations").delete().in("id", Object.values(ORG)), "apagar empresas de exemplo");
  semErro(
    await c.db.from("organizations").insert([
      { id: ORG.nutri, slug: "nutrivida-consultorio", display_name: "NutriVida Consultório", legal_name: "NutriVida Consultório de Nutrição Ltda", created_at: depois(1) },
      { id: ORG.fisio, slug: "fisiomove-reabilitacao", display_name: "FisioMove Reabilitação", legal_name: "FisioMove Fisioterapia e Reabilitação Ltda", created_at: depois(2) },
      { id: ORG.odonto, slug: "odontovita", display_name: "OdontoVita", legal_name: "OdontoVita Clínica Odontológica Ltda", created_at: depois(3) },
    ].map((o) => ({ ...o, status: "active", onboarded_at: o.created_at }))),
    "empresas de exemplo",
  );

  const numeros = exigir(
    await c.db.from("channel_sessions").insert([
      { organization_id: ORG.nutri, waha_session_name: "nutrivida-recepcao", phone_number: "+551130461100", display_name: "Recepção NutriVida" },
      { organization_id: ORG.fisio, waha_session_name: "fisiomove-agenda", phone_number: "+551130462200", display_name: "Agenda FisioMove" },
      { organization_id: ORG.odonto, waha_session_name: "odontovita-central", phone_number: "+551130463300", display_name: "Central OdontoVita" },
    ].map((n) => ({ ...n, provider: "waha", webhook_secret_encrypted: "\\x00", status: "WORKING" }))).select("id, organization_id"),
    "números das empresas de exemplo",
  ) as Array<{ id: string; organization_id: string }>;
  const numeroDe = (org: string) => numeros.find((n) => n.organization_id === org)!.id;

  // ---------- agentes publicados: Luna (NutriVida) e Téo (FisioMove); a OdontoVita não tem ----------
  const agenteDe: Record<string, string> = {};
  for (const [org, nome, prompt] of [
    [ORG.nutri, "Luna — Nutrição virtual", "Você é a Luna, atendente virtual do NutriVida Consultório."],
    [ORG.fisio, "Téo — Agenda da Fisio", "Você é o Téo, que cuida da agenda da FisioMove Reabilitação."],
  ] as const) {
    const agente = exigir(
      await c.db.from("ai_agents").insert({ organization_id: org, name: nome, system_prompt: prompt, is_default: true, is_active: true }).select("id").single(),
      `agente ${nome}`,
    ) as { id: string };
    const versao = exigir(
      await c.db.from("ai_agent_versions").insert({
        organization_id: org, agent_id: agente.id, version_number: 1, system_prompt: prompt, provider: "anthropic", model: "claude-sonnet-4-6",
        credential_id: null, channel_session_id: numeroDe(org), status: "published", published_at: depois(4),
      }).select("id").single(),
      `versão de ${nome}`,
    ) as { id: string };
    semErro(await c.db.from("ai_agents").update({ published_version_id: versao.id }).eq("id", agente.id), `publicar ${nome}`);
    agenteDe[org] = agente.id;
  }

  for (const [i, p] of PERFIS.entries()) {
    // ---------- uma conversa nova a cada N dias, cada uma com o seu paciente ----------
    const inicios: number[] = [];
    for (let d = p.desde; d >= 0; d -= p.conversaACada) inicios.push(d);
    const contatos = inicios.map((_, k) => ({
      id: `a8${i + 1}00000-0000-4000-8000-${String(k + 1).padStart(12, "0")}`,
      organization_id: p.org,
      name: k < p.pacientes.length ? p.pacientes[k]! : `${p.pacientes[k % p.pacientes.length]!.split(" ")[0]} ${["Ramos", "Freitas", "Siqueira", "Monteiro", "Brandão"][k % 5]}`,
      phone_number: `+55119766${i + 1}${String(k + 1).padStart(4, "0")}`,
    }));
    semErro(await c.db.from("contacts").insert(contatos), `pacientes da empresa ${i + 1}`);
    const conversas = exigir(
      await c.db.from("conversations").insert(inicios.map((d, k) => ({
        organization_id: p.org, contact_id: contatos[k]!.id, channel_session_id: numeroDe(p.org), status: "closed",
        created_at: new Date(agora - d * DIA - 9 * 60 * MIN).toISOString(),
      }))).select("id, contact_id"),
      `conversas da empresa ${i + 1}`,
    ) as Array<{ id: string; contact_id: string }>;

    // ---------- mensagens e chamadas de IA, dia a dia ----------
    const mensagens: Record<string, unknown>[] = [];
    const chamadas: Record<string, unknown>[] = [];
    let iaAcumulada = 0;
    for (let d = p.desde; d >= 0; d--) {
      // a conversa mais recente que já tinha começado naquele dia
      const conversa = conversas[inicios.filter((ini) => ini >= d).length - 1]!;
      const n = mensagensNoDia(p, d);
      for (let j = 0; j < n; j++) {
        // de 30 em 30 min para trás a partir de "agora menos d dias": nunca no futuro
        const em = new Date(agora - d * DIA - (30 + j * 23) * MIN).toISOString();
        const recebida = j % 2 === 0;
        mensagens.push({
          organization_id: p.org, conversation_id: conversa.id, channel_session_id: numeroDe(p.org), contact_id: conversa.contact_id,
          type: "text", body: p.falas[j % p.falas.length], direction: recebida ? "inbound" : "outbound",
          status: recebida ? "received" : "read", sent_via: recebida ? "external_device" : p.ia > 0 ? "ai" : "user",
          sent_at: em, created_at: em,
          metadata: { historico_importado: "true", ...(!recebida && p.ia > 0 ? { ai_generated: true } : {}) },
        });
        iaAcumulada += p.ia;
        if (iaAcumulada >= 1) {
          iaAcumulada -= 1;
          const entrada = 6_200 + ((d * 131 + j * 977) % 2_600);
          const saida = 260 + ((d * 37 + j * 53) % 190);
          chamadas.push({
            organization_id: p.org, agent_id: agenteDe[p.org], contact_id: conversa.contact_id, purpose: "agent_turn",
            provider: "anthropic", model: "claude-sonnet-4-6", input_tokens: entrada, output_tokens: saida,
            // preço do Sonnet: US$ 3 por milhão de tokens lidos e US$ 15 por milhão escritos
            cost_cents: Number((entrada * 0.0003 + saida * 0.0015).toFixed(4)),
            latency_ms: 2_400, status: "ok", created_at: em,
          });
        }
      }
    }
    semErro(await c.db.from("messages").insert(mensagens), `mensagens da empresa ${i + 1}`);
    if (chamadas.length) semErro(await c.db.from("llm_calls").insert(chamadas), `chamadas de IA da empresa ${i + 1}`);
  }
}
