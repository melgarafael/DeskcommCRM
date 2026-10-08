/**
 * O nome que o dono do número GRAVOU no celular — não o apelido do perfil.
 *
 * O webhook só traz o apelido (`pushName`). Quem está salvo na agenda e não
 * pôs nome no perfil chega na inbox como telefone. A agenda mora no canal;
 * esta função só decide o que dessa resposta é nome de gente, e em que ordem
 * perguntar (o celular brasileiro tem duas grafias, e a agenda pode estar
 * em qualquer uma das duas).
 */

import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import { ehIdentificadorTecnico, nomeDoContato } from "@/lib/contacts/rotulo-do-contato";

/** Quanto esperar para perguntar de novo a quem continuou sem nome. */
export const REVISITA_NOME_MS = 6 * 60 * 60 * 1000;

const TETO_DO_NOME = 200;

export interface LeituraDeContato {
  name: string | null;
  pushname: string | null;
  shortName: string | null;
}

export interface NomeAchado {
  agenda: string | null;
  perfil: string | null;
}

/** Nome de gente, ou null. Identificador técnico e telefone nu não entram. */
export function nomeGravavel(bruto: string | null | undefined): string | null {
  const v = (bruto ?? "").trim().slice(0, TETO_DO_NOME);
  if (v === "" || ehIdentificadorTecnico(v)) return null;
  // `+55 62 98448-0025` não cai em `ehIdentificadorTecnico` (esse só recusa
  // dígitos puros). Na agenda, um "nome" que é só o número não é nome.
  const soDigitos = v.replace(/\D/g, "");
  if (soDigitos.length >= 8 && soDigitos.length <= 15 && v.replace(/[\d+\s().-]/g, "") === "") {
    return null;
  }
  return v;
}

/**
 * Onde perguntar, nesta ordem: as duas grafias do celular (com e sem o nono),
 * depois o identificador opaco. A agenda do aparelho é indexada pelo número,
 * não pelo id opaco — por isso o telefone vem primeiro.
 */
export function idsParaConsultarAgenda(phone: string | null, lid: string | null): string[] {
  const ids: string[] = [];
  const vistos = new Set<string>();
  const por = (id: string) => {
    if (vistos.has(id)) return;
    vistos.add(id);
    ids.push(id);
  };
  if (phone) {
    for (const variante of phoneLookupVariants(phone)) {
      const digitos = variante.replace(/\D/g, "");
      if (digitos.length >= 8) por(`${digitos}@c.us`);
    }
  }
  if (lid && /^\d{5,40}$/.test(lid)) por(`${lid}@lid`);
  return ids;
}

/**
 * Pergunta cada id até achar nome de agenda. `null` do leitor é "não respondeu"
 * e não encerra a lista — a outra grafia do nono dígito pode ser a que a
 * agenda conhece. `respondeu` separa "o canal calou" de "o canal disse que
 * não tem nome".
 */
export async function consultarNomeDaAgenda(
  ler: (contactId: string) => Promise<LeituraDeContato | null>,
  phone: string | null,
  lid: string | null,
): Promise<NomeAchado & { respondeu: boolean }> {
  const ids = idsParaConsultarAgenda(phone, lid);
  let perfil: string | null = null;
  let respondeu = false;
  for (const id of ids) {
    const lido = await ler(id);
    if (!lido) continue;
    respondeu = true;
    const agenda = nomeGravavel(lido.name) ?? nomeGravavel(lido.shortName);
    const apelido = nomeGravavel(lido.pushname);
    if (!perfil && apelido) perfil = apelido;
    if (agenda) return { agenda, perfil: perfil ?? apelido, respondeu: true };
  }
  return { agenda: null, perfil, respondeu };
}

/**
 * O que gravar. A agenda entra em `address_book_name`, o campo que SÓ A EQUIPE
 * vê — nunca em `name` nem em `display_name`. O nome da agenda é o rótulo que
 * alguém da empresa escreveu no celular ("João obra", "Maria caloteira"), e
 * `name`/`display_name` são o que o `{{nome}}` das automações e das campanhas
 * lê: gravado ali, o apelido interno chegaria ao cliente numa saudação
 * (decisão do mantenedor no PR #2439). Para usar o nome numa mensagem, alguém
 * o copia para o nome principal na ficha.
 *
 * O apelido do perfil só preenche `display_name` quando a tela hoje não tem
 * nome nenhum — é o mesmo dado que o webhook já grava ali. Nome já digitado no
 * CRM não é tocado.
 */
export function patchDoNome(
  atual: { name: string | null; display_name: string | null },
  achado: NomeAchado,
): { address_book_name?: string; display_name?: string } {
  if ((atual.name ?? "").trim() !== "") return {};
  if (achado.agenda) return { address_book_name: achado.agenda };
  if (!nomeDoContato(atual) && achado.perfil) return { display_name: achado.perfil };
  return {};
}
