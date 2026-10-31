/**
 * Semente do módulo "Fluxos de atendimento" (Agente de IA › Ver tudo em IA ›
 * Fluxos de atendimento, `/app/ai/atendimento`).
 *
 * A tela só existe com o MÓDULO OPCIONAL da instalação "Fluxos de atendimento"
 * ligado (Admin › Recursos opcionais, chave `MODULO_FLUXOS_DE_ATENDIMENTO` em
 * `platform_config`, a linha que `gravarModulo` de lib/instalacao/modulos.ts
 * grava). Desligado, a rota é 404 e o cartão some do hub. A base devolve a
 * instalação ao estado de fábrica antes de cada lição, então ligamos aqui.
 *
 * Três roteiros da Clínica Bem Viver, um em cada estado que o selo mostra:
 *   • "Cadastro da primeira consulta" — PUBLICADO (Ativo), com palavras-gatilho,
 *     cinco perguntas e o Fim devolvendo à IA;
 *   • "Retorno · convênio e exames" — rascunho válido, nunca publicado (é o
 *     que a lição de publicar publica pela tela);
 *   • "Avaliação pós-consulta" — publicado e depois DESATIVADO.
 * Publica pela mesma função do botão Publicar (`fn_publish_followup_flow_version`).
 *
 * A ficha da Juliana Castro (contato 3 da base, que perguntou do convênio) ganha
 * um roteiro em andamento ("coletando") do fluxo da primeira consulta, com três
 * respostas já gravadas em `contacts.custom_fields` — onde o motor grava — e duas
 * por responder. As chaves são só as deste roteiro; as outras chaves da ficha
 * ficam como estão (mescla, nunca substitui).
 *
 * Idempotente: apaga os roteiros com os ids daqui e os que as lições criam pela
 * tela (pelo nome); versões e execuções vão em cascata.
 */
import { type Contexto, contatoId, conversaId, exigir, ha, semErro } from "../semear-demonstracao";
import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";

const fluxoId = (n: number) => `d1120000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const execucaoId = (n: number) => `d1120100-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Nomes que as lições criam pela tela: limpos aqui para cada lição partir do mesmo estado. */
const CRIADAS_NAS_LICOES = ["Fisioterapia · avaliação da primeira sessão"];
/** Os roteiros desta semente, pelo nome: as cópias que "Duplicar" cria também saem. */
const SEMEADOS = ["Cadastro da primeira consulta", "Retorno · convênio e exames", "Avaliação pós-consulta"];

const HORA = 60;
const DIA = 24 * HORA;
/** O contato da base que tem um roteiro em andamento (Juliana Castro). */
const JULIANA = 3;

type Pergunta = {
  id: string;
  rotulo: string;
  key: string;
  label: string;
  type: "text" | "number" | "date" | "boolean" | "select" | "cpf";
  required: boolean;
  permite_correcao?: boolean;
  options?: string[];
  question?: string;
};
type Fim = { nota?: string; ao_finalizar?: Record<string, unknown> };
type Ajustes = { gatilhos?: string[]; max_tentativas_pergunta: number; expira_em_horas?: number; pode_recomecar?: boolean };

/**
 * De cima para baixo, como o botão "Organizar" desenha (a caixa recebe a linha
 * por cima e solta por baixo), em colunas de quatro: o roteiro inteiro cabe na
 * foto sem o construtor encolher o texto.
 */
const posicao = (i: number) => ({ x: Math.floor(i / 4) * 340, y: (i % 4) * 130 });

