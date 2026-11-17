import { describe, expect, it } from "vitest";

import {
  baseLegalValida,
  classificarAudiencia,
  contarExclusoes,
  motivoParaExcluir,
  normalizarEmail,
  recusouMarketing,
  statusDaSaida,
  type CandidatoDaAudiencia,
} from "./elegibilidade";

function candidato(over: Partial<CandidatoDaAudiencia> = {}): CandidatoDaAudiencia {
  return {
    contactId: over.contactId ?? "c1",
    // `in` e não `??`: `telefone: null` é o caso que este arquivo mais testa, e
    // `null ?? default` o transformava em telefone VÁLIDO — o helper apagava o
    // caso e dois testes ficavam verdes medindo outra coisa.
    nome: "nome" in over ? (over.nome ?? null) : "Ana Souza",
    telefone: "telefone" in over ? (over.telefone ?? null) : "+5511900000001",
    // Mesmo motivo do telefone: `email: null` é caso testado, e `?? default` o
    // apagaria.
    email: "email" in over ? (over.email ?? null) : null,
    bloqueado: over.bloqueado ?? false,
    anonimizado: over.anonimizado ?? false,
    pessoal: over.pessoal ?? false,
    recusouMarketing: over.recusouMarketing ?? false,
  };
}

const RENDER_OK = (c: CandidatoDaAudiencia) => ({ texto: `Oi ${c.nome}`, faltando: [] as string[] });

/** O contexto mínimo: sem exclusão, sem compromisso, hash previsível. */
function ctx(over: Partial<Parameters<typeof classificarAudiencia>[1]> = {}) {
  return {
    excluidosAMao: new Set<string>(),
    jaEmCampanha: new Set<string>(),
    suprimidos: new Set<string>(),
    hashDoEndereco: (e: string) => `h:${e}`,
    renderizar: RENDER_OK,
    ...over,
  };
}

describe("vetos por pessoa", () => {
  it("quem pediu para parar é o primeiro veto, mesmo sem telefone", () => {
    // A ordem não é estética: dizer "sem telefone" para quem pediu para parar
    // mentiria sobre o motivo de não ter recebido.
    expect(motivoParaExcluir(candidato({ bloqueado: true, telefone: null }))).toBe("opt_out");
  });

  it("contato pessoal veta com motivo próprio, depois do opt-out (spec 21)", () => {
    expect(motivoParaExcluir(candidato({ pessoal: true }))).toBe("contato_pessoal");
    // Quem pediu para parar continua sendo opt-out, mesmo marcado como pessoal.
    expect(motivoParaExcluir(candidato({ pessoal: true, bloqueado: true }))).toBe("opt_out");
  });

  it("a saída de pessoal na rodada é `personal`, nunca `opted_out` (D7)", () => {
    expect(statusDaSaida("contato_pessoal")).toBe("personal");
    expect(statusDaSaida("opt_out")).toBe("opted_out");
    expect(statusDaSaida("sem_telefone")).toBe("skipped");
  });

  it("anonimizado e recusa de marketing vetam", () => {
    expect(motivoParaExcluir(candidato({ anonimizado: true }))).toBe("anonimizado");
    expect(motivoParaExcluir(candidato({ recusouMarketing: true }))).toBe("recusou_marketing");
  });

  it("telefone ausente, vazio ou fora do E.164 não vira envio", () => {
    expect(motivoParaExcluir(candidato({ telefone: null }))).toBe("sem_telefone");
    expect(motivoParaExcluir(candidato({ telefone: "   " }))).toBe("sem_telefone");
    expect(motivoParaExcluir(candidato({ telefone: "48 99999-0000" }))).toBe("telefone_invalido");
    expect(motivoParaExcluir(candidato({ telefone: "5548999990000" }))).toBe("telefone_invalido");
  });

  it("contato completo passa", () => {
    expect(motivoParaExcluir(candidato())).toBeNull();
  });

  it("recusa de marketing só conta quando REGISTRADA", () => {
    expect(recusouMarketing(null)).toBe(false);
    expect(recusouMarketing({ marketing: { granted_at: null } })).toBe(false);
    expect(recusouMarketing({ marketing: { declined_at: "2026-01-01T00:00:00Z" } })).toBe(true);
    expect(recusouMarketing("texto")).toBe(false);
  });
});

