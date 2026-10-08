import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";
import { MODULOS_OPCIONAIS } from "@/lib/instalacao/modulos";
import { NAV_CATALOG, type NavMetadata } from "@/lib/navigation/catalogo";
import { CAPACIDADES_DA_ORGANIZACAO } from "@/lib/organizacao/capacidades";
import {
  MODULOS_DA_EMPRESA,
  RECURSOS_OPCIONAIS,
  ROTULO_DE_QUEM_DECIDE,
  ROTULO_DO_ESTADO,
  ROTULO_DO_PADRAO,
  estadoDoRecurso,
  type FontesDeEstado,
} from "@/lib/recursos-opcionais/catalogo";

/**
 * A área "Recursos opcionais" só serve enquanto for COMPLETA (pedido do
 * mantenedor, doc 73: "as pessoas deviam ficar cientes de onde isso existe").
 * Uma lista que alguém esquece de atualizar volta ao problema de antes, só que
 * com uma tela dizendo que está tudo ali.
 *
 * Mesmo mecanismo de `navegacao-completude.test.ts`: o recurso novo que nasce
 * como módulo da instalação ou como porta condicionada no menu reprova aqui até
 * entrar no catálogo. Sem número fixo — as duas pontas vêm do código.
 */

const PORTAS = NAV_CATALOG as readonly NavMetadata[];
const MODULOS_NO_CATALOGO = new Set(RECURSOS_OPCIONAIS.flatMap((r) => (r.modulo ? [r.modulo] : [])));
const CAPACIDADES_NO_CATALOGO = new Set(
  RECURSOS_OPCIONAIS.flatMap((r) => (r.capacidade ? [r.capacidade] : [])),
);

