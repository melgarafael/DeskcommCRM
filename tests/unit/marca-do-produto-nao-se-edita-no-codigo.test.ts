/**
 * A marca padrão do produto é UM valor, e ele não se troca editando código.
 *
 * POR QUE ESTE ARQUIVO EXISTE — medido no PR #465 (2026-09-01). Um contribuidor
 * que instalou o CRM para o próprio cliente personalizou a marca do jeito que
 * achou: trocou `DEFAULT_APP_NAME` em `lib/branding.ts`. Depois abriu um PR a
 * partir do `main` do fork dele, e a personalização veio junto — proposta como
 * mudança do produto, para todo mundo.
 *
 * O que torna essa classe cara não é a intenção (não havia nenhuma): é que ela
 * chega em SILÊNCIO. Medido na prévia do merge daquele PR (`git merge-tree
 * --write-tree origin/main <sha>`): dos sete arquivos que carregavam a marca de
 * fora, SEIS entraram sem um único conflito — `lib/branding.ts` inclusive, porque
 * a `main` não tinha tocado nele. E a suíte ficava VERDE, porque os três testes
 * que fixavam o literal (`branding-marca-resolve`, `branding-saida` e o
 * `prefixoDoArquivo` daqui de `branding.test.ts`) foram atualizados no mesmo PR,
 * de boa-fé, para casar com o novo nome. Pino que mora no arquivo que o
 * fork-sync naturalmente edita não é pino: é eco.
 *
 * Então este arquivo não acrescenta rigor — acrescenta um NOME e uma MENSAGEM.
 * Quando alguém trocar a identidade do produto, em vez de três testes sem
 * parentesco ficando vermelhos em três arquivos diferentes, fica vermelho UM,
 * chamado pelo que protege, dizendo qual é o caminho suportado. O gargalo
 * medido deste repositório é contribuidor esbarrando em regra que ninguém
 * contou; um gate que ensina vale mais que um gate que só reprova.
 *
 * ESCOPO — o que este arquivo NÃO cobre, dito em voz alta para ninguém o ler
 * como proteção maior do que é:
 *
 *  - Ele não impede a edição. Nada impede: um PR que muda o valor pode mudar
 *    esta linha junto. O que ele garante é que a mudança seja DELIBERADA e
 *    legível no diff, em vez de carona em 56 arquivos.
 *  - Ele não varre marca ESTRANGEIRA. A varredura de `tests/unit/branding.test.ts`
 *    procura `/deskcomm/i` — ela vê a marca da casa saindo, nunca a de fora
 *    entrando. Uma marca qualquer hardcoded num `.tsx` continua invisível.
 *  - `app/design/` é pulado por aquela varredura (`branding.test.ts`, a linha
 *    `if (rel.startsWith("app/design")) continue`), e o showcase renderiza o
 *    nome do produto em três títulos. Foi por ali que a marca de fora passou sem
 *    encostar em gate nenhum. Fechar isso pede entrada na allowlist para cada
 *    ocorrência do showcase, e é dívida com issue própria — não deste arquivo.
 *
 * O caminho SUPORTADO de marca própria está em `docs/white-label.md`: o banco
 * (`platform_branding`, `organizations.settings.branding`) manda, e `APP_NAME`
 * no `.env` é a semente que o `install.sh` pergunta. Uma imagem Docker serve
 * todas as marcas — é por isso que a constante daqui é o PADRÃO do produto, e
 * não o lugar de configurar a sua.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_APP_NAME, resolveBranding } from "@/lib/branding";

/**
 * O nome do produto, escrito por extenso e uma única vez. Está aqui, e não
 * importado de `lib/branding`, de propósito: um teste que compara a constante
 * com ela mesma passa sempre.
 */
const MARCA_DO_PRODUTO = "DeskcommCRM";

const COMO_PERSONALIZAR =
  "Para personalizar a marca da SUA instalação, não edite esta constante: " +
  "use APP_NAME no .env (o install.sh pergunta), a tela Configurações › Marca, " +
  "ou platform_branding no banco. Ver docs/white-label.md. " +
  "Editar lib/branding.ts troca o padrão do PRODUTO, para todas as instalações, " +
  "e some com a sua marca no próximo `git pull`.";

describe("a marca padrão do produto", () => {
  it("é DeskcommCRM — e trocá-la aqui é mudar o produto, não a sua instalação", () => {
    expect(DEFAULT_APP_NAME, COMO_PERSONALIZAR).toBe(MARCA_DO_PRODUTO);
  });

  it("é o que aparece quando o operador não configurou marca nenhuma", () => {
    // O caminho que o usuário final vê: sem nada configurado, `resolveBranding`
    // devolve o padrão, e a inicial do ícone sai dele. Fixar os dois juntos é o
    // que impede a troca de passar por "só uma constante interna" — ela chega no
    // manifest do PWA, no favicon, no remetente de e-mail e no issuer do MFA.
    expect(resolveBranding(undefined, undefined), COMO_PERSONALIZAR).toEqual({
      name: MARCA_DO_PRODUTO,
      logoUrl: null,
      initial: "D",
    });
  });
});
