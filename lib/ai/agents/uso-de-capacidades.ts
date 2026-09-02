/**
 * O que a contagem de uso quer dizer para quem configura o agente.
 *
 * `fn_agent_tool_usage` devolve números crus (total, falhas, em_teste, última
 * vez). Número cru na tela é ruído: o invariante 5 da doutrina exige que todo
 * dado exibido responda "por que estou vendo isto e o que faço a seguir".
 *
 * Aqui cada capacidade vira um SINAL com uma recomendação em português. Puro e
 * sem I/O de propósito — a precedência entre os sinais é a parte que erra
 * sozinha, e é o que o teste prende.
 */
import type { ToolRisk } from "@/lib/mcp/tools/pacotes";

/** Uma linha como `fn_agent_tool_usage` devolve. */
export interface LinhaDeUso {
  tool_name: string;
  total: number;
  falhas: number;
  em_teste: number;
  ultima_vez: string | null;
}

/** O mínimo do catálogo que a projeção precisa. */
export interface CapacidadeConhecida {
  name: string;
  rotulo: string;
  o_que_toca: string;
  risco: ToolRisk;
}

export type SinalDeUso =
  | "fora_da_configuracao"
  | "so_falha"
  | "falhando"
  | "nunca_usada"
  | "recem_ligada"
  | "so_em_teste"
  | "saudavel";

export interface CapacidadeComUso extends CapacidadeConhecida {
  ligada: boolean;
  total: number;
  falhas: number;
  em_teste: number;
  ultima_vez: string | null;
  sinal: SinalDeUso;
  /** O "e daí?" — o que o humano faz com este número. */
  recomendacao: string;
}

/**
 * Ordem de gravidade. É a ordem em que os cartões aparecem: o que exige ação
 * primeiro, o que está bem por último. Também é a precedência entre sinais —
 * uma capacidade que só falhou, e só em teste, é um problema de falha, não uma
 * curiosidade sobre teste.
 */
const GRAVIDADE: Record<SinalDeUso, number> = {
  so_falha: 0,
  falhando: 1,
  fora_da_configuracao: 2,
  nunca_usada: 3,
  so_em_teste: 4,
  saudavel: 5,
  // Recém-ligada não pede decisão nenhuma: vai para o fim da lista.
  recem_ligada: 6,
};

function classificar(
  ligada: boolean,
  uso: LinhaDeUso | undefined,
  configuracaoRecente: boolean,
): SinalDeUso {
  const total = uso?.total ?? 0;
  const falhas = uso?.falhas ?? 0;
  const emTeste = uso?.em_teste ?? 0;

  // "Nunca usada nos últimos 30 dias, considere desligar" só quer dizer algo se
  // a capacidade TEVE 30 dias para ser usada. Numa configuração feita agora, a
  // mesma frase manda o dono desligar o que ele acabou de ligar — foi o que a
  // prova com IA real mostrou: 7 capacidades "pedindo decisão" dois minutos
  // depois de criadas.
  if (total === 0) return configuracaoRecente ? "recem_ligada" : "nunca_usada";
  if (falhas === total) return "so_falha";
  if (falhas > 0) return "falhando";
  if (!ligada) return "fora_da_configuracao";
  if (emTeste === total) return "so_em_teste";
  return "saudavel";
}

function recomendar(
  sinal: SinalDeUso,
  uso: { total: number; falhas: number; em_teste: number },
  janelaEmDias: number,
): string {
  if (sinal === "recem_ligada") {
    return "Ligada há pouco tempo. Ainda não houve atendimento em que ela fosse útil — volte aqui depois de alguns dias.";
  }
  switch (sinal) {
    case "so_falha":
      return uso.total === 1
        ? "A única tentativa falhou. Abra a execução para ver o motivo — enquanto isso o agente tenta e não consegue."
        : `Todas as ${uso.total} tentativas falharam. Abra as execuções para ver o motivo — enquanto isso o agente tenta e não consegue.`;
    case "falhando":
      return `${uso.falhas} de ${uso.total} tentativas falharam. Vale abrir as execuções e entender o que a impede.`;
    case "fora_da_configuracao":
      // Não afirme a causa: quem cai aqui pode ser o pedido de ajuda humana
      // (que o sistema oferece sozinho) ou uma capacidade desligada DEPOIS de
      // já ter sido usada. Dizer "é o caso do pedido de ajuda humana" mente na
      // segunda hipótese, e foi o que a prova em tela pegou.
      return "O agente usou esta capacidade sem ela estar ligada nesta configuração. Ou ela foi desligada depois de já ter sido usada, ou é o pedido de ajuda humana — esse o sistema oferece sozinho quando o repasse para uma pessoa está ativado.";
    case "nunca_usada":
      return `Ligada e nunca usada nos últimos ${janelaEmDias} dias. Ela ocupa uma das vagas e concorre com as outras quando o agente escolhe o que fazer — considere desligar.`;
    case "so_em_teste":
      return "Só foi usada nos seus testes. Nenhum atendimento real precisou dela ainda.";
    case "saudavel":
      return uso.em_teste > 0
        ? `${uso.total} usos, nenhuma falha (${uso.em_teste} em teste).`
        : `${uso.total} usos, nenhuma falha.`;
  }
}

