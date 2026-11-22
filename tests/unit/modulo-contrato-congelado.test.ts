/**
 * CONTRATO CONGELADO DO MÓDULO CONECTADO (Spec 33, F6, tarefa 2).
 *
 * Um módulo conectado é escrito UMA vez, fora do CRM, e precisa continuar funcionando quando o CRM
 * atualiza. O que ele alcança é contrato: tirar uma rota, trocar uma área de lugar ou renomear uma área
 * só pode acontecer junto de uma subida de `HOST_API_VERSION` (lib/extensions/manifest.ts), que é o que
 * faz o CRM suspender os módulos antigos (`checkCompatibility` + `module_incompatible`) — em TODA
 * instalação. Por isso a subida é reservada a mudança incompatível.
 *
 * Mudança no TEXTO de um schema (ou schema que sai de uma rota que continua) não é quebra automática: o
 * hash não separa campo opcional novo de campo obrigatório novo. Ela reprova como "revisar" — quem muda
 * decide, regenera o instantâneo e diz no PR; só sobe a versão se ficou incompatível.
 *
 * O que este teste congela, tudo DERIVADO DE ARQUIVOS (sem banco, sem rodar rota):
 *   1. o conjunto de áreas (`EXTENSION_AREAS`) e as 18 permissões `area.<área>.<leitura|escrita>`;
 *   2. por área, a lista ordenada de pares `MÉTODO /api/v1/modelo` que `areaDaPorta` libera, varrendo
 *      `app/api/v1/**\/route.ts` (método = função `GET|POST|...` exportada pela rota);
 *   3. por rota liberada, os schemas Zod que ela passa a `.parse/.safeParse` (nome, origem e hash do
 *      TEXTO da definição) e os schemas cujo nome diz que são de resposta.
 *
 * O que NÃO congela (declarado em evidence/modulo-conectado-f6/declaracoes.md): o formato das respostas
 * de rota que não declaram schema (a maioria monta o corpo com `ok()`), schemas que a definição
 * referencia indiretamente (muda o schema filho, o hash do pai não muda), validação feita à mão sem Zod,
 * e o comportamento da rota.
 *
 * ── Como regenerar o instantâneo ────────────────────────────────────────────
 *
 *     UPDATE_CONTRATO=1 pnpm exec vitest run tests/unit/modulo-contrato-congelado.test.ts
 *
 * reescreve `tests/unit/__contrato__/modulo-contrato.json`. A regeneração se RECUSA a gravar uma quebra
 * (rota, área ou permissão que saiu) se `HOST_API_VERSION` não for maior que a do instantâneo; grava
 * acréscimo e "revisar" sem subir a versão. Não há script novo no `package.json`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { areaDaPorta } from "@/lib/auth/portas-de-token/areas";
import { EXTENSION_AREAS, permissaoDaArea } from "@/lib/extensions/areas";
import { HOST_API_VERSION } from "@/lib/extensions/manifest";

import {
  compararContratos,
  derivarContrato,
  metodosExportados,
  modeloDaRota,
  type Contrato,
} from "./helpers/contrato-do-modulo";

const RAIZ = process.cwd();
const INSTANTANEO = join(RAIZ, "tests/unit/__contrato__/modulo-contrato.json");

function atual(): Contrato {
  return derivarContrato({
    raiz: RAIZ,
    hostApiVersion: HOST_API_VERSION,
    areas: EXTENSION_AREAS,
    permissaoDaArea: permissaoDaArea as unknown as (area: string, modo: string) => string,
    areaDaPorta,
  });
}

const PASSO_A_PASSO =
  "Se a mudança tira ou muda algo que um módulo já escrito usa, suba HOST_API_VERSION (lib/extensions/manifest.ts) " +
  "e regenere o instantâneo (UPDATE_CONTRATO=1, ver o cabeçalho de tests/unit/modulo-contrato-congelado.test.ts). " +
  "Se só acrescenta algo, basta regenerar o instantâneo e dizer isso no PR.";

const PASSO_A_PASSO_REVISAR =
  "Um schema mudou ou saiu de uma rota liberada a módulo. Se ficou incompatível (campo obrigatório novo, " +
  "campo tirado, tipo trocado), suba HOST_API_VERSION (lib/extensions/manifest.ts) e regenere o instantâneo. " +
  "Se é aditivo (campo opcional novo, só reorganização), só regenere (UPDATE_CONTRATO=1) e diga no PR.";

describe("o contrato que o módulo conectado enxerga está congelado", () => {
  const agora = atual();

  if (process.env.UPDATE_CONTRATO === "1") {
    it("UPDATE_CONTRATO=1: reescreve o instantâneo (recusa quebra sem subir host_api)", () => {
      if (existsSync(INSTANTANEO)) {
        const antes = JSON.parse(readFileSync(INSTANTANEO, "utf8")) as Contrato;
        const { quebras } = compararContratos(antes, agora);
        if (quebras.length > 0 && HOST_API_VERSION <= antes.host_api_version) {
          throw new Error(
            `Há quebra de contrato e HOST_API_VERSION (${HOST_API_VERSION}) não subiu em relação ao instantâneo ` +
              `(${antes.host_api_version}). Suba HOST_API_VERSION (lib/extensions/manifest.ts) e regenere o instantâneo.\n` +
              quebras.join("\n"),
          );
        }
      }
      mkdirSync(dirname(INSTANTANEO), { recursive: true });
      writeFileSync(INSTANTANEO, `${JSON.stringify(agora, null, 2)}\n`);
    });
    return;
  }

  it("a derivação enxerga o contrato inteiro (um conjunto vazio passaria por vacuidade)", () => {
    expect(agora.areas).toHaveLength(9);
    expect(agora.permissoes).toHaveLength(18);
    const total = Object.values(agora.rotas).reduce((n, l) => n + l.length, 0);
    expect(total, "quase nenhuma rota liberada a módulo foi encontrada: a varredura quebrou").toBeGreaterThan(40);
    expect(Object.keys(agora.formatos).length).toBeGreaterThan(0);
  });

  it("o leitor de métodos entende as três formas de exportar", () => {
    expect(metodosExportados("export async function GET() {}\nexport const POST = x;\nexport { h as PATCH };")).toEqual([
      "GET",
      "PATCH",
      "POST",
    ]);
    expect(modeloDaRota("/r", "/r/app/api/v1/pipelines/[pipelineId]/stages/route.ts")).toBe("/api/v1/pipelines/[id]/stages");
  });

  it("o instantâneo existe", () => {
    expect(
      existsSync(INSTANTANEO),
      "tests/unit/__contrato__/modulo-contrato.json não existe: gere com UPDATE_CONTRATO=1",
    ).toBe(true);
  });

  it("áreas, permissões, rotas por área e formatos batem com o instantâneo", () => {
    const antes = JSON.parse(readFileSync(INSTANTANEO, "utf8")) as Contrato;
    const { quebras, revisar, acrescimos } = compararContratos(antes, agora);

    if (quebras.length > 0 && HOST_API_VERSION <= antes.host_api_version) {
      throw new Error(
        `O contrato do módulo conectado mudou de forma incompatível sem subir HOST_API_VERSION ` +
          `(${HOST_API_VERSION}, igual à do instantâneo):\n- ${quebras.join("\n- ")}\n${PASSO_A_PASSO}`,
      );
    }
    if (revisar.length > 0) {
      throw new Error(
        `O instantâneo do contrato do módulo está desatualizado:\n- ${[...revisar, ...acrescimos].join("\n- ")}\n${PASSO_A_PASSO_REVISAR}`,
      );
    }
    if (quebras.length > 0 || acrescimos.length > 0) {
      throw new Error(
        `O instantâneo do contrato do módulo está desatualizado:\n- ${[...quebras, ...acrescimos].join("\n- ")}\n${PASSO_A_PASSO}`,
      );
    }
    if (antes.host_api_version !== HOST_API_VERSION) {
      throw new Error(
        `HOST_API_VERSION mudou (${antes.host_api_version} → ${HOST_API_VERSION}) e o instantâneo não foi regenerado. ${PASSO_A_PASSO}`,
      );
    }
    expect(agora).toEqual(antes);
  });

  it("a comparação distingue quebra de acréscimo (a regra que o teste acima aplica)", () => {
    const base = atual();
    const comRotaNova = structuredClone(base);
    comRotaNova.rotas.contatos = [...(comRotaNova.rotas.contatos ?? []), "GET /api/v1/contacts/novo"];
    expect(compararContratos(base, comRotaNova)).toEqual({ quebras: [], revisar: [], acrescimos: expect.any(Array) });
    expect(compararContratos(base, comRotaNova).acrescimos).toHaveLength(1);
    const semRota = structuredClone(base);
    semRota.rotas.contatos = (semRota.rotas.contatos ?? []).slice(1);
    expect(compararContratos(base, semRota).quebras).toHaveLength(1);
    const semArea = structuredClone(base);
    semArea.areas = semArea.areas.slice(1);
    expect(compararContratos(base, semArea).quebras.length).toBeGreaterThan(0);
    const [modelo, formato] = Object.entries(base.formatos).find(([, f]) => f.corpo.length > 0)!;
    const schemaMudou = structuredClone(base);
    schemaMudou.formatos[modelo]!.corpo[0]!.hash = `outro-${formato.corpo[0]!.hash}`;
    expect(compararContratos(base, schemaMudou)).toEqual({
      quebras: [],
      revisar: [`formato de ${modelo}: o schema de corpo "${formato.corpo[0]!.nome}" mudou`],
      acrescimos: [],
    });
  });
});
