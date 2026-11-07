/**
 * DE QUEM É A PERMISSÃO DE ABRIR CASO — a pergunta que a tela de Casos precisa
 * responder ANTES de mostrar um vazio.
 *
 * ## O defeito que este arquivo existe para consertar
 *
 * `cases_enabled` nasce **desligada** em toda versão de agente
 * (`AgentForm.tsx` monta `?? false`, e a coluna no banco é `not null default
 * false`). Com ela desligada o motor não monta `open_human_case` nem
 * `provide_case_update` (`inbound-turn.ts`: `if (agentConfig.casesEnabled)`), e
 * NENHUM caso nasce. A tela de Casos, então, mostrava "Nenhum caso aberto /
 * Quando a IA precisar de você, aparece aqui." — a mesma frase de quem ligou a
 * chave e ainda não teve pedido nenhum. Duas situações opostas com a mesma
 * cara, e a única saída era adivinhar que existia uma chave no agente.
 *
 * ## Por que a resposta é da ORGANIZAÇÃO, e não de um agente
 *
 * A lista de casos é por organização: `GET /api/v1/ai/cases` chama
 * `listarChamados(admin, org.orgId)` e não recebe agente em lugar nenhum — o
 * caso guarda `agent_id`, mas quem lê não filtra por ele. Logo a tela não tem
 * "o agente dos casos" para consultar; ela só pode perguntar "existe ALGUM
 * agente desta organização que consiga abrir caso?".
 *
 * A regra, então, é **um basta**: se ao menos um agente tem a chave ligada na
 * versão publicada, a fila pode receber caso e a tela volta ao vazio normal
 * (não se manda ligar o que já está ligado). Só quando NENHUM pode — e aí o
 * vazio é estrutural, não "ainda não aconteceu".
 *
 * ## Publicado, não rascunho
 *
 * O motor resolve a configuração pela **versão publicada**
 * (`loadPublishedAgentConfig`, ponteiro `ai_agents.published_version_id`).
 * Ligar a chave e salvar o rascunho não muda nada em produção — por isso
 * `rascunhoLigado` existe: é a diferença entre "ninguém ligou" e "ligou e
 * esqueceu de publicar", que são conselhos diferentes para quem está olhando a
 * tela vazia.
 *
 * ## Indefinido não vira acusação
 *
 * Erro de leitura NÃO vira `desligada`. Dizer "nenhum agente pode abrir caso"
 * sem ter conseguido perguntar seria inventar um diagnóstico sobre o trabalho
 * de quem instalou — a mesma classe de erro do `catch` mudo que já deixou a
 * tela mostrando "nenhum caso" com o caso aberto no banco. `indefinida` faz a
 * tela ficar como estava.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/** O que a leitura conseguiu afirmar sobre a chave. */
export type EstadoDaChaveDeCasos = "ligada" | "desligada" | "indefinida";

export interface LiberacaoDeCasos {
  estado: EstadoDaChaveDeCasos;
  /**
   * Só tem sentido quando `estado === "desligada"`: algum RASCUNHO (não
   * publicado) já tem a chave ligada. O vazio então é "falta publicar".
   */
  rascunhoLigado: boolean;
  /** O agente da organização, quando existe exatamente um — alvo do link direto. */
  agenteUnicoId: string | null;
  /** Quantos agentes vivos (não arquivados) a organização tem. */
  agentes: number;
}

export const LIBERACAO_INDEFINIDA: LiberacaoDeCasos = {
  estado: "indefinida",
  rascunhoLigado: false,
  agenteUnicoId: null,
  agentes: 0,
};

interface AgenteRow {
  id: string;
  published_version_id: string | null;
}

interface VersaoRow {
  id: string;
  agent_id: string;
  status: string | null;
  cases_enabled: boolean | null;
}

/**
 * Lê a organização inteira e responde se algum agente publicado consegue abrir
 * caso. Duas consultas em vez de um embed: nome de constraint de FK muda, e uma
 * página que passa a devolver zero agentes por causa de um `!fkey` errado é
 * exatamente o vazio mudo que este arquivo veio consertar.
 */
