/**
 * O idioma da interface — o mínimo que faz a escolha SIGNIFICAR alguma coisa.
 *
 * ─── O que existia antes ───────────────────────────────────────────────────
 *
 * Um seletor de idioma no perfil, salvo em `user_metadata.locale`, que NINGUÉM
 * lia. Medido: nenhuma biblioteca de i18n instalada, nenhuma pasta de tradução,
 * nenhum consumidor do campo. Escolher "English (US)" não mudava uma letra.
 *
 * Isso é pior que não ter a opção: o operador escolhe, nada acontece, e ele
 * conclui que o sistema está quebrado — a mesma classe do rodapé que mostra uma
 * versão que não é a que roda.
 *
 * ─── Por que dicionário próprio, e não uma biblioteca ──────────────────────
 *
 * As bibliotecas de i18n do App Router pedem o idioma no CAMINHO da URL
 * (`/es/app/inbox`), o que mexeria em TODA rota do produto — links salvos,
 * webhooks, redirects, testes e2e. Risco enorme para uma tradução parcial.
 *
 * Aqui o idioma vem de quem está logado e o texto é resolvido em memória. Nada
 * de rota muda, e a tradução pode crescer tela a tela sem nenhuma migração.
 *
 * ─── Já foi parcial. Não é mais, e agora há um guarda dizendo isso ─────────
 *
 * Esta seção dizia, com números, que a tradução cobria "o que a equipe usa todo
 * dia — inbox, kanban, contatos, conexões" e que o resto seguia em português.
 * Era verdade quando foi escrita e venceu: o PR #352 cobriu IA e Admin, e o
 * passe seguinte fechou Agenda, Desempenho, Radar e Respostas rápidas.
 *
 * O que substitui a frase não é outro número — números envelhecem calados. É um
 * guarda: `tests/unit/i18n-espanhol-cobre-a-tela` varre o AST de toda tela e
 * reprova prosa portuguesa que não passe por `t()`, mais toda chave usada sem
 * tradução. Para saber o estado agora, rode-o; ele não tem como estar
 * desatualizado.
 *
 * A cobertura de TEXTO é completa. A de DATA não: `locale: ptBR` é passado à
 * mão em dezenas de arquivos, e trocar isso é um passe próprio. A ressalva está
 * no cabeçalho do guarda, com o comando que a re-mede.
 *
 * ─── De onde vem o idioma de quem está olhando ─────────────────────────────
 *
 * Não é só do perfil. A cadeia é `preferência da pessoa → idioma da organização
 * → padrão`, resolvida em `lib/auth/server.ts` e entregue pronta em
 * `AuthUser.idioma`. É o elo do meio que faz o idioma escolhido no instalador
 * alcançar quem entra depois e nunca abriu o próprio perfil.
 */

import { IDIOMAS_VISIVEIS, type IdiomaVisivel } from "./registro";

/**
 * Os códigos que a interface serve. Derivados do registro (`./registro`): um
 * idioma `em_construcao` não entra aqui, então não é aceito na gravação, não é
 * servido na leitura e não é oferecido em tela nenhuma.
 */
export type Idioma = IdiomaVisivel["codigo"];
export const IDIOMAS: readonly Idioma[] = IDIOMAS_VISIVEIS.map((idioma) => idioma.codigo);

export const IDIOMA_PADRAO: Idioma = "pt-BR";

/**
 * O que veio do perfil é um idioma que sabemos servir?
 *
 * Fecha para o padrão em vez de confiar: o campo aceita qualquer string desde
 * antes desta feature (o seletor já ofereceu `en-US`, que nunca teve tradução),
 * e um valor desconhecido chegando ao dicionário devolveria a CHAVE na tela.
 */
export function normalizarIdioma(bruto: string | null | undefined): Idioma {
  return (IDIOMAS as readonly string[]).includes(bruto ?? "")
    ? (bruto as Idioma)
    : IDIOMA_PADRAO;
}

/**
 * Sinal de idioma de quem ainda não tem preferência salva: o cabeçalho
 * `Accept-Language` que o navegador manda em toda requisição.
 *
 * Não é o `normalizarIdioma` de um valor solto — aqui há uma LISTA ordenada
 * por preferência (`es-MX,es;q=0.9,en;q=0.8`), e o primeiro idioma que este
 * produto sabe servir na ordem do visitante vence, mesmo que não seja o de
 * maior `q`. Pura por design: sem `next/headers` aqui, porque este arquivo é
 * importado por componente cliente (`SeletorDeIdioma.tsx`) — quem lê o
 * cabeçalho é `idiomaDoVisitante` em `lib/i18n/idiomaAnonimo.ts`, server-only.
 */
export function parseAcceptLanguage(header: string | null | undefined): Idioma | null {
  if (!header) return null;
  const candidatos = header
    .split(",")
    .map((parte) => {
      const [tagBruta, qBruto] = parte.trim().split(";q=");
      const q = qBruto ? Number.parseFloat(qBruto) : 1;
      return { tag: tagBruta?.trim().toLowerCase() ?? "", q: Number.isFinite(q) ? q : 1 };
    })
    .filter((candidato) => candidato.tag.length > 0)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of candidatos) {
    const primario = tag.split("-")[0] ?? "";
    const servido = IDIOMAS_VISIVEIS.find((idioma) =>
      idioma.subtagsDoNavegador.some((subtag) => subtag === primario),
    );
    if (servido) return servido.codigo;
  }
  return null;
}
