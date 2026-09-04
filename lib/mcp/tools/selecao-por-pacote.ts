/**
 * A regra de quais capacidades um pacote liga e desliga.
 *
 * Mora fora do componente de propósito. A tela é onde a regra some: um
 * `onChange` com três condições aninhadas passa no review, roda no browser e
 * nunca é exercitada por teste. Aqui é função pura sobre listas de `name` —
 * o `ToolPicker` só chama e renderiza o resultado.
 *
 * Client-safe: zero import de zod, supabase ou next/headers.
 *
 * A regra que justifica o módulo inteiro: **capacidade `critico` nunca entra
 * por pacote** (`entraPorPacote`). Ligar "Atender e responder" não pode, num
 * clique, dar ao agente o direito de mandar WhatsApp para o cliente de verdade.
 */
import { entraPorPacote, type ToolBundle, type ToolRisk } from "./pacotes";

/**
 * Teto de capacidades por agente. Não é burrice de produto: 60 tools num
 * prompt degradam a escolha do modelo (erra a tool, gasta contexto, alucina
 * argumento). `lib/ai/agents/validation.ts` importa daqui para que o número
 * exista em UM lugar — o mesmo teto que a tela mostra é o que o servidor
 * recusa.
 */
export const TETO_TOOLS_POR_AGENTE = 20;

/** O mínimo que a regra precisa saber de uma capacidade. */
export interface CapacidadeSelecionavel {
  name: string;
  risco: ToolRisk;
  pacotes: ReadonlyArray<ToolBundle>;
}

export type EstadoPacote = "ligado" | "parcial" | "desligado";

function doPacote(
  catalogo: ReadonlyArray<CapacidadeSelecionavel>,
  pacote: ToolBundle,
): CapacidadeSelecionavel[] {
  return catalogo.filter((c) => c.pacotes.includes(pacote));
}

/** As que o toggle do pacote liga sozinho — tudo que não é `critico`. */
export function capacidadesAutomaticasDoPacote(
  catalogo: ReadonlyArray<CapacidadeSelecionavel>,
  pacote: ToolBundle,
): string[] {
  return doPacote(catalogo, pacote)
    .filter((c) => entraPorPacote(c.risco))
    .map((c) => c.name);
}

/** As que exigem marcação individual do humano — as `critico` do pacote. */
export function capacidadesCriticasDoPacote(
  catalogo: ReadonlyArray<CapacidadeSelecionavel>,
  pacote: ToolBundle,
): string[] {
  return doPacote(catalogo, pacote)
    .filter((c) => !entraPorPacote(c.risco))
    .map((c) => c.name);
}

/**
 * "ligado" só quando TODAS as automáticas do pacote estão marcadas. Um pacote
 * sem nenhuma capacidade automática (só críticas, ou vazio) nunca fica ligado —
 * senão a tela anunciaria como ativa uma jornada que não deu nada ao agente.
 */
export function estadoDoPacote(
  selecionadas: ReadonlyArray<string>,
  catalogo: ReadonlyArray<CapacidadeSelecionavel>,
  pacote: ToolBundle,
): EstadoPacote {
  const automaticas = capacidadesAutomaticasDoPacote(catalogo, pacote);
  if (automaticas.length === 0) return "desligado";

  const marcadas = automaticas.filter((n) => selecionadas.includes(n));
  if (marcadas.length === 0) return "desligado";
  return marcadas.length === automaticas.length ? "ligado" : "parcial";
}

/** Liga o pacote: acrescenta as automáticas que faltam, preserva o resto. */
export function ligarPacote(
  selecionadas: ReadonlyArray<string>,
  catalogo: ReadonlyArray<CapacidadeSelecionavel>,
  pacote: ToolBundle,
): string[] {
  const atual = new Set(selecionadas);
  for (const name of capacidadesAutomaticasDoPacote(catalogo, pacote)) {
    atual.add(name);
  }
  // Ordem do catálogo, não ordem de clique: a lista salva vira diff de versão
  // do agente, e diff que muda de ordem a cada clique é diff ilegível.
  return catalogo.map((c) => c.name).filter((n) => atual.has(n));
}

