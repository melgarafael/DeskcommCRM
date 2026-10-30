/**
 * #3723 — "não medido" não é "medido e ruim".
 *
 * Numa busca real de 47 empresas, 30 saíram `site-ruim` e 2 `fora-do-ar`, e a
 * estratégia mandava o agente CITAR esses itens na primeira mensagem. Vários
 * eram falsos: site com link `wa.me` classificado `falta-tel`, 403 do firewall
 * tratado como site ruim, timeout da VPS congelado como "fora do ar".
 *
 * Cada bloco aqui reproduz um caso MEDIDO da issue. Todos falham no `main`
 * anterior ao conserto — é a prova de que o teste não passa por acidente.
 */
import { describe, expect, it } from "vitest";

import {
  citavelNoArgumento,
  CLASSES_DE_SITE,
  derivarClasse,
  montarChecklist,
  type SiteEnrichment,
} from "@/lib/prospecting/site-classify";
import { auditarSite, LIMITE_TENTATIVAS } from "@/lib/prospecting/site-fetch";
import { normalizarVeredito, siteEfetivo } from "@/lib/prospecting/site-efetivo";
import {
  montarDadosDeAbordagem,
  montarEstrategia,
  pontuarCandidato,
} from "@/lib/prospecting/estrategia-site";
import { previaPorGerar } from "@/lib/prospecting/previa";
import { prospectEnrichmentSchema } from "@/lib/prospecting/schema";

const AGORA = "2026-10-30T12:00:00.000Z";
const VERIFICADOR_LIBERADO = async () => {};

/** Página real do caso A: link de WhatsApp no rodapé e título com o nome da marca. */
const PAGINA_COM_WHATSAPP = `<html><head><meta name="viewport" content="width=device-width">
<title>VittaSP</title>
<meta name="description" content="Clínica de estética em São Paulo, atendimento com hora marcada todos os dias">
<link rel="icon" href="/f.ico"></head><body>
<h1>Bem-vindo</h1><a href="https://wa.me/5511999990000">Fale no WhatsApp</a>
<a href="mailto:contato@vitta.test">e-mail</a><a href="https://instagram.com/vitta">ig</a>
<address>Rua das Flores, 123</address><img src="a.jpg"><img src="b.jpg"><img src="c.jpg">
<p>Atendemos de segunda a sábado, com hora marcada, convênios e pacotes para novos pacientes da região.</p>
<p>Nossa equipe reúne dermatologistas, fisioterapeutas e esteticistas com mais de quinze anos de experiência
em tratamentos faciais e corporais. A avaliação inicial é gratuita e o plano de tratamento é desenhado
caso a caso, com acompanhamento mensal e retorno incluído. Estacionamento no local e fácil acesso por
transporte público, no coração da cidade, com atendimento também aos sábados pela manhã.</p>
</body></html>`;

function respondeCom(status: number, headers: Record<string, string> = {}): typeof fetch {
  return (async () =>
    new Response("<html><head><title>Just a moment...</title></head></html>", {
      status,
      headers,
    })) as unknown as typeof fetch;
}

function paginaCom(html: string): typeof fetch {
  return (async () => new Response(html, { status: 200 })) as unknown as typeof fetch;
}

/** O `data.site` GRAVADO do caso A, copiado do log da issue. */
const GRAVADO_CASO_A: SiteEnrichment = {
  ver: 1,
  classe: "site-ruim",
  problemas: ["falta-tel", "falta-titulo"],
  checklist: {
    tem: ["whatsapp", "mailto", "social", "mapa", "fotos", "description", "favicon"],
    falta: ["tel", "titulo"],
  },
  final_url: "https://vitta.test/",
  http_status: 200,
  tempo_ms: 900,
  conteudo_resumo: "Título: VittaSP",
  pagespeed: null,
  verificado_em: AGORA,
  provisorio: false,
  tentativas: 1,
};

/** O `data.site` GRAVADO do caso C: timeout congelado como fora do ar. */
const GRAVADO_CASO_C: SiteEnrichment = {
  ver: 1,
  classe: "fora-do-ar",
  problemas: ["fora-do-ar"],
  checklist: { tem: [], falta: [] },
  final_url: null,
  http_status: null,
  tempo_ms: 0,
  conteudo_resumo: null,
  pagespeed: null,
  verificado_em: AGORA,
  provisorio: false,
  tentativas: 3,
};

const DADOS = {
  name: "Clínica Vitta",
  category: "Clínica de estética",
  address: "Rua das Flores, 123",
  website: "https://vitta.test/",
  rating: 4.9,
  socials: [] as string[],
};

