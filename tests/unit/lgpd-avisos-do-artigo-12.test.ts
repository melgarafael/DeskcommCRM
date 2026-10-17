/**
 * OS AVISOS DO ART. 12.º DIZEM O QUE A LEI MANDA DIZER — e o motivo não é opcional.
 *
 * ─── O defeito (#2342) ───────────────────────────────────────────────────────────────────────
 *
 * A triagem mediu que a anonimização terminava em silêncio: o pedido de exclusão era
 * cumprido, o SLA marcava D+15, e o titular não recebia NADA. O art. 12.º, n.º 3 do RGPD
 * obriga a informar depois de apagar; os n.ºs 3 e 4 obrigam a informar a recusa — ou a
 * prorrogação, com o MOTIVO — no prazo de um mês. O Brasil diz o mesmo: LGPD art. 18, I
 * (eliminação), art. 19, §1 (confirmação ou negativa) e art. 19, §2 (prorrogação justificada).
 *
 * ─── O que este arquivo mede ─────────────────────────────────────────────────────────────────
 *
 *   1. o prazo de um mês é contado do recebimento, e o AVISO afirma tê-lo cumprido;
 *   2. recusa e prorrogação SEM motivo LANÇAM — a rota responde 422 em vez de mandar um
 *      e-mail pela metade (`MotivoObrigatorio`);
 *   3. o texto do Brasil cita a LGPD com número de artigo, e o de Portugal NÃO a cita
 *      (mesma régua do `lib/lgpd/email-delivery.ts`, doc 88): um titular português lendo
 *      "LGPD art. 18" é o defeito que o e-mail de exportação já consertou;
 *   4. o motivo entra ESCAPADO — o e-mail é HTML e o motivo vem do operador;
 *   5. nenhum texto carrega o nome do produto: o remetente é a marca de quem OPEROU.
 */
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

function aviso(Extra: Partial<AvisoArt12> = {}): AvisoArt12 {
  return {
    desfecho: "apagamento",
    requestId: "abcd1234-ef00-4000-8000-000000000000",
    marca: MARCA,
    perfil: perfilDoPais("BR"),
    prazoDeUmMes: PRAZO,
    recebidoEm: RECEBIDO,
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

describe("o texto segue o país da organização (doc 88)", () => {
  it("o Brasil cita a LGPD com artigo, e o aviso de apagamento diz que apagou", () => {
    const t = montarAvisoArt12(aviso());
    expect(t.subject).toContain("Seus dados pessoais foram apagados");
    expect(t.html).toContain("LGPD Lei nº 13.709/2018");
    expect(t.html).toContain("art. 18");
    expect(t.html).toContain("irreversível");
    expect(t.text).toContain("apagados");
  });

  it("Portugal fala em RGPD e NÃO cita LGPD — o mesmo titular lendo duas leis é o defeito", () => {
    const t = montarAvisoArt12(aviso({ perfil: perfilDoPais("PT") }));
    expect(t.html).toContain("O seu pedido");
    expect(t.html).not.toContain("LGPD");
    expect(t.subject).toContain("O seu pedido de dados pessoais");
    expect(t.text).toContain("O seu pedido");
  });

  it("a recusa portuguesa traz a lei revisada quando o perfil tem, e a brasileira o art. 19", () => {
    const br = montarAvisoArt12(aviso({ desfecho: "recusa", motivo: "pedido duplicado" }));
    expect(br.html).toContain("art. 19");
    const pt = montarAvisoArt12(
      aviso({ desfecho: "recusa", motivo: "pedido duplicado", perfil: perfilDoPais("PT") }),
    );
    expect(pt.html).not.toContain("LGPD");
    expect(pt.html).toContain("prazo de um mês");
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
