/**
 * OS AVISOS DO ART. 12.º DIZEM O QUE A LEI MANDA DIZER — e o motivo não é opcional.
 *
 * ─── O defeito (#2342) ───────────────────────────────────────────────────────────────────────
 *
 * A triagem mediu que a anonimização terminava em silêncio: o pedido de exclusão era
 * cumprido, o SLA marcava D+15, e o titular não recebia NADA. O art. 12.º, n.º 3 do RGPD
 * obriga a informar depois de apagar; os n.ºs 3 e 4 obrigam a informar a recusa — ou a
 * prorrogação, com o MOTIVO — no prazo de um mês.
 *
 * ─── O texto é UM só, e é o de fora do Brasil ────────────────────────────────────────────────
 *
 * Decisão de produto de 2026-10-16: os avisos novos valem só para organizações FORA do Brasil.
 * O ramo brasileiro do texto (o antigo `mensagemDoBrasil`, com a LGPD citada artigo por artigo)
 * saiu inteiro deste módulo — o texto brasileiro fica para uma revisão própria. Quem impede uma
 * organização brasileira de chegar aqui é o worker (que não chama o aviso de apagamento) e a rota
 * do art. 12.º (que recusa antes de tocar em qualquer coisa), e os dois têm caso próprio.
 *
 * ─── O que este arquivo mede ─────────────────────────────────────────────────────────────────
 *
 *   1. o prazo de um mês é contado do recebimento, e o AVISO afirma tê-lo cumprido — mas só
 *      quando cumpriu: fora do prazo a frase muda (o e-mail não mente sobre o prazo);
 *   2. recusa e prorrogação SEM motivo LANÇAM — a rota responde 422 em vez de mandar um
 *      e-mail pela metade (`MotivoObrigatorio`);
 *   3. o texto é `pt-PT`, sem LGPD, e o rótulo da linha da lei vem do PERFIL
 *      (`lei.rotuloNoDocumento`, como no e-mail de exportação), não de um "Base legal:" fixo;
 *   4. o motivo entra ESCAPADO — o e-mail é HTML e o motivo vem do operador;
 *   5. nenhum texto carrega o nome do produto: o remetente é a marca de quem OPEROU.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { NEUTROS_DE_SAIDA, type MarcaDeSaida } from "@/lib/branding/saida";
import {
  MotivoObrigatorio,
  dentroDoPrazoDeUmMes,
  montarAvisoArt12,
  prazoDeUmMes,
  type AvisoArt12,
} from "@/lib/lgpd/avisos-do-artigo-12";
import { perfilDoPais } from "@/lib/legal/perfil-do-pais";

const MARCA: MarcaDeSaida = {
  nome: "Silva & Filhos",
  logoUrl: null,
  accent: "#2f6f4e",
  accentFg: "#ffffff",
  origens: { nome: "banco", cor: "banco" },
};

const RECEBIDO = new Date("2026-09-10T12:00:00Z");
const PRAZO = prazoDeUmMes(RECEBIDO);

/** O aviso de Portugal — o único país que chega a este módulo (ver o cabeçalho). */
function aviso(Extra: Partial<AvisoArt12> = {}): AvisoArt12 {
  return {
    desfecho: "apagamento",
    requestId: "abcd1234-ef00-4000-8000-000000000000",
    marca: MARCA,
    perfil: perfilDoPais("PT"),
    prazoDeUmMes: PRAZO,
    recebidoEm: RECEBIDO,
    // O envio acontece no dia seguinte ao recebimento: dentro do prazo, salvo
    // quando o caso diz o contrário.
    agora: new Date("2026-09-11T12:00:00Z"),
    ...Extra,
  };
}

describe("o prazo de um mês do art. 12.º", () => {
  it("é contado do recebimento, e a data de fora é a do calendário", () => {
    expect(prazoDeUmMes(new Date("2026-09-10T12:00:00Z")).toISOString()).toBe(
      "2026-10-10T12:00:00.000Z",
    );
  });

  it("um mês sem esse dia existe (31/01 → 03/03) — o prazo não estoura no calendário", () => {
    // `setUTCMonth` normaliza o overflow. Um prazo que virasse "erro de data" seria prazo
    // perdido no calendário, não no atendimento.
    expect(prazoDeUmMes(new Date("2026-01-31T00:00:00Z")).toISOString()).toBe(
      "2026-03-03T00:00:00.000Z",
    );
  });

  it("dentro do prazo é até o fim do dia do vencimento; depois, não", () => {
    expect(dentroDoPrazoDeUmMes(RECEBIDO, new Date("2026-10-10T23:59:00Z"))).toBe(true);
    expect(dentroDoPrazoDeUmMes(RECEBIDO, new Date("2026-10-11T00:00:01Z"))).toBe(false);
  });
});