/** Um roteiro em linha reta: Início → perguntas → Fim, como a publicação exige. */
function grafo(perguntas: Pergunta[], fim: Fim, ajustes: Ajustes) {
  const nos = [
    { id: "inicio", type: "trigger", label: demo("Início"), position: posicao(0), config: {} },
    ...perguntas.map((p, i) => ({
      id: p.id,
      type: "collect",
      label: p.rotulo,
      position: posicao(i + 1),
      config: {
        key: p.key,
        label: p.label,
        type: p.type,
        required: p.required,
        permite_correcao: p.permite_correcao ?? true,
        ...(p.options ? { options: p.options } : {}),
        ...(p.question ? { question: p.question } : {}),
      },
    })),
    {
      id: "fim",
      type: "end",
      label: demo("Fim"),
      position: posicao(perguntas.length + 1),
      config: {
        outcome: "converted",
        ...(fim.nota ? { note: fim.nota } : {}),
        ...(fim.ao_finalizar ? { ao_finalizar: fim.ao_finalizar } : {}),
      },
    },
  ];
  const ids = nos.map((n) => n.id);
  const arestas = ids.slice(0, -1).map((origem, i) => ({
    id: `e-${origem}`,
    source: origem,
    target: ids[i + 1]!,
    priority: 0,
    condition: { type: "always" },
  }));
  return { nodes: nos, edges: arestas, settings: ajustes };
}

/** Nomes de convênio são marcas: só "Particular" se traduz. */
const CONVENIOS = () => [demo("Particular"), "Unimed", "Bradesco Saúde", "SulAmérica", "Amil"];
const ESPECIALIDADES = ["Fisioterapia", "Nutrição", "Psicologia", "Clínica geral"];

