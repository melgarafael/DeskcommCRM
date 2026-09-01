/**
 * Camada de apresentacao do catalogo de tools — pacotes de capacidade e risco.
 *
 * Existe porque o publico que configura um agente no SonghaiCRM e dono de
 * clinica, de loja, de imobiliaria — nao engenheiro. `crm_move_lead_stage` nao
 * configura nada para essa pessoa.
 *
 * Duas razoes para agrupar em PACOTES em vez de listar tool por tool:
 *   1. modelo — 60 tools num prompt degradam a escolha do LLM (erra a tool,
 *      gasta contexto, alucina argumento). O teto de 20 por agente e real.
 *   2. tela — 60 checkboxes destroem a configuracao para um leigo.
 * O checkbox por tool continua existindo em "modo avancado"; o pacote e o
 * caminho padrao.
 *
 * Este modulo e CLIENT-SAFE: zero import de zod, supabase ou next/headers.
 * Pode ser importado por Client Component.
 */

/** Quanto estrago a capacidade pode fazer — dirige a cerimonia na tela. */
export type ToolRisk = "seguro" | "atencao" | "critico";

/** Jornada de trabalho a que a capacidade pertence. Uma tool pode servir a mais de uma. */
export type ToolBundle =
  | "atender"
  | "vender"
  | "reter"
  | "escalar"
  | "organizar"
  | "evoluir";

export interface PacoteMeta {
  id: ToolBundle;
  rotulo: string;
  /** O que o agente passa a conseguir fazer quando este pacote e ligado. */
  explicacao: string;
  /** Ordem de exibicao — do mais comum ao mais avancado. */
  ordem: number;
}

export const PACOTES: ReadonlyArray<PacoteMeta> = [
  {
    id: "atender",
    rotulo: "Atender e responder",
    explicacao:
      "O agente lê a conversa, entende o histórico e responde ao cliente sem pedir que ele repita o que já disse.",
    ordem: 1,
  },
  {
    id: "vender",
    rotulo: "Vender e mover o funil",
    explicacao:
      "O agente registra a oportunidade, atualiza o negócio e move o cliente de etapa conforme a conversa avança.",
    ordem: 2,
  },
  {
    id: "reter",
    rotulo: "Não perder o cliente",
    explicacao:
      "O agente agenda retornos e acompanha quem esfriou, para que nenhum interessado morra por falta de resposta.",
    ordem: 3,
  },
  {
    id: "escalar",
    rotulo: "Passar para um humano",
    explicacao:
      "O agente reconhece quando não é o caso dele resolver, chama uma pessoa e entrega o resumo do que já aconteceu.",
    ordem: 4,
  },
  {
    id: "organizar",
    rotulo: "Organizar a operação",
    explicacao:
      "O agente mantém a casa em ordem: marcadores, etapas do funil, avisos automáticos e distribuição de trabalho.",
    ordem: 5,
  },
  {
    id: "evoluir",
    rotulo: "Aprender e evoluir",
    explicacao:
      "O agente consulta o que a empresa já sabe, aprende com os atendimentos e sugere melhorias para você aprovar.",
    ordem: 6,
  },
] as const;

export interface RiscoMeta {
  id: ToolRisk;
  rotulo: string;
  explicacao: string;
}

export const RISCOS: ReadonlyArray<RiscoMeta> = [
  {
    id: "seguro",
    rotulo: "Só consulta",
    explicacao: "O agente apenas lê a informação. Nada muda no sistema.",
  },
  {
    id: "atencao",
    rotulo: "Altera dados",
    explicacao:
      "O agente muda alguma coisa no sistema. Você consegue ver o que mudou e desfazer pela tela.",
  },
  {
    id: "critico",
    rotulo: "Efeito que não dá para desfazer",
    explicacao:
      "O agente faz algo que sai do sistema ou não volta atrás — como falar com o cliente de verdade. Precisa ser ligado por você, uma a uma.",
  },
] as const;

/**
 * Capacidade `critico` nunca entra ligada por pacote: exige marcacao explicita
 * do humano. Ligar "Atender e responder" nao pode, sozinho, dar ao agente o
 * direito de mandar mensagem para o cliente.
 */
export function entraPorPacote(risco: ToolRisk): boolean {
  return risco !== "critico";
}

export function pacoteMeta(id: ToolBundle): PacoteMeta {
  const found = PACOTES.find((p) => p.id === id);
  if (!found) throw new Error(`pacote desconhecido: ${id}`);
  return found;
}

export function riscoMeta(id: ToolRisk): RiscoMeta {
  const found = RISCOS.find((r) => r.id === id);
  if (!found) throw new Error(`risco desconhecido: ${id}`);
  return found;
}