describe("base legal", () => {
  it("interesse legítimo SEM referência da LIA não vale", () => {
    expect(baseLegalValida({ baseLegal: "legitimate_interest", liaRef: null })).toBe(false);
    expect(baseLegalValida({ baseLegal: "legitimate_interest", liaRef: "  " })).toBe(false);
    expect(baseLegalValida({ baseLegal: "legitimate_interest", liaRef: "LIA-2026-01" })).toBe(true);
  });

  it("consentimento vale; qualquer outra coisa não", () => {
    expect(baseLegalValida({ baseLegal: "consent", liaRef: null })).toBe(true);
    expect(baseLegalValida({ baseLegal: "porque_sim", liaRef: "x" })).toBe(false);
  });
});

describe("classificação da lista", () => {
  it("dois cadastros com o MESMO telefone: o segundo é duplicado", () => {
    const linhas = classificarAudiencia(
      [
        candidato({ contactId: "a", telefone: "+5548999990000" }),
        candidato({ contactId: "b", telefone: "+5548999990000" }),
      ],
      ctx(),
    );
    expect(linhas.map((l) => l.motivo)).toEqual([null, "duplicado"]);
  });

  it("quem está em campanha viva fica de fora — três variantes não vão para a mesma pessoa", () => {
    const linhas = classificarAudiencia([candidato({ contactId: "a" })], ctx({ jaEmCampanha: new Set(["a"]) }));
    expect(linhas[0]!.motivo).toBe("ja_em_campanha");
  });

  it("incluir à mão não fura opt-out: o veto por pessoa vem antes do 'já em campanha'", () => {
    const linhas = classificarAudiencia(
      [candidato({ contactId: "a", bloqueado: true })],
      ctx({ jaEmCampanha: new Set(["a"]) }),
    );
    expect(linhas[0]!.motivo).toBe("opt_out");
  });

  it("excluído à mão vence tudo — foi uma decisão explícita do operador", () => {
    const linhas = classificarAudiencia([candidato({ contactId: "a" })], ctx({ excluidosAMao: new Set(["a"]) }));
    expect(linhas[0]!.motivo).toBe("excluido_manualmente");
  });

  it("variável sem valor exclui em vez de mandar texto com buraco", () => {
    const linhas = classificarAudiencia(
      [candidato({ contactId: "a", nome: null })],
      ctx({ renderizar: () => ({ texto: "Olá {{nome}}", faltando: ["nome"] }) }),
    );
    expect(linhas[0]!.motivo).toBe("variavel_ausente");
    expect(linhas[0]!.corpo).toBeNull();
  });

  it("o excluído NÃO ocupa o endereço: quem vem depois com o mesmo número ainda pode receber", () => {
    // Senão um bloqueado no topo da lista silenciaria o gêmeo válido logo abaixo.
    const linhas = classificarAudiencia(
      [
        candidato({ contactId: "a", telefone: "+5548999990000", bloqueado: true }),
        candidato({ contactId: "b", telefone: "+5548999990000" }),
      ],
      ctx(),
    );
    expect(linhas.map((l) => l.motivo)).toEqual(["opt_out", null]);
  });

  it("o elegível sai com o corpo pronto", () => {
    const linhas = classificarAudiencia([candidato({ nome: "Ana" })], ctx());
    expect(linhas[0]).toMatchObject({ elegivel: true, motivo: null, corpo: "Oi Ana" });
  });

  it("quem está na lista de exclusão da operação fica de fora — e isso não é opt-out", () => {
    // A suppression é decisão de quem opera; o opt-out é do titular. Quem está
    // suprimido não recebe CAMPANHA, mas continua sendo atendido se escrever.
    const linhas = classificarAudiencia(
      [candidato({ contactId: "a", telefone: "+5548999990000" })],
      ctx({ suprimidos: new Set(["h:+5548999990000"]) }),
    );
    expect(linhas[0]!.motivo).toBe("suprimido");
  });

  it("conta os motivos para a prévia", () => {
    const linhas = classificarAudiencia(
      [
        candidato({ contactId: "a", bloqueado: true }),
        candidato({ contactId: "b", bloqueado: true }),
        candidato({ contactId: "c", telefone: null }),
        candidato({ contactId: "d" }),
      ],
      ctx(),
    );
    expect(contarExclusoes(linhas)).toEqual({ opt_out: 2, sem_telefone: 1 });
  });
});