describe("o catálogo de recursos opcionais não deixa recurso de fora", () => {
  it("todo módulo de MODULOS_OPCIONAIS tem a sua linha, com nome e o que faz", () => {
    const semLinha = MODULOS_OPCIONAIS.filter(
      (m) => !RECURSOS_OPCIONAIS.some((r) => r.nivel === "instalacao" && r.modulo === m && r.nome && r.oQueFaz),
    );
    expect(
      semLinha,
      `Módulo sem linha em lib/recursos-opcionais/catalogo.ts (TEXTO_DO_MODULO):\n  ${semLinha.join("\n  ")}`,
    ).toEqual([]);
  });

  it("toda porta do menu condicionada a módulo ou capacidade está no catálogo", () => {
    const fora = PORTAS.filter(
      (d) =>
        (d.modulo && !MODULOS_NO_CATALOGO.has(d.modulo)) ||
        (d.capacidade && !CAPACIDADES_NO_CATALOGO.has(d.capacidade)),
    ).map((d) => `${d.href} (${d.modulo ?? d.capacidade})`);
    expect(
      fora,
      `Porta de recurso opcional que a área "Recursos opcionais" não mostra. ` +
        `Declare o recurso em lib/recursos-opcionais/catalogo.ts:\n  ${fora.join("\n  ")}`,
    ).toEqual([]);
  });

  it("toda capacidade que a empresa liga está no catálogo", () => {
    const fora = CAPACIDADES_DA_ORGANIZACAO.filter((c) => !CAPACIDADES_NO_CATALOGO.has(c));
    expect(fora).toEqual([]);
  });

  it("ids não se repetem", () => {
    const ids = RECURSOS_OPCIONAIS.map((r) => r.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it("todo 'Ajustar' leva a uma tela que existe", () => {
    const mortos = RECURSOS_OPCIONAIS.flatMap((r) => (r.href ? [r.href] : [])).filter(
      (href) => {
        const [raiz, ...resto] = href.replace(/^\//, "").split("/");
        const dir =
          raiz === "admin"
            ? path.join(process.cwd(), "app", "admin", "(protected)", ...resto)
            : path.join(process.cwd(), "app", raiz ?? "", ...resto);
        return !fs.existsSync(path.join(dir, "page.tsx"));
      },
    );
    expect(mortos, `Link morto no catálogo:\n  ${[...new Set(mortos)].join("\n  ")}`).toEqual([]);
  });

  it("todo texto do catálogo tem espanhol", () => {
    const textos = [
      ...RECURSOS_OPCIONAIS.flatMap((r) => [r.nome, r.oQueFaz, ...(r.comoLigar ? [r.comoLigar] : [])]),
      ...Object.values(ROTULO_DO_ESTADO),
      ...Object.values(ROTULO_DE_QUEM_DECIDE),
      ...Object.values(ROTULO_DO_PADRAO),
    ];
    const semEspanhol = [...new Set(textos)].filter((t) => !DICIONARIO[t]?.es);
    expect(semEspanhol, "Linha em lib/i18n/dicionario.ts para cada um").toEqual([]);
  });
});

describe("o estado nunca lança e nunca inventa 'desligado'", () => {
  const vazio: FontesDeEstado = { modulos: [], settings: {}, servidor: {} };

  it("fonte que não respondeu vira 'não consegui ler', nunca 'desligado'", () => {
    const semLeitura: FontesDeEstado = { modulos: null, settings: null, servidor: {} };
    const conversa = RECURSOS_OPCIONAIS.find((r) => r.id === "conversa_fica_com_quem_atendeu")!;
    const email = RECURSOS_OPCIONAIS.find((r) => r.id === "email")!;
    const modulo = RECURSOS_OPCIONAIS.find((r) => r.id === "modulo:banco_externo")!;
    expect(estadoDoRecurso(conversa, semLeitura)).toBe("nao_lido");
    expect(estadoDoRecurso(email, semLeitura)).toBe("nao_lido");
    expect(estadoDoRecurso(modulo, semLeitura)).toBe("nao_lido");
  });

  it("settings malformado não derruba nenhuma linha", () => {
    const lixo: FontesDeEstado = {
      modulos: [...MODULOS_OPCIONAIS],
      settings: { routing: "x", security: [1], crm: null, jev: 42, base_de_conhecimento: "google" },
      servidor: { email: true },
    };
    for (const r of RECURSOS_OPCIONAIS) expect(() => estadoDoRecurso(r, lixo)).not.toThrow();
  });

  it("lê as chaves da empresa pela mesma régua das telas", () => {
    const acha = (id: string) => RECURSOS_OPCIONAIS.find((r) => r.id === id)!;
    const ligadas: FontesDeEstado = {
      ...vazio,
      settings: {
        routing: { conversation_stays_with_attendant: true, handoff_return_after_minutes: 30 },
        security: { mfa_required: true },
        colegas_podem_mexer_na_agenda: false,
      },
    };
    expect(estadoDoRecurso(acha("conversa_fica_com_quem_atendeu"), ligadas)).toBe("ligado");
    expect(estadoDoRecurso(acha("ia_volta_sozinha"), ligadas)).toBe("ligado");
    expect(estadoDoRecurso(acha("mfa_obrigatorio"), ligadas)).toBe("ligado");
    // Ausente = ligada; só o `false` explícito desliga (régua do banco).
    expect(estadoDoRecurso(acha("colegas_mexem_na_agenda"), ligadas)).toBe("desligado");
    expect(estadoDoRecurso(acha("colegas_mexem_na_agenda"), vazio)).toBe("ligado");
    expect(estadoDoRecurso(acha("conversa_fica_com_quem_atendeu"), vazio)).toBe("desligado");
  });

  it("recurso que exige módulo desligado no servidor fica desligado, mesmo com a chave da empresa", () => {
    const propostas = RECURSOS_OPCIONAIS.find((r) => r.id === "propostas_da_empresa")!;
    const chaveLigada = { proposals: { enabled: true } };
    expect(estadoDoRecurso(propostas, { ...vazio, settings: chaveLigada })).toBe("desligado");
    expect(estadoDoRecurso(propostas, { ...vazio, modulos: ["propostas"], settings: chaveLigada })).toBe("ligado");
  });
});

describe("o que é só de quem administra o servidor não aparece para a empresa", () => {
  it("a empresa não vê 'Cobrança dos seus clientes'; o catálogo do dono tem a linha", () => {
    const daEmpresa = MODULOS_DA_EMPRESA.map((r) => r.modulo);
    expect(daEmpresa).not.toContain("cobranca");
    // Controle: a lista não ficou vazia por acidente.
    expect(daEmpresa).toContain("banco_externo");
    expect(RECURSOS_OPCIONAIS.find((r) => r.modulo === "cobranca")?.href).toBe("/admin/sistema");
  });

  it("a tela da empresa lista os módulos por MODULOS_DA_EMPRESA", () => {
    const tela = fs.readFileSync(path.join(process.cwd(), "app/app/settings/recursos/page.tsx"), "utf8");
    expect(tela).toContain("MODULOS_DA_EMPRESA");
  });
});
