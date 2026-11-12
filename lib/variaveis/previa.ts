/**
 * OS VALORES DE EXEMPLO DA PRÉVIA — dado, não tela.
 *
 * A prévia do seletor mostra a frase já resolvida com um contato de mentira, para
 * o operador ver o EFEITO da variável antes de salvar. Usa o MESMO resolvedor da
 * tela: se a variável não existe naquela fonte, a prévia mostra `{{x}}` — que é
 * exatamente o que o cliente receberia.
 *
 * O contato daqui é genérico de propósito ("Ana Souza", loja de exemplo): nenhum
 * dado real de cliente entra em prévia, e ninguém precisa escolher um contato
 * para ver o exemplo.
 */
import { resolverVariaveis, type ContextoDeVariaveis } from "./resolvedor";
import type { Resolvedor } from "./catalogo";

export const CONTEXTO_DE_EXEMPLO: ContextoDeVariaveis = {
  nome: "Ana Souza",
  saudacao: "Boa tarde",
  telefone: "+5511999998888",
  email: "ana@exemplo.com",
  contact: { name: "Ana Souza" },
  lead: {
    title: "Plano Pro",
    custom_fields: { servico: "Site institucional", gancho: "do site" },
  },
  camposDoNegocio: { servico: "Site institucional", gancho: "do site" },
  camposDoContato: { link_previa: "https://loja.exemplo/previa/ana" },
};

/** A frase como ela sairia para o contato de exemplo, nesta fonte. */
export function previaDoTexto(texto: string, fonte: Resolvedor): string {
  return resolverVariaveis(texto, CONTEXTO_DE_EXEMPLO, {
    fonte,
    quandoVazio: "literal",
  }).texto;
}