/**
 * (c) O PÚBLICO DA CAMPANHA DE E-MAIL (#3441): o recorte é o mesmo, o endereço
 * é outro. Quem não tem e-mail fica de fora COM MOTIVO, e a contagem por motivo
 * é o "N com e-mail, M sem" que a prévia mostra — a mesma função
 * (`contarExclusoes`) que `preverAudiencia` devolve.
 */
describe("audiência do canal de e-mail", () => {
  it("sem e-mail sai como `sem_email`, mesmo tendo telefone", () => {
    expect(motivoParaExcluir(candidato({ email: null, telefone: "+5511900000001" }), "email")).toBe(
      "sem_email",
    );
    expect(motivoParaExcluir(candidato({ email: "   " }), "email")).toBe("sem_email");
  });

  it("e-mail fora do formato de envio tem motivo próprio", () => {
    expect(motivoParaExcluir(candidato({ email: "ana.empresa.test" }), "email")).toBe(
      "email_invalido",
    );
    expect(motivoParaExcluir(candidato({ email: "ana@empresa" }), "email")).toBe("email_invalido");
    expect(motivoParaExcluir(candidato({ email: " Ana@Empresa.test " }), "email")).toBeNull();
  });

  it("contato sem telefone PODE receber e-mail, e o contrário também vale", () => {
    const semTelefone = candidato({ telefone: null, email: "ana@empresa.test" });
    expect(motivoParaExcluir(semTelefone, "email")).toBeNull();
    expect(motivoParaExcluir(semTelefone, "whatsapp")).toBe("sem_telefone");
    const semEmail = candidato({ telefone: "+5511900000001", email: null });
    expect(motivoParaExcluir(semEmail, "whatsapp")).toBeNull();
    expect(motivoParaExcluir(semEmail, "email")).toBe("sem_email");
  });

  it("a lista conta só quem tem e-mail e INFORMA quantos ficaram de fora", () => {
    const linhas = classificarAudiencia(
      [
        candidato({ contactId: "c1", email: "ana@empresa.test", telefone: null }),
        candidato({ contactId: "c2", email: "bruno@empresa.test" }),
        candidato({ contactId: "c3", email: null }),
        candidato({ contactId: "c4", email: "   " }),
      ],
      ctx({ canal: "email" }),
    );
    const elegiveis = linhas.filter((l) => l.elegivel);
    expect(elegiveis.map((l) => normalizarEmail(l.candidato.email))).toEqual([
      "ana@empresa.test",
      "bruno@empresa.test",
    ]);
    expect(linhas.length - elegiveis.length).toBe(2);
    expect(contarExclusoes(linhas)).toEqual({ sem_email: 2 });
  });

  it("dois cadastros com o mesmo e-mail recebem uma vez só — a unicidade é do canal", () => {
    const linhas = classificarAudiencia(
      [
        candidato({ contactId: "c1", email: "Ana@Empresa.test" }),
        candidato({ contactId: "c2", email: "ana@empresa.test " }),
      ],
      ctx({ canal: "email" }),
    );
    expect(linhas.filter((l) => l.elegivel)).toHaveLength(1);
    expect(contarExclusoes(linhas)).toEqual({ duplicado: 1 });
  });

  it("o WhatsApp continua contando por telefone — não regride", () => {
    const linhas = classificarAudiencia(
      [
        candidato({ contactId: "c1", telefone: "+5511900000001", email: null }),
        candidato({ contactId: "c2", telefone: null, email: "bruno@empresa.test" }),
      ],
      ctx(),
    );
    expect(linhas.filter((l) => l.elegivel)).toHaveLength(1);
    expect(contarExclusoes(linhas)).toEqual({ sem_telefone: 1 });
  });
});
