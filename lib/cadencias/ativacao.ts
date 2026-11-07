import { todosOsPassos } from "./arvore";
import { configuracaoDaCadenciaSchema } from "./schemas";
import type { Cadencia } from "./tipos";
/** Só libera o que tem consumidor real. Dados antigos continuam legíveis. */
export function problemasParaAtivar(c: Pick<Cadencia, "configuracao" | "passos">, t: (texto: string) => string = (texto) => texto): string[] {
  const out: string[] = [];
  const passos = todosOsPassos(c.passos);
  if (!passos.some((p) => p.tipo === "email")) out.push(t("A cadência precisa de pelo menos um e-mail."));
  if (!configuracaoDaCadenciaSchema.safeParse(c.configuracao).success || c.configuracao.janela.inicio >= c.configuracao.janela.fim || c.configuracao.janela.dias.length === 0) out.push(t("Revise os dias, horários e o fuso da janela de envio."));
  if (passos.some((p) => p.tipo === "whatsapp" || (p.tipo === "ramo" && p.condicao.tipo !== "abriu"))) out.push(t("WhatsApp, cliques e respostas ainda não têm execução neste módulo. Retire esses passos antes de ativar."));
  if (c.configuracao.somenteEmailValidado || c.configuracao.caixaPadraoId !== null || c.configuracao.paradas.respondeu || c.configuracao.paradas.bounce || !c.configuracao.paradas.descadastro) out.push(t("Use o transporte da instalação e o descadastro obrigatório. Caixas próprias, validação externa e parada por resposta ou devolução ainda não estão disponíveis."));
  return out;
}