describe("#3723 · falha de medicao nao vira veredito (403, timeout)", () => {
  it("403 sem desafio anti-robô é MEDIÇÃO BARRADA, não 'o site responde com erro'", async () => {
    const v = await auditarSite("https://vitta.test/", AGORA, respondeCom(403), VERIFICADOR_LIBERADO, 0);

    expect(v.classe).toBe("nao-medido");
    expect(v.problemas).toEqual(["medicao-bloqueada"]);
    expect(v.problemas).not.toContain("http-403");
    expect(citavelNoArgumento(v)).toBe(false);
  });

  it("401/403/406/429/451/503 nunca viram site-ruim, mesmo com as tentativas esgotadas", async () => {
    for (const status of [401, 403, 406, 429, 451, 503]) {
      const v = await auditarSite(
        "https://vitta.test/",
        AGORA,
        respondeCom(status),
        VERIFICADOR_LIBERADO,
        LIMITE_TENTATIVAS - 1,
      );
      expect(v.classe, `status ${status}`).toBe("nao-medido");
      expect(citavelNoArgumento(v), `status ${status}`).toBe(false);
    }
  });

  it("timeout persistente congela nao-medido, jamais fora-do-ar citável", async () => {
    const fetchQueNuncaResponde: typeof fetch = (async () => {
      throw new Error("fetch failed");
    }) as typeof fetch;

    const primeiro = await auditarSite("https://lento.test/", AGORA, fetchQueNuncaResponde, VERIFICADOR_LIBERADO);
    expect(primeiro.classe).toBe("nao-medido");
    expect(primeiro.provisorio).toBe(true);

    const congelado = await auditarSite(
      "https://lento.test/",
      AGORA,
      fetchQueNuncaResponde,
      VERIFICADOR_LIBERADO,
      LIMITE_TENTATIVAS - 1,
    );
    expect(congelado.classe).toBe("nao-medido");
    expect(congelado.provisorio).toBe(false);
    expect(citavelNoArgumento(congelado)).toBe(false);
  }, 20_000);

  it("só o domínio inexistente (NXDOMAIN) continua sendo prova de 'não abre'", async () => {
    const verificadorNxdomain = async () => {
      throw new Error("unsafe_url:dns_nxdomain");
    };
    const v = await auditarSite(
      "https://dominio-morto.test/",
      AGORA,
      paginaCom(PAGINA_COM_WHATSAPP),
      verificadorNxdomain,
    );
    expect(v.classe).toBe("fora-do-ar");
    expect(v.problemas).toEqual(["dns-morto"]);
    expect(citavelNoArgumento(v)).toBe(true);
  });
});

describe("#3723 · checklist nunca cita o que o próprio site mostra", () => {
  it("link de WhatsApp é telefone de contato: nada de falta-tel", () => {
    const checklist = montarChecklist(PAGINA_COM_WHATSAPP);
    expect(checklist.tem).toContain("whatsapp");
    expect(checklist.tem).toContain("tel");
    expect(checklist.falta).not.toContain("tel");
  });

  it("título curto é título: só vazio ou genérico vira falta", () => {
    expect(montarChecklist("<html><head><title>Vitta</title></head></html>").falta).not.toContain("titulo");
    expect(montarChecklist("<html><head><title>home</title></head></html>").falta).toContain("titulo");
    expect(montarChecklist("<html><head></head></html>").falta).toContain("titulo");
  });

  it("site com 200 e só itens de checklist marcados como falta continua site-ok", async () => {
    const v = await auditarSite("https://vitta.test/", AGORA, paginaCom(PAGINA_COM_WHATSAPP), VERIFICADOR_LIBERADO);
    expect(v.classe).toBe("site-ok");
    expect(v.problemas.some((p) => p.startsWith("falta-"))).toBe(false);
  });

  it("página montada por JavaScript sai com checklist inconclusivo, não com faltas inventadas", async () => {
    // Wix: a página é armada no navegador; o HTML baixado é quase só script.
    const wix = `<html><head><title>Clínica Vitta</title></head><body>
      <script src="https://static.parastorage.com/a.js"></script><div id="root"></div></body></html>`;
    const v = await auditarSite("https://vitta.wixsite.com/site/", AGORA, paginaCom(wix), VERIFICADOR_LIBERADO);

    expect(v.checklist.inconclusivo).toBe(true);
    expect(v.checklist.falta).toEqual([]);
    expect(v.problemas).not.toContain("falta-whatsapp");
    expect(v.problemas).not.toContain("falta-fotos");
  });
});

