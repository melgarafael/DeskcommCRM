import { describe, expect, it } from "vitest";

import {
  aceitaResultadoDaLigacao,
  caminhoDaLigacao,
  comMotivosDoColdCall,
  comoTerminou,
  configDoFunil,
  linhasDoRoteiro,
  motivoParaNaoLigar,
  ordenarFila,
  roteiroPadrao,
  RESULTADOS,
  ETAPAS_DO_COLD_CALL,
  MOTIVOS_DE_PERDA_DO_COLD_CALL,
} from "./regras";

const ROTEIRO_PADRAO = roteiroPadrao("pt-BR");

const lead = (id: string, etapa: string, tentativas: number, ultima: string | null, criado = "2026-11-01") => ({
  id,
  etapa,
  tentativas,
  ultima_tentativa_em: ultima,
  criado_em: criado,
});

describe("ordenarFila", () => {
  it("quem nunca foi tentado vem antes, e quem foi tentado há mais tempo em seguida", () => {
    const fila = ordenarFila([
      lead("recente", "nao-atendeu", 1, "2026-11-03"),
      lead("novo", "na-fila", 0, null),
      lead("antigo", "caixa-postal", 1, "2026-11-01"),
    ]);
    expect(fila.map((l) => l.id)).toEqual(["novo", "antigo", "recente"]);
  });

  it("follow-up e reunião saem da fila", () => {
    const fila = ordenarFila([lead("a", "follow-up", 1, null), lead("b", "reuniao-pedida", 1, null)]);
    expect(fila).toEqual([]);
  });
});

describe("configDoFunil", () => {
  it("só o funil marcado é de cold call", () => {
    expect(configDoFunil({ cold_call: { ativo: true, roteiro: "oi" } })).toEqual({ roteiro: "oi" });
    expect(configDoFunil({})).toBeNull();
    expect(configDoFunil(null)).toBeNull();
    expect(configDoFunil({ cold_call: { ativo: false } })).toBeNull();
  });
});

