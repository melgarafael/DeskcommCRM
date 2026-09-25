import { linksParaExibir } from "@/lib/leads/links-de-contato";
import type { Lead } from "@/lib/types/leads";

type DadosDoContato = Pick<Lead, "contact_phone" | "contact_email" | "contact_links">;

/** A linha de `contacts` como o quadro a lê — as colunas que esta regra usa. */
export interface LinhaDoContatoNoQuadro {
  id: string;
  phone_number: string | null;
  email: string | null;
  custom_fields: Record<string, unknown> | null;
  is_anonymized: boolean | null;
}

/**
 * Anexa telefone, e-mail e links do CONTATO aos leads do quadro — o que o card
 * do funil mostra sem abrir o dossiê.
 *
 * PURA de propósito: recebe as linhas de contato que a etapa dos marcadores já
 * leu (`withMarcadoresDoContato`, na rota do quadro) em vez de consultar o
 * banco de novo. Uma leitura de `contacts` por quadro, não duas — e a regra
 * fica testável sem banco, já que um `route.ts` do Next só pode exportar os
 * métodos HTTP.
 *
 * Contato anonimizado (LGPD) é PULADO, mesmo que a linha ainda carregue algum
 * valor: o quadro é a superfície com mais exposição do produto, e "apagado a
 * pedido do titular" não pode reaparecer num card.
 *
 * Vazio não vira campo: só se escreve o que existe, para o payload não engordar
 * com três chaves nulas em todo card. Negócio sem contato (ou contato que não
 * veio na leitura) passa intacto — o card dele não pode sumir.
 */
export function anexarDadosDoContato(leads: Lead[], contatos: LinhaDoContatoNoQuadro[]): Lead[] {
  const porContato = new Map<string, DadosDoContato>();
  for (const contato of contatos) {
    if (contato.is_anonymized) continue;
    const links = linksParaExibir(contato.custom_fields);
    const dados: DadosDoContato = {
      ...(contato.phone_number ? { contact_phone: contato.phone_number } : {}),
      ...(contato.email ? { contact_email: contato.email } : {}),
      ...(links.length > 0 ? { contact_links: links } : {}),
    };
    if (Object.keys(dados).length > 0) porContato.set(contato.id, dados);
  }
  if (porContato.size === 0) return leads;

  return leads.map((lead) => {
    const dados = lead.contact_id ? porContato.get(lead.contact_id) : undefined;
    return dados ? { ...lead, ...dados } : lead;
  });
}
