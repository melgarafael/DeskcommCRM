/**
 * Quando preencher o e-mail do convidado — e quando NÃO tocar nele.
 *
 * O endereço já existe em `contacts.email`, e o campo nascia vazio: quem marcava
 * redigitava o que o CRM já sabia.
 *
 * ## O cuidado que decide o desenho
 *
 * Ele é o AVESSO do defeito do cliente herdado. Naquele, o painel abria com o
 * cliente da abertura anterior e marcava compromisso no nome de outra pessoa.
 * Aqui o risco é escrever por cima do endereço que alguém digitou de propósito
 * — e essa pessoa só descobriria depois do convite enviado, para o endereço
 * errado.
 *
 * Por isso existe `tocado`, e não basta olhar se o campo está vazio: "vazio
 * porque ninguém mexeu" e "vazio porque alguém APAGOU" são estados diferentes,
 * e insistir contra uma decisão explícita é pior que nunca ter preenchido.
 */
export function emailDoConvidadoAoTrocarDeCliente({
  atual,
  tocado,
  emailDoCliente,
}: {
  /** O que está no campo agora. */
  atual: string;
  /** Alguém digitou ou apagou nele nesta abertura do painel? */
  tocado: boolean;
  /** O e-mail do cliente recém-escolhido, quando ele tem um. */
  emailDoCliente: string | null | undefined;
}): string {
  // Decisão de gente manda, sempre — inclusive quando o cliente novo tem e-mail,
  // e inclusive quando a decisão foi deixar em branco.
  if (tocado) return atual;
  return emailDoCliente ?? "";
}