export async function semear(c: Contexto) {
  const { db, org, pessoa } = c;

  // ---------- liga o módulo da instalação ----------
  semErro(
    await db.from("platform_config").upsert(
      { chave: "MODULO_FLUXOS_DE_ATENDIMENTO", valor: "ligado", eh_segredo: false, semeado_do_env: false, updated_by: pessoa.helena },
      { onConflict: "chave" },
    ),
    "ligar o módulo Fluxos de atendimento",
  );

  // ---------- limpa o que é deste módulo ----------
  semErro(await db.from("followup_flow_pointers").delete().eq("organization_id", org).in("id", [1, 2, 3].map(fluxoId)), "limpar roteiros");
  const criadas = CRIADAS_NAS_LICOES.map(demo);
  semErro(await db.from("followup_flow_pointers").delete().eq("organization_id", org).in("name", criadas), "limpar roteiros das lições");
  for (const nome of [...criadas, ...SEMEADOS.map(demo)]) {
    semErro(await db.from("followup_flow_pointers").delete().eq("organization_id", org).like("name", `${nome} (%`), "limpar cópias");
  }

  // ---------- os três roteiros ----------
  const convenios = CONVENIOS();
  const especialidades = ESPECIALIDADES.map(demo);
  const primeiraConsulta = grafo(
    [
      { id: "nome", rotulo: demo("Nome completo"), key: "nome_completo", label: demo("Nome completo"), type: "text", required: true, question: demo("Para fazer o seu cadastro, qual é o seu nome completo?") },
      { id: "cpf", rotulo: "CPF", key: "cpf", label: "CPF", type: "cpf", required: true, permite_correcao: false, question: demo("Pode me informar o seu CPF? Ele vai na ficha da consulta.") },
      { id: "nascimento", rotulo: demo("Data de nascimento"), key: "data_nascimento", label: demo("Data de nascimento"), type: "date", required: true },
      { id: "convenio", rotulo: demo("Convênio"), key: "convenio", label: demo("Convênio"), type: "select", required: true, options: convenios, question: demo("A consulta vai ser pelo convênio ou particular?") },
      { id: "especialidade", rotulo: demo("Especialidade"), key: "especialidade", label: demo("Especialidade desejada"), type: "select", required: true, options: especialidades },
    ],
    {
      nota: demo("Cadastro pronto para marcar a primeira consulta."),
      ao_finalizar: { tipo: "ia", prompt: demo("Ofereça os próximos horários livres da especialidade escolhida e confirme o agendamento com o paciente.") },
    },
    { gatilhos: [demo("primeira consulta"), demo("marcar consulta"), demo("quero agendar")], max_tentativas_pergunta: 3 },
  );
  const retorno = grafo(
    [
      { id: "convenio", rotulo: demo("Convênio"), key: "convenio", label: demo("Convênio"), type: "select", required: true, options: convenios },
      { id: "carteirinha", rotulo: demo("Número da carteirinha"), key: "numero_carteirinha", label: demo("Número da carteirinha"), type: "text", required: false },
      { id: "exames", rotulo: demo("Traz exames?"), key: "traz_exames", label: demo("Vai trazer exames na consulta?"), type: "boolean", required: true },
    ],
    {},
    { gatilhos: [demo("retorno"), demo("remarcar")], max_tentativas_pergunta: 2, expira_em_horas: 48 },
  );
  const posConsulta = grafo(
    [
      { id: "nota", rotulo: demo("Nota do atendimento"), key: "nota_atendimento", label: demo("Nota de 0 a 10 para o atendimento"), type: "number", required: true },
      { id: "comentario", rotulo: demo("Comentário"), key: "comentario_atendimento", label: demo("O que podemos melhorar?"), type: "text", required: false },
    ],
    { ao_finalizar: { tipo: "ia", prompt: demo("Agradeça a avaliação com uma frase curta.") } },
    { gatilhos: [demo("avaliar atendimento")], max_tentativas_pergunta: 1, pode_recomecar: true },
  );

  const ROTEIROS = [
    { n: 1, nome: demo(SEMEADOS[0]!), grafo: primeiraConsulta, publicar: true, desativar: false, atualizado: ha(6 * HORA) },
    { n: 2, nome: demo(SEMEADOS[1]!), grafo: retorno, publicar: false, desativar: false, atualizado: ha(2 * DIA + 3 * HORA) },
    { n: 3, nome: demo(SEMEADOS[2]!), grafo: posConsulta, publicar: true, desativar: true, atualizado: ha(15 * DIA) },
  ];
  const versaoDe: Record<number, string> = {};
  for (const r of ROTEIROS) {
    semErro(
      await db.from("followup_flow_pointers").insert({
        id: fluxoId(r.n), organization_id: org, name: r.nome, surface: "atendimento", draft_graph: r.grafo,
      }),
      `roteiro ${r.n}`,
    );
    if (r.publicar) {
      versaoDe[r.n] = exigir(
        await db.rpc("fn_publish_followup_flow_version", {
          p_org: org, p_pointer: fluxoId(r.n), p_graph: r.grafo, p_created_by: pessoa.helena,
        }),
        `publicar o roteiro ${r.n}`,
      ) as string;
    }
    semErro(
      await db.from("followup_flow_pointers").update({
        ...(r.desativar ? { status: "disabled" } : {}), updated_at: r.atualizado,
      }).eq("id", fluxoId(r.n)),
      `estado do roteiro ${r.n}`,
    );
  }

  // ---------- a Juliana no meio do cadastro ----------
  const ficha = exigir(
    await db.from("contacts").select("custom_fields").eq("organization_id", org).eq("id", contatoId(JULIANA)).single(),
    "ficha da Juliana",
  ) as { custom_fields: Record<string, unknown> | null };
  const campos = { ...(ficha.custom_fields ?? {}) };
  delete campos.cpf;
  delete campos.data_nascimento;
  campos.nome_completo = "Juliana Castro Ribeiro";
  campos.convenio = "Unimed";
  campos.especialidade = demo("Fisioterapia");
  semErro(
    await db.from("contacts").update({ custom_fields: campos }).eq("organization_id", org).eq("id", contatoId(JULIANA)),
    "respostas da Juliana",
  );
  semErro(
    await db.from("followup_enrollments").insert({
      id: execucaoId(1), organization_id: org, pointer_id: fluxoId(1), version_id: versaoDe[1], agent_id: c.agenteId,
      contact_id: contatoId(JULIANA), conversation_id: conversaId(JULIANA), current_node_id: "cpf", status: "coletando",
      next_eval_at: null, steps_taken: 2, started_at: ha(95), updated_at: ha(90),
    }),
    "roteiro da Juliana",
  );
}