describe("recusa e prorrogação exigem o motivo escrito", () => {
  it("recusa sem motivo LANÇA — o e-mail pela metade é pior que o e-mail ausente", () => {
    expect(() => montarAvisoArt12(aviso({ desfecho: "recusa", motivo: null }))).toThrow(
      MotivoObrigatorio,
    );
    expect(() => montarAvisoArt12(aviso({ desfecho: "recusa", motivo: "   " }))).toThrow(
      MotivoObrigatorio,
    );
  });

  it("prorrogação sem motivo LANÇA", () => {
    expect(() => montarAvisoArt12(aviso({ desfecho: "prorrogacao", motivo: undefined }))).toThrow(
      MotivoObrigatorio,
    );
  });

  it("o apagamento não tem motivo a declarar — o n.º 3 não pede razão de nada", () => {
    expect(() => montarAvisoArt12(aviso({ desfecho: "apagamento" }))).not.toThrow();
  });

  it("com motivo, o texto leva a razão E o prazo de um mês", () => {
    const t = montarAvisoArt12(
      aviso({ desfecho: "recusa", motivo: "a identidade não ficou comprovada nos autos" }),
    );
    expect(t.html).toContain("a identidade não ficou comprovada nos autos");
    expect(t.text).toContain("a identidade não ficou comprovada nos autos");
    expect(t.html).toContain("prazo de um mês");
    expect(t.subject).toContain("#abcd1234");
  });

  it("a prorrogação leva o motivo E a data nova", () => {
    const t = montarAvisoArt12(
      aviso({
        desfecho: "prorrogacao",
        motivo: "a terceira pessoa envolvida ainda não respondeu",
        novaData: new Date("2026-11-10T12:00:00Z"),
      }),
    );
    expect(t.html).toContain("a terceira pessoa envolvida ainda não respondeu");
    expect(t.html).toContain("Motivo da prorrogação");
    expect(t.html).toContain("10/11/2026");
  });

  it("o motivo entra ESCAPADO — ele vem do operador e o e-mail é HTML", () => {
    const t = montarAvisoArt12(
      aviso({ desfecho: "recusa", motivo: 'não comprovou: <script>alert("x")</script>' }),
    );
    expect(t.html).not.toContain("<script>alert");
    expect(t.html).toContain("&lt;script&gt;");
    // O texto puro é texto: ali o script não é perigo, e o motivo fica legível como foi escrito.
    expect(t.text).toContain('<script>alert("x")</script>');
  });
});

describe("o e-mail de apagamento é honesto quanto ao prazo", () => {
  it("dentro do prazo: afirma o cumprimento, com a data-limite", () => {
    const t = montarAvisoArt12(aviso({ agora: new Date("2026-09-20T12:00:00Z") }));

    expect(t.html).toContain("dentro do prazo de um mês");
    expect(t.text).toContain("dentro do prazo de um mês");
  });

  it("fora do prazo: NÃO afirma cumprimento — diz quando o prazo terminou", () => {
    // O prazo de um mês venceu em 10/10; a cascata terminou dez dias depois.
    const t = montarAvisoArt12(aviso({ agora: new Date("2026-10-20T12:00:00Z") }));

    expect(t.html, "o e-mail afirmou um prazo que ele não cumpriu").not.toContain(
      "dentro do prazo",
    );
    expect(t.html).toContain("terminou em");
    expect(t.text).not.toContain("dentro do prazo");
    expect(t.text).toContain("terminou em");
  });
});

describe("o texto é o de FORA do Brasil — o ramo brasileiro saiu inteiro", () => {
  const fonte = readFileSync(join(process.cwd(), "lib", "lgpd", "avisos-do-artigo-12.ts"), "utf8");
  /**
   * O arquivo SEM COMENTÁRIOS.
   *
   * O cabeçalho do módulo ESCREVE o que saiu (nomeia o `mensagemDoBrasil` e o ramo
   * pt-BR para quem for escrever o texto brasileiro na revisão própria), e caçar o
   * literal na prosa reprovaria o próprio comentário que explica a decisão — a
   * mesma armadilha que `vitest.cercas.ts` documenta. A régua é o CÓDIGO.
   */
  const codigo = fonte
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

  it("não existe mais `mensagemDoBrasil` nem linha `pt-BR` no módulo", () => {
    // A decisão de 2026-10-16 tirou o texto brasileiro DESTE arquivo inteiro, e é
    // asserção de fonte de propósito: nenhuma frase brasileira pode voltar por
    // descuido num rebase.
    expect(codigo, "o ramo brasileiro do texto voltou").not.toContain("mensagemDoBrasil");
    expect(codigo, "há linha em pt-BR no módulo do aviso").not.toContain("pt-BR");
  });

  it("o documento é pt-PT e o aviso de apagamento fala como Portugal fala", () => {
    const t = montarAvisoArt12(aviso());

    expect(t.html).toContain('<html lang="pt-PT">');
    expect(t.subject).toContain("O seu pedido de dados pessoais foi atendido");
    expect(t.html).not.toContain("LGPD");
    expect(t.text).toContain("O seu pedido");
  });

  it("o rótulo da linha da lei vem do PERFIL — `Direito exercido`, não `Base legal` fixo", () => {
    const t = montarAvisoArt12(aviso({ desfecho: "recusa", motivo: "pedido duplicado" }));

    expect(t.html).toContain("Direito exercido: RGPD art. 15.º");
    expect(t.html, "o rótulo fixo voltou ao e-mail").not.toContain("Base legal");
    expect(t.text).toContain("Direito exercido: RGPD art. 15.º");
  });

  it("país sem lei revisada não cita lei nenhuma — nem a brasileira", () => {
    const t = montarAvisoArt12(aviso({ perfil: { ...perfilDoPais("PT"), lei: null } }));

    expect(t.html).not.toContain("RGPD");
    expect(t.html).not.toContain("Base legal");
  });

  it("nenhum texto leva o nome do produto — quem opera é a marca do cliente", () => {
    for (const desfecho of ["apagamento", "recusa", "prorrogacao"] as const) {
      const t = montarAvisoArt12(
        aviso({ desfecho, motivo: desfecho === "apagamento" ? null : "motivo declarado" }),
      );
      expect(t.html).toContain("Silva &amp; Filhos");
      expect(`${t.subject}${t.html}${t.text}`).not.toContain("Deskcomm");
    }
  });

  it("o html leva a marca no tom de texto da casa, não em cor solta", () => {
    const t = montarAvisoArt12(aviso());
    expect(t.html).toContain(NEUTROS_DE_SAIDA.texto);
  });
});