export interface MontarUsoInput {
  /** `tool_ids` da versão que o humano está olhando. */
  ligadas: ReadonlyArray<string>;
  catalogo: ReadonlyArray<CapacidadeConhecida>;
  linhas: ReadonlyArray<LinhaDeUso>;
  janelaEmDias: number;
  /**
   * Quando esta configuração passou a valer (ISO). Se ela é mais nova que a
   * janela, "nunca usada" não é diagnóstico — é só o relógio.
   */
  configuradaEm?: string | null;
  /** Injetável para o teste não depender do relógio da máquina. */
  agora?: number;
}

/**
 * Junta configuração (o que está ligado) com realidade (o que foi usado).
 *
 * Entram no resultado as capacidades ligadas E as usadas. Uma capacidade
 * desligada e nunca usada não é informação — é o estado de quase tudo no
 * catálogo, e listá-la afogaria as poucas linhas que pedem decisão.
 */
export function montarUsoDeCapacidades(input: MontarUsoInput): CapacidadeComUso[] {
  const { ligadas, catalogo, linhas, janelaEmDias, configuradaEm } = input;

  const agora = input.agora ?? Date.now();
  const configuracaoRecente =
    configuradaEm != null &&
    agora - new Date(configuradaEm).getTime() < janelaEmDias * 86_400_000;

  const usoPorNome = new Map(linhas.map((l) => [l.tool_name, l]));
  const ligadasSet = new Set(ligadas);

  const nomes = new Set<string>([...ligadas, ...linhas.map((l) => l.tool_name)]);
  const porNome = new Map(catalogo.map((c) => [c.name, c]));

  const resultado: CapacidadeComUso[] = [];
  for (const name of nomes) {
    const uso = usoPorNome.get(name);
    const ligada = ligadasSet.has(name);
    const conhecida = porNome.get(name);
    const sinal = classificar(ligada, uso, configuracaoRecente);
    const total = uso?.total ?? 0;
    const falhas = uso?.falhas ?? 0;
    const emTeste = uso?.em_teste ?? 0;

    resultado.push({
      name,
      // Capacidade que saiu do catálogo entre a configuração e agora: mostrar o
      // id cru é feio, mas sumir com a linha esconderia uso real do agente.
      rotulo: conhecida?.rotulo ?? name,
      o_que_toca: conhecida?.o_que_toca ?? "Capacidade removida do sistema",
      risco: conhecida?.risco ?? "atencao",
      ligada,
      total,
      falhas,
      em_teste: emTeste,
      ultima_vez: uso?.ultima_vez ?? null,
      sinal,
      recomendacao: recomendar(
        sinal,
        { total, falhas, em_teste: emTeste },
        janelaEmDias,
      ),
    });
  }

  return resultado.sort((a, b) => {
    const porGravidade = GRAVIDADE[a.sinal] - GRAVIDADE[b.sinal];
    if (porGravidade !== 0) return porGravidade;
    if (b.total !== a.total) return b.total - a.total;
    return a.rotulo.localeCompare(b.rotulo, "pt-PT");
  });
}

/** O resumo de uma linha só, para o topo do painel. */
export function resumirUso(capacidades: ReadonlyArray<CapacidadeComUso>): {
  usos: number;
  falhas: number;
  precisam_de_atencao: number;
} {
  return {
    usos: capacidades.reduce((acc, c) => acc + c.total, 0),
    falhas: capacidades.reduce((acc, c) => acc + c.falhas, 0),
    // `recem_ligada` fica de fora de propósito: ela não pede decisão nenhuma.
    precisam_de_atencao: capacidades.filter(
      (c) => c.sinal === "so_falha" || c.sinal === "falhando" || c.sinal === "nunca_usada",
    ).length,
  };
}