describe("linhasDoRoteiro", () => {
  it("aceita os jeitos comuns de escrever as variáveis", () => {
    const texto = (roteiro: string) =>
      linhasDoRoteiro(roteiro, { negocio: "Pet Exemplo", quemLiga: "Caio" }).map((l) => l.texto);
    for (const variavel of ["[nome da empresa]", "[NOME DA EMPRESA]", "[nome do negocio]", "[empresa]", "[nome do lead]", "[cliente]"]) {
      expect(texto(`- É da ${variavel}?`)).toEqual(["É da Pet Exemplo?"]);
    }
    expect(texto("- Sou o [meu nome].")).toEqual(["Sou o Caio."]);
    for (const variavel of ["[nombre del lead]", "[lead name]", "[company name]"]) {
      expect(texto(`- ${variavel}`)).toEqual(["Pet Exemplo"]);
    }
    expect(texto("- [tu nombre] / [your name]")).toEqual(["Caio / Caio"]);
  });

  it("o roteiro padrão usa o nome da organização, sem marca fixa", () => {
    const textos = linhasDoRoteiro(ROTEIRO_PADRAO, { negocio: "Pet", quemLiga: "Caio", suaEmpresa: "Clínica Sol" }).map((l) => l.texto).join(" ");
    expect(textos).toContain("da Clínica Sol");
    expect(textos).not.toContain("[sua empresa]");
  });

  it("tira o negrito colado e ainda separa a marca", () => {
    expect(linhasDoRoteiro("- **[Agendou]** Pegar o **e-mail**.", { negocio: "X", quemLiga: "Y" })).toEqual([
      { tipo: "fala", marca: "Agendou", texto: "Pegar o e-mail." },
    ]);
  });

  it("nome com cifrão entra como texto", () => {
    expect(linhasDoRoteiro("- [empresa]", { negocio: "R$& Cia", quemLiga: "Y" })[0]).toMatchObject({ texto: "R$& Cia" });
  });

  it("preenche as lacunas e separa título, marca e fala", () => {
    const linhas = linhasDoRoteiro("# Abertura\n- É da [nome do negócio]?\n- [Resposta positiva] Sou o [seu nome].", {
      negocio: "Pet Exemplo",
      quemLiga: "Caio",
    });
    expect(linhas).toEqual([
      { tipo: "titulo", texto: "Abertura" },
      { tipo: "fala", marca: null, texto: "É da Pet Exemplo?" },
      { tipo: "fala", marca: "Resposta positiva", texto: "Sou o Caio." },
    ]);
  });

  it("o roteiro padrão não promete link de reunião e não sobra lacuna sem preencher", () => {
    const linhas = linhasDoRoteiro(ROTEIRO_PADRAO, { negocio: "X", quemLiga: "Y" });
    const texto = linhas.map((l) => l.texto).join(" ");
    expect(texto).not.toMatch(/\[nome do neg|\[seu nome/);
    expect(texto).not.toMatch(/link/i);
  });

  it("o roteiro padrão é neutro nos três idiomas: não vende produto, e as lacunas se preenchem", () => {
    // Ele vai para TODA instalação, de qualquer nicho. Vender "atendente de IA no WhatsApp"
    // aqui era o pitch de quem escreveu o PR, não o do cliente que instala.
    for (const idioma of ["pt-BR", "es", "en"]) {
      const roteiro = roteiroPadrao(idioma);
      expect(roteiro).not.toMatch(/\bIA\b|\bAI\b|WhatsApp|Google Meet|atendente/i);
      const texto = linhasDoRoteiro(roteiro, { negocio: "Pet Exemplo", quemLiga: "Caio", suaEmpresa: "Clínica Sol" })
        .map((l) => l.texto)
        .join(" ");
      expect(texto).toContain("Pet Exemplo");
      expect(texto).toContain("Caio");
      expect(texto).toContain("Clínica Sol");
      expect(texto).not.toMatch(/\[(?:nome do lead|nombre del lead|lead name|seu nome|tu nombre|your name|sua empresa|tu empresa|your company)\]/i);
    }
    expect(roteiroPadrao("es")).toContain("Apertura");
    expect(roteiroPadrao("en")).toContain("Opening");
    expect(roteiroPadrao("tr")).toBe(roteiroPadrao("pt-BR"));
  });
});

describe("os resultados", () => {
  it("todo resultado leva a uma etapa que o funil tem, ou encerra como perdido", () => {
    const slugs = ETAPAS_DO_COLD_CALL.map((e) => e.slug) as string[];
    for (const r of Object.values(RESULTADOS)) {
      if ("etapa" in r) expect(slugs).toContain(r.etapa);
      else expect(r.perde).toBe(true);
    }
  });
});

describe("como a ligação terminou", () => {
  const fim = (end_reason: string | null, atendida = false, porMim = false) => ({ end_reason, atendida, porMim });

  it("o lead barrou sem atender: é recusa, mesmo vindo como user_ended", () => {
    for (const motivo of ["user_ended", "declined", "rejected", "busy", "do_not_disturb"]) {
      expect(comoTerminou(fim(motivo))).toBe("recusada");
    }
  });

  it("desligar daqui, antes de atenderem, não é recusa", () => {
    expect(comoTerminou(fim("user_ended", false, true))).toBe("encerrada");
  });

  it("depois de atendida, quem desliga só encerra", () => {
    expect(comoTerminou(fim("user_ended", true))).toBe("encerrada");
  });

  it("tocou até o fim é sem resposta, e motivo desconhecido não vira recusa", () => {
    expect(comoTerminou(fim("timeout"))).toBe("sem_resposta");
    expect(comoTerminou(fim("failed"))).toBe("encerrada");
    expect(comoTerminou(fim(null))).toBe("encerrada");
  });
});

describe("por onde a ligação sai", () => {
  const conectado = { configured: true, paired: true };

  it("canal de voz pareado e contato salvo: sai pelo CRM", () => {
    expect(caminhoDaLigacao(conectado, "contato")).toBe("crm");
  });

  it("status que não voltou não vira discador", () => {
    expect(caminhoDaLigacao(undefined, "contato")).toBe("indefinido");
    expect(caminhoDaLigacao(null, "contato")).toBe("indefinido");
  });

  it("sem canal pareado ou sem contato, abre o discador", () => {
    expect(caminhoDaLigacao({ configured: true, paired: false }, "contato")).toBe("discador");
    expect(caminhoDaLigacao({ configured: false, paired: false }, "contato")).toBe("discador");
    expect(caminhoDaLigacao(conectado, null)).toBe("discador");
  });
});

describe("quem pediu para não ser incomodado não recebe ligação", () => {
  // A mesma regra de app/api/v1/voice/calls/route.ts, que o discador `tel:` não atravessa.
  const conectado = { configured: true, paired: true };
  const semVoz = { configured: false, paired: false };

  it("os três estados viram motivo; contato comum, nenhum", () => {
    expect(motivoParaNaoLigar({ is_blocked: true })).toBe("bloqueado");
    expect(motivoParaNaoLigar({ is_personal: true })).toBe("pessoal");
    expect(motivoParaNaoLigar({ is_anonymized: true })).toBe("anonimizado");
    expect(motivoParaNaoLigar({ is_blocked: false, is_personal: false, is_anonymized: false })).toBeNull();
    expect(motivoParaNaoLigar(null)).toBeNull();
  });

  for (const motivo of ["bloqueado", "pessoal", "anonimizado"] as const) {
    it(`${motivo}: nem pelo canal de voz, nem pelo discador do aparelho, nem com status indefinido`, () => {
      expect(caminhoDaLigacao(conectado, "contato", motivo)).toBe("nao-ligar");
      expect(caminhoDaLigacao(semVoz, "contato", motivo)).toBe("nao-ligar");
      expect(caminhoDaLigacao(undefined, "contato", motivo)).toBe("nao-ligar");
    });
  }

  it("sem motivo, os dois caminhos seguem como antes", () => {
    expect(caminhoDaLigacao(conectado, "contato", null)).toBe("crm");
    expect(caminhoDaLigacao(semVoz, "contato", null)).toBe("discador");
  });
});

describe("resultado de ligação só para quem recebe ligação", () => {
  it("os três estados recusam; contato comum aceita", () => {
    expect(aceitaResultadoDaLigacao("bloqueado")).toBe(false);
    expect(aceitaResultadoDaLigacao("pessoal")).toBe(false);
    expect(aceitaResultadoDaLigacao("anonimizado")).toBe(false);
    expect(aceitaResultadoDaLigacao(null)).toBe(true);
    expect(aceitaResultadoDaLigacao(undefined)).toBe(true);
  });
});

describe("comMotivosDoColdCall", () => {
  it("funil sem lista ganha os três motivos dos resultados que encerram", () => {
    expect(comMotivosDoColdCall({ cold_call: { ativo: true } })).toEqual({
      cold_call: { ativo: true },
      lost_reasons: ["Não tem interesse", "Número errado", "Tirado da fila"],
    });
  });

  it("acrescenta só o que falta, e lê o rótulo nos dois formatos", () => {
    expect(comMotivosDoColdCall({ lost_reasons: ["Preço", { label: "Número errado" }] })).toEqual({
      lost_reasons: ["Preço", { label: "Número errado" }, "Não tem interesse", "Tirado da fila"],
    });
  });

  it("nada a fazer devolve null", () => {
    expect(comMotivosDoColdCall({ lost_reasons: [...MOTIVOS_DE_PERDA_DO_COLD_CALL] })).toBeNull();
  });
});
