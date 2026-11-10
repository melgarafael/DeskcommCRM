/**
 * O cabeçalho `From:` com nome de exibição — um lugar só para os dois
 * transportes (`resend.ts` e `smtp.ts`).
 *
 * O nome vem de campo de tela (marca da instalação, da organização, nome do
 * remetente do SMTP), então é texto livre. Na RFC 5322 o nome de exibição é uma
 * `phrase`: os caracteres especiais (`( ) [ ] : ; @ , . \ "`) e os `< >` mudam a
 * leitura do cabeçalho — viram outra caixa, um grupo, um comentário. Por isso:
 *
 *   - caractere de controle e quebra de linha viram espaço (não se emenda cabeçalho);
 *   - `< > " \` saem (aspas e barra são as duas coisas que encerrariam a quoted-string);
 *   - o resto vai ENTRE ASPAS quando há especial, e sem aspas quando não há — então
 *     "Loja da Ana" sai exatamente como antes, e "Silva, Lima Advogados" continua
 *     sendo um nome só;
 *   - acento fica: quem codifica para o fio é o transporte.
 *
 * Nome que esvazia na limpeza sai como endereço puro. Nunca lança: quem chama
 * isto é e-mail de LGPD com prazo legal.
 */
const LIMITE_DO_NOME = 78;

export function remetenteComNome(endereco: string, nome?: string): string {
  const limpo = Array.from(
    (nome ?? "")
      .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
      .replace(/[<>"\\]/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, LIMITE_DO_NOME)
    .join("")
    .trim();
  if (limpo.length === 0) return endereco;
  return /[()[\]:;@,.]/.test(limpo) ? `"${limpo}" <${endereco}>` : `${limpo} <${endereco}>`;
}