/**
 * Desliga o pacote — inclusive as `critico` dele.
 *
 * A crítica foi marcada à mão, mas desligar "Atender e responder" e manter o
 * agente com direito de enviar WhatsApp é a pior surpresa possível: o humano
 * declarou que aquela jornada acabou. Falha fechado.
 *
 * O que sobrevive é o que pertence a OUTRO pacote que continua ligado — senão
 * desligar um pacote esvaziaria pela metade um pacote vizinho que o humano não
 * tocou.
 */
export function desligarPacote(
  selecionadas: ReadonlyArray<string>,
  catalogo: ReadonlyArray<CapacidadeSelecionavel>,
  pacote: ToolBundle,
  todosOsPacotes: ReadonlyArray<ToolBundle>,
): string[] {
  const sobrevivem = new Set<string>();
  for (const outro of todosOsPacotes) {
    if (outro === pacote) continue;
    if (estadoDoPacote(selecionadas, catalogo, outro) !== "ligado") continue;
    for (const capacidade of doPacote(catalogo, outro)) sobrevivem.add(capacidade.name);
  }

  const aRemover = new Set(doPacote(catalogo, pacote).map((c) => c.name));
  return selecionadas.filter((n) => !aRemover.has(n) || sobrevivem.has(n));
}

/**
 * Quantas vagas ligar este pacote REALMENTE exige — contando as críticas dele.
 *
 * ## Por que as críticas entram na conta (issue #162)
 *
 * O contrato do pacote é "eu ligo as seguras e DEIXO as críticas para você
 * marcar à mão" — a tela diz isso com todas as letras ("o pacote não liga por
 * você"). Se as automáticas do pacote encostam no teto, a crítica que ele
 * deliberadamente deixou de fora fica com o checkbox **desabilitado**: o pacote
 * prometeu uma escolha que o produto não permite fazer.
 *
 * O número exato por pacote muda toda vez que o catálogo ganha ou perde
 * capacidade — não hardcode aqui; `tests/unit/pacote-reserva-vaga-da-critica.test.ts`
 * mede isso de verdade a cada rodada e é a fonte confiável. O que importa
 * para o design: nenhum pacote sozinho estoura o teto de 20, mas um pacote
 * SOMADO ao que já estava ligado pode chegar perto ou passar — foi assim que
 * a crítica nascia morta antes desta função existir (issue #162).
 *
 * Reservar é o que mantém o contrato de pé: ou o pacote cabe inteiro — com a
 * vaga da crítica guardada — ou ele não liga, e a tela diz quantas vagas faltam.
 * A alternativa era ligar e deixar um checkbox morto sem explicação, que é o
 * defeito que a #162 nomeia.
 */
export function vagasExigidasPeloPacote(
  selecionadas: ReadonlyArray<string>,
  catalogo: ReadonlyArray<CapacidadeSelecionavel>,
  pacote: ToolBundle,
): number {
  const depois = new Set(ligarPacote(selecionadas, catalogo, pacote));
  for (const name of capacidadesCriticasDoPacote(catalogo, pacote)) depois.add(name);
  return depois.size;
}

export function vagasRestantes(selecionadas: ReadonlyArray<string>): number {
  return TETO_TOOLS_POR_AGENTE - selecionadas.length;
}

export function excedeuTeto(selecionadas: ReadonlyArray<string>): boolean {
  return selecionadas.length > TETO_TOOLS_POR_AGENTE;
}

/**
 * O texto que o humano lê embaixo do nome da jornada.
 *
 * Vive aqui, e não inline no JSX, por um motivo concreto: o caso "pacote sem
 * capacidade nenhuma" foi coberto por E2E enquanto o pacote `reter` estava
 * vazio, e deixou de ser alcançável pela tela quando o épico o preencheu. Um
 * E2E que depende de catálogo vazio não descreve instalação real — mas o
 * caminho continua existindo no componente, e some da cobertura se ninguém o
 * segurar aqui.
 */
export function textoDaContagem(
  totalDoPacote: number,
  ligadas: number,
): string {
  if (totalDoPacote === 0) return "Nenhuma capacidade disponível ainda para esta jornada.";
  // O particípio concorda junto com o substantivo. Separá-los deixava
  // "1 de 1 capacidade ligadas" — latente hoje (o menor pacote tem 2), visível
  // no dia em que um pacote ficar com uma só, inclusive num fork que remova
  // capacidades.
  const trecho = totalDoPacote === 1 ? "capacidade ligada" : "capacidades ligadas";
  return `${ligadas} de ${totalDoPacote} ${trecho}`;
}
