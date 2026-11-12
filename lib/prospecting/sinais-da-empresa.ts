/**
 * OS SINAIS PÚBLICOS DA EMPRESA, como LINHAS do prompt da 1ª mensagem (#4459).
 *
 * ## O defeito que isto conserta
 *
 * A descoberta já trazia cinco sinais por empresa — veredito do site, nota do
 * Google, NÚMERO de avaliações, redes sociais e telefone —, mas o montador do
 * prompt mandava só três deles (`Avaliação` com a nota nua, `Redes` com URLs
 * cruas, `Auditoria` com o veredito do site). O número de avaliações e o tipo de
 * telefone nunca chegavam ao modelo, e a instrução do ramo frio proibia citar
 * qualquer coisa além de `Auditoria`: numa empresa SEM site — o caso mais comum
 * em negócio local — o material citável era só "não tem site", e a mensagem
 * saía genérica e parecida com as outras da campanha. Mensagem fria parecida em
 * sequência é o que mais leva a denúncia e a banimento de número.
 *
 * ## As três regras que este módulo respeita
 *
 * 1. **Fato coletado, com a ORIGEM no rótulo.** Cada linha se chama pelo lugar
 *    de onde veio (`Ficha do Google`, `Redes`, `Telefone`), e não por uma
 *    conclusão nossa: o texto que o modelo escrever depois pode ser auditado
 *    contra o dado que o sustentou.
 * 2. **Ausência não vira afirmação.** Sem nota, sem avaliações, sem rede ou sem
 *    telefone reconhecível, a linha simplesmente NÃO existe. "Sem avaliações" é
 *    uma afirmação sobre o mundo; `reviews: null` é só ausência no nosso dado —
 *    e é por isso que nada aqui escreve a negativa.
 * 3. **Nada de número inventado.** Tudo sai de `rating`, `reviews`, `socials`,
 *    `phone` e do veredito de WhatsApp que a descoberta já gravou. Este módulo é
 *    puro: mesma entrada, mesma saída, sem rede e sem modelo.
 */

/** O que a descoberta sabe da empresa além do site (tudo opcional). */
export interface DadosDaFicha {
  rating?: number | null;
  reviews?: number | null;
  socials?: string[] | null;
  /** E.164, como `normalizeProspectPhone` grava. */
  phone?: string | null;
  /** Veredito do canal: o número tem WhatsApp (`Prospect.whatsapp`). */
  whatsapp?: { existe: boolean; verificado_em: string } | null;
}

/** Nota do Google em texto pt-BR: `4.9` → `4,9` (uma casa, sempre). */
function notaEmTexto(nota: number): string {
  return nota.toFixed(1).replace(".", ",");
}

/** `37 avaliações` / `1 avaliação`. */
function avaliacoesEmTexto(total: number): string {
  return `${total} ${total === 1 ? "avaliação" : "avaliações"}`;
}

/**
 * A ficha do Google como UMA frase de fato: "nota 4,9 com 37 avaliações".
 *
 * As duas metades são opcionais e independentes — o provedor devolve nota sem
 * contagem e contagem sem nota. O que não veio não é escrito.
 */
export function fichaDoGoogle(dados: DadosDaFicha): string | null {
  const nota = typeof dados.rating === "number" ? notaEmTexto(dados.rating) : null;
  const total =
    typeof dados.reviews === "number" && Number.isFinite(dados.reviews)
      ? avaliacoesEmTexto(dados.reviews)
      : null;
  if (nota && total) return `nota ${nota} com ${total}`;
  if (nota) return `nota ${nota}`;
  if (total) return total;
  return null;
}

/**
 * O nome da rede a partir da URL publicada na ficha.
 *
 * O modelo precisa do NOME para poder dizer "vi o Instagram de vocês"; uma URL
 * crua entre parênteses ele copia ou ignora. Só os domínios que a descoberta
 * grava (`socials`: Instagram, Facebook, LinkedIn) têm nome aqui; qualquer outro
 * sai como está, sem rótulo inventado.
 */
export function nomeDaRede(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host.endsWith("instagram.com")) return "Instagram";
  if (host.endsWith("facebook.com") || host.endsWith("fb.com")) return "Facebook";
  if (host.endsWith("linkedin.com")) return "LinkedIn";
  if (host.endsWith("tiktok.com")) return "TikTok";
  if (host.endsWith("youtube.com") || host.endsWith("youtu.be")) return "YouTube";
  return null;
}

/** As redes como "Instagram: <url>; Facebook: <url>" — só as que existem. */
export function redesComNome(dados: DadosDaFicha): string | null {
  const redes = (dados.socials ?? [])
    .map((url) => {
      const nome = nomeDaRede(url);
      return nome ? `${nome}: ${url}` : url;
    })
    .filter((linha) => linha.trim() !== "");
  return redes.length > 0 ? redes.join("; ") : null;
}

/**
 * O telefone é celular ou fixo, pela régua NACIONAL (E.164 brasileiro).
 *
 * `+55` + DDD + 9 dígitos é celular; `+55` + DDD + 8 dígitos é fixo — a mesma
 * leitura de `lib/schemas/contacts.ts` ("local de 8 dígitos é fixo"). Número de
 * outro país devolve `null`: o comprimento não diz o tipo lá fora, e chutar
 * "celular" num fixo de Portugal é a classe de erro que este módulo evita.
 */
export function tipoDeTelefone(phone: string | null | undefined): "celular" | "fixo" | null {
  const digitos = (phone ?? "").replace(/\D/g, "");
  if (!digitos.startsWith("55")) return null;
  if (digitos.length === 13) return "celular";
  if (digitos.length === 12) return "fixo";
  return null;
}

/** `2026-11-12T…` → `12/11/2026`, a mesma data legível do campo `Auditoria`. */
function dataLegivel(iso: string): string {
  return iso.slice(0, 10).split("-").reverse().join("/");
}

/**
 * A linha do telefone — com o WhatsApp quando o CANAL já conferiu o número.
 *
 * O tipo sozinho já é material ("só telefone fixo" é ângulo de conversa em
 * negócio local); o veredito de WhatsApp acrescenta o que foi MEDIDO, com a
 * data. Sem veredito, sai só o tipo — nunca "sem WhatsApp" por suposição.
 */
export function linhaDoTelefone(dados: DadosDaFicha): string | null {
  const tipo = tipoDeTelefone(dados.phone);
  if (!tipo) return null;
  const veredito = dados.whatsapp;
  if (!veredito) return tipo;
  const quando = dataLegivel(veredito.verificado_em);
  return `${tipo} — ${veredito.existe ? "com WhatsApp" : "sem WhatsApp"} (conferido em ${quando})`;
}

/**
 * As linhas que o prompt recebe, por rótulo de ORIGEM. Vazio quando a ficha não
 * trouxe nada — e aí o prompt manda abrir pela rotina do negócio, sem fingir
 * que pesquisou (`blocoDeModo`, ramo frio).
 */
export function sinaisDaEmpresa(dados: DadosDaFicha): Record<string, string> {
  const sinais: Record<string, string> = {};
  const ficha = fichaDoGoogle(dados);
  if (ficha) sinais["Ficha do Google"] = ficha;
  const redes = redesComNome(dados);
  if (redes) sinais["Redes"] = redes;
  const telefone = linhaDoTelefone(dados);
  if (telefone) sinais["Telefone"] = telefone;
  return sinais;
}