describe("#3723 · a estratégia não cita o que não foi medido", () => {
  it("o gancho 'Faltas concretas no site' não existe mais", () => {
    const e = montarEstrategia({
      classe: "site-ok",
      problemas: [],
      checklist: { tem: ["whatsapp"], falta: ["tel", "titulo", "fotos"] },
      nota: 4.9,
      numAvaliacoes: 120,
      temInstagram: false,
      ofertas: ["site"],
      nicho: "clínica",
      provisorio: false,
      status: "new",
      followUpsEnviados: 0,
    });
    expect(e.ganchos.join(" ")).not.toContain("Faltas concretas");
    expect(e.ganchos.join(" ")).not.toContain("cite uma");
  });

  it("não medido não gera ângulo de conserto nem campo Auditoria para o agente", () => {
    const site = { ...GRAVADO_CASO_C, classe: "nao-medido" as const, problemas: ["medicao-instavel"] };
    const e = montarEstrategia({
      classe: site.classe,
      problemas: site.problemas,
      checklist: site.checklist,
      nota: 4.9,
      numAvaliacoes: 120,
      temInstagram: false,
      ofertas: ["site"],
      nicho: "clínica",
      provisorio: false,
      status: "new",
      followUpsEnviados: 0,
    });
    expect(e.cenario).toBe("Site não medido");
    expect(e.ganchos).toEqual([]);
    expect(montarDadosDeAbordagem(DADOS, site)["Auditoria"]).toBeUndefined();
  });

  it("o score trata não medido como neutro, não como 'site fora do ar'", () => {
    const naoMedido = pontuarCandidato(4.9, 120, "nao-medido", "site");
    const foraDoAr = pontuarCandidato(4.9, 120, "fora-do-ar", "site");
    expect(naoMedido.valor).toBeLessThan(foraDoAr.valor);
    expect(naoMedido.motivo).not.toContain("site com problemas");
    // Sem nota nem volume, o motivo é a própria situação do site.
    expect(pontuarCandidato(null, null, "nao-medido").motivo).toBe("site não medido");
  });
});

describe("#3723 · vereditos JÁ GRAVADOS deixam de mentir na leitura (sem migração)", () => {
  it("caso A: `falta-tel`/`falta-titulo` em site com WhatsApp vira site-ok e some do argumento", () => {
    const lido = normalizarVeredito(GRAVADO_CASO_A);

    expect(lido.classe).toBe("site-ok");
    expect(lido.problemas).toEqual([]);
    expect(lido.checklist.falta).toEqual([]);
    expect(lido.checklist.tem).toContain("tel");
    expect(montarDadosDeAbordagem(DADOS, lido)["Auditoria"]).toBe(
      "Site em ordem (verificado em 30/10/2026)",
    );
  });

  it("caso C: `fora-do-ar` congelado por timeout vira nao-medido e para de ser citado", () => {
    const lido = normalizarVeredito(GRAVADO_CASO_C);

    expect(lido.classe).toBe("nao-medido");
    expect(lido.problemas).toEqual(["medicao-instavel"]);
    expect(citavelNoArgumento(lido)).toBe(false);
    expect(montarDadosDeAbordagem(DADOS, lido)["Auditoria"]).toBeUndefined();
  });

  it("não medido definitivo ganha prévia como os outros vereditos (o texto só não cita o site)", () => {
    expect(
      previaPorGerar(
        { data: { ...DADOS, site: GRAVADO_CASO_C }, status: "new", selected: true },
        AGORA,
      ),
    ).toBe(true);
  });

  it("caso B: veredito gravado com http-403 vira nao-medido", () => {
    const lido = normalizarVeredito({
      ...GRAVADO_CASO_A,
      classe: "site-ruim",
      problemas: ["http-403"],
      checklist: { tem: [], falta: [] },
      http_status: 403,
    });
    expect(lido.classe).toBe("nao-medido");
    expect(lido.problemas).toEqual(["medicao-bloqueada"]);
  });

  it("veredito honesto passa byte a byte (a normalização é idempotente)", () => {
    const honesto: SiteEnrichment = {
      ...GRAVADO_CASO_A,
      classe: "site-ruim",
      problemas: ["sem-https", "nao-mobile"],
      checklist: { tem: ["whatsapp", "tel", "titulo"], falta: ["fotos"] },
    };
    expect(normalizarVeredito(honesto)).toBe(honesto);
    expect(siteEfetivo({ website: honesto.final_url, site: honesto }, AGORA)).toBe(honesto);
  });
});

describe("#3723 · vocabulário e schema acompanham a classe nova", () => {
  it("`nao-medido` é classe de primeira linha e passa pelo schema público", () => {
    expect(CLASSES_DE_SITE).toContain("nao-medido");
    const parsed = prospectEnrichmentSchema.safeParse({
      name: "X",
      category: null,
      address: null,
      website: "https://x.com",
      maps_url: null,
      rating: 5,
      reviews: 10,
      emails: [],
      socials: [],
      site: {
        ver: 1,
        classe: "nao-medido",
        problemas: ["medicao-bloqueada"],
        checklist: { tem: [], falta: [], inconclusivo: true },
        final_url: null,
        http_status: 403,
        tempo_ms: 0,
        conteudo_resumo: null,
        pagespeed: null,
        verificado_em: AGORA,
        provisorio: false,
        tentativas: 3,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("derivarClasse não promove dúvida a veredito", () => {
    const base = { agregador: false, semSite: false, urlFinal: "https://x.com", problemas: [] as string[] };
    expect(derivarClasse({ ...base, erro: { tipo: "transitoria" } })).toBe("nao-medido");
    expect(derivarClasse({ ...base, problemas: ["falta-tel"] })).toBe("site-ok");
  });
});