export async function lerLiberacaoDeCasos(
  client: SupabaseClient,
  organizationId: string,
): Promise<LiberacaoDeCasos> {
  const { data: agentes, error: erroAgentes } = await client
    .from("ai_agents")
    .select("id, published_version_id")
    .eq("organization_id", organizationId)
    .is("archived_at", null);
  if (erroAgentes) {
    logger.error("[ai/cases] não consegui listar os agentes — a tela não pode dizer que a chave está desligada", {
      organization_id: organizationId,
      detail: erroAgentes.message.slice(0, 200),
    });
    return LIBERACAO_INDEFINIDA;
  }
  const vivos = (agentes ?? []) as AgenteRow[];

  const { data: versoes, error: erroVersoes } = await client
    .from("ai_agent_versions")
    .select("id, agent_id, status, cases_enabled")
    .eq("organization_id", organizationId)
    .eq("cases_enabled", true);
  if (erroVersoes) {
    logger.error("[ai/cases] não consegui ler as versões dos agentes — a tela não pode dizer que a chave está desligada", {
      organization_id: organizationId,
      detail: erroVersoes.message.slice(0, 200),
    });
    return LIBERACAO_INDEFINIDA;
  }
  const todas = (versoes ?? []) as VersaoRow[];
  const porId = new Map(todas.map((v) => [v.id, v]));
  const agentesVivos = new Set(vivos.map((a) => a.id));

  // Ligada = a versão que o motor de fato lê (o ponteiro publicado) tem a chave.
  const ligada = vivos.some(
    (a) => a.published_version_id !== null && porId.get(a.published_version_id)?.cases_enabled === true,
  );
  if (ligada) {
    return { estado: "ligada", rascunhoLigado: false, agenteUnicoId: null, agentes: vivos.length };
  }

  const rascunhoLigado = todas.some(
    (v) => v.status === "draft" && v.cases_enabled === true && agentesVivos.has(v.agent_id),
  );

  return {
    estado: "desligada",
    rascunhoLigado,
    // `vivos[0]` é `indefinido` para o TS sob `noUncheckedIndexedAccess`, mesmo
    // com o `length === 1` ao lado: a checagem de tamanho não estreita o índice.
    agenteUnicoId: vivos.length === 1 ? (vivos[0]?.id ?? null) : null,
    agentes: vivos.length,
  };
}

export type MotivoDoVazioDeCasos = "sem_agente" | "chave_desligada" | "falta_publicar";

export interface AvisoDeVazioDeCasos {
  motivo: MotivoDoVazioDeCasos;
  /** Para onde o botão leva. `null` = este papel não abre a tela do agente. */
  href: string | null;
  alvo: "agente" | "lista";
  /** Quem pode de fato mudar e publicar a chave (admin). */
  podeEditar: boolean;
}

export interface PermissoesDoLeitor {
  /** Abre `/app/ai/agents/[id]` (manager+). Abaixo disso a página redireciona 403. */
  podeVerAgente: boolean;
  /** Muda e publica versão (admin). */
  podeEditar: boolean;
}

/**
 * Traduz a leitura em um aviso para a tela — ou em `null`, que é o caso normal
 * (alguém pode abrir caso: o vazio é "ninguém pediu ainda" e não se explica).
 *
 * Função pura de propósito: a decisão "qual motivo, qual link, qual papel" é o
 * que os testes prendem, sem depender de banco nem de render.
 */
export function avisoDeVazioDeCasos(
  liberacao: LiberacaoDeCasos,
  permissoes: PermissoesDoLeitor,
): AvisoDeVazioDeCasos | null {
  if (liberacao.estado !== "desligada") return null;

  const alvo: "agente" | "lista" = liberacao.agenteUnicoId !== null ? "agente" : "lista";
  // Link só para quem a página do agente deixa entrar. Para o papel `agent`
  // (que VÊ a tela de Casos mas não a de agente), um link aqui seria um 403
  // disfarçado de ajuda.
  const href = permissoes.podeVerAgente
    ? alvo === "agente"
      ? `/app/ai/agents/${liberacao.agenteUnicoId}#cases_enabled`
      : "/app/ai/agents"
    : null;

  const motivo: MotivoDoVazioDeCasos =
    liberacao.agentes === 0 ? "sem_agente" : liberacao.rascunhoLigado ? "falta_publicar" : "chave_desligada";

  return { motivo, href, alvo, podeEditar: permissoes.podeEditar };
}
