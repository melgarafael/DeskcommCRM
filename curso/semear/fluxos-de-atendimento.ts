/**
 * Semente do módulo "Fluxos de atendimento" (Agente de IA › Ver tudo em IA ›
 * Fluxos de atendimento, /app/ai/atendimento).
 *
 * A tela só existe com o módulo opcional "Fluxos de atendimento" ligado NA
 * INSTALAÇÃO (`app/app/ai/atendimento/layout.tsx` devolve 404 sem ele). Ligamos
 * pela mesma linha que `gravarModulo` grava (`platform_config`,
 * `MODULO_FLUXOS_DE_ATENDIMENTO = 'ligado'`); a base devolve `platform_config`
 * ao estado de fábrica antes de cada aula, então o módulo some sozinho depois.
 *
 * Dois roteiros da Clínica Bem Viver, montados no formato do construtor
 * (`flowGraphSchema`): Início → Perguntas → Fim, ligados em linha, sem condição.
 *  - "Primeira consulta · cadastro do paciente": PUBLICADO (Ativo), pela mesma
 *    função do botão Publicar (`fn_publish_followup_flow_version`);
 *  - "Convênio · conferir a carteirinha": RASCUNHO — a lição o publica pela tela.
 *
 * Nenhum paciente está dentro de um roteiro: inscrição pede conversa aberta e
 * turno do agente, e o worker da bancada está parado.
 *
 * Idempotente: ids fixos `f1c001…`, apagados e recriados (versões vão em
 * cascata). Nenhuma lição cria roteiro: a que abre "Novo fluxo de atendimento"
 * para antes de "Criar fluxo". `limpar` apaga os dois: com o módulo desligado
 * as linhas não aparecem, mas continuam no banco.
 */
import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";
import { type Contexto, exigir, ha, semErro } from "../semear-demonstracao";

const fluxoId = (n: number) => `f1c00100-0000-4000-8000-${String(n).padStart(12, "0")}`;
const FLUXOS = [1, 2].map(fluxoId);

type Pergunta = {
  id: string;
  rotulo: string;
  key: string;
  pergunta: string;
  tipo: "text" | "date" | "select" | "cpf";
  obrigatoria?: false;
  opcoes?: string[];
  sugerido?: string;
};

/** Início → perguntas → Fim, da esquerda para a direita, com as ligações que o roteiro aceita ("always"). */
function grafo(gatilhos: string[], perguntas: Pergunta[], fim: Record<string, unknown>) {
  const nos = [
    { id: "inicio", type: "trigger", label: demo("Início"), config: {} },
    ...perguntas.map((p) => ({
      id: p.id,
      type: "collect",
      label: demo(p.rotulo),
      config: {
        key: p.key,
        label: demo(p.pergunta),
        type: p.tipo,
        required: p.obrigatoria ?? true,
        permite_correcao: true,
        ...(p.opcoes ? { options: p.opcoes } : {}),
        ...(p.sugerido ? { question: demo(p.sugerido) } : {}),
      },
    })),
    { id: "fim", type: "end", label: demo("Fim"), config: fim },
  ].map((no, i) => ({ ...no, position: { x: i * 280, y: 0 } }));
  return {
    nodes: nos,
    edges: nos.slice(1).map((no, i) => ({
      id: `e-${nos[i]!.id}-${no.id}`,
      source: nos[i]!.id,
      target: no.id,
      priority: 0,
      condition: { type: "always" },
    })),
    settings: { max_tentativas_pergunta: 3, gatilhos: gatilhos.map((g) => demo(g)), expira_em_horas: 48 },
  };
}

export async function limpar(c: Contexto) {
  semErro(await c.db.from("followup_flow_pointers").delete().eq("organization_id", c.org).in("id", FLUXOS), "limpar roteiros");
}

export async function semear(c: Contexto) {
  const { db, org, pessoa } = c;
  semErro(
    await db.from("platform_config").upsert(
      { chave: "MODULO_FLUXOS_DE_ATENDIMENTO", valor: "ligado", eh_segredo: false, semeado_do_env: false, updated_by: pessoa.helena },
      { onConflict: "chave" },
    ),
    "ligar o módulo Fluxos de atendimento",
  );
  await limpar(c);

  const ROTEIROS = [
    {
      n: 1,
      nome: "Primeira consulta · cadastro do paciente",
      publicar: true,
      atualizado: ha(3 * 24 * 60),
      grafo: grafo(
        ["primeira consulta", "primeira vez", "paciente novo"],
        [
          { id: "cpf", rotulo: "CPF", key: "cpf", pergunta: "Qual é o seu CPF?", tipo: "cpf" },
          { id: "nascimento", rotulo: "Data de nascimento", key: "data_nascimento", pergunta: "Qual é a sua data de nascimento?", tipo: "date" },
          {
            id: "convenio",
            rotulo: "Convênio",
            key: "convenio",
            pergunta: "Vai usar convênio ou particular?",
            tipo: "select",
            // nomes de operadora não se traduzem
            opcoes: [demo("Particular"), "Unimed", "Bradesco Saúde", "SulAmérica"],
          },
          {
            id: "motivo",
            rotulo: "Motivo da consulta",
            key: "motivo_consulta",
            pergunta: "O que está te incomodando?",
            tipo: "text",
            obrigatoria: false,
            sugerido: "Para eu já avisar o profissional: o que está te incomodando?",
          },
        ],
        {
          outcome: "converted",
          ao_finalizar: { tipo: "ia", prompt: demo("Agradeça e ofereça os horários livres desta semana para a primeira avaliação.") },
        },
      ),
    },
    {
      n: 2,
      nome: "Convênio · conferir a carteirinha",
      publicar: false,
      atualizado: ha(5 * 60),
      grafo: grafo(
        ["carteirinha", "guia do convênio"],
        [
          { id: "carteirinha", rotulo: "Número da carteirinha", key: "carteirinha", pergunta: "Qual é o número da sua carteirinha?", tipo: "text" },
          { id: "validade", rotulo: "Validade", key: "validade_carteirinha", pergunta: "Até quando a carteirinha vale?", tipo: "date" },
        ],
        { outcome: "converted", ao_finalizar: { tipo: "nada" } },
      ),
    },
  ];

  for (const r of ROTEIROS) {
    // surface e gatilho manual: o CHECK followup_flow_pointers_roteiro_so_manual exige os dois juntos
    semErro(
      await db.from("followup_flow_pointers").insert({
        id: fluxoId(r.n), organization_id: org, name: demo(r.nome), surface: "atendimento",
        trigger_config: { kind: "manual" }, draft_graph: r.grafo,
      }),
      `roteiro ${r.nome}`,
    );
    if (r.publicar) {
      exigir(
        await db.rpc("fn_publish_followup_flow_version", { p_org: org, p_pointer: fluxoId(r.n), p_graph: r.grafo, p_created_by: pessoa.helena }),
        `publicar ${r.nome}`,
      );
    }
    semErro(await db.from("followup_flow_pointers").update({ updated_at: r.atualizado }).eq("id", fluxoId(r.n)), `data de ${r.nome}`);
  }
}
