/**
 * O QUE A TELA OFERECE E O MOTOR DESCARTA — este arquivo é a amarra entre as duas pontas.
 *
 * O modo de falha que ele fecha, medido em `58187f0c`:
 *
 *   1. o dono do negócio abre o agente e liga o pacote **"Atender e responder"**;
 *   2. a tela mostra `crm_send_whatsapp_message` como crítica daquele pacote, com
 *      checkbox marcável — e `crm_request_human_handoff` entra sozinha quando ele
 *      liga o pacote de escalar;
 *   3. ele marca, salva, vê **"Agente publicado"** com a capacidade ligada;
 *   4. no turno, `lib/agent-engine/edge/crm/mcp-tools.ts` filtra as duas por
 *      `BLOCKED_TOOL_IDS` — e o ÚNICO sinal é um `log.warn` no log do worker,
 *      que ninguém abre.
 *
 * A capacidade de enviar e a de passar para um humano são do HARNESS (o engine
 * as executa pelo caminho seguro: anti-ban, opt-out, disclosure, silêncio durável).
 * A IA continua enviando e escalando — o que não existe é uma tool de catálogo
 * para isso. O defeito nunca foi a recusa: foi a recusa ser INVISÍVEL para quem
 * configurou.
 *
 * As duas pontas agora leem a MESMA lista (`lib/mcp/tools/ferramentas-do-harness.ts`),
 * e este teste cobra três coisas:
 *   - o servidor não serve como marcável o que o engine recusa;
 *   - nenhum pacote oferece (automática ou crítica) o que o turno descarta;
 *   - a lista não cresce em silêncio (controle positivo: o resto do catálogo
 *     continua marcável, e toda capacidade do harness ainda existe de verdade).
 */
import { describe, expect, it } from "vitest";

import { allTools } from "@/lib/mcp/tools";
import { TOOL_CATALOG } from "@/lib/mcp/tools/catalog";
import { juntarCatalogoComHandlers } from "@/lib/mcp/tools/catalogo-servido";
import {
  FERRAMENTAS_DO_HARNESS,
  IDS_DO_HARNESS,
  motivoDoHarness,
} from "@/lib/mcp/tools/ferramentas-do-harness";
import {
  capacidadesAutomaticasDoPacote,
  capacidadesCriticasDoPacote,
  type CapacidadeSelecionavel,
} from "@/lib/mcp/tools/selecao-por-pacote";
import { BLOCKED_TOOL_IDS } from "@/lib/agent-engine/edge/crm/mcp-tools";

/** O catálogo como a rota `/api/v1/mcp/tools` serve — a metade que a TELA lê. */
const SERVIDO = juntarCatalogoComHandlers(allTools, TOOL_CATALOG);

/** O catálogo como a regra de pacote o lê (a tela passa este mesmo shape). */
const PARA_SELECAO: ReadonlyArray<CapacidadeSelecionavel> = SERVIDO.map((c) => ({
  name: c.id,
  risco: c.risco,
  pacotes: c.pacotes,
  marcavel: c.marcavel,
}));

/** Todos os pacotes que alguma capacidade declara — sem importar a lista de pacotes. */
const PACOTES = Array.from(new Set(SERVIDO.flatMap((c) => c.pacotes)));

describe("capacidade do harness não é oferecida como marcável", () => {
  it("o engine e a tela leem a MESMA lista — duas listas divergiriam em silêncio", () => {
    // Controle positivo: a lista não está vazia. Se estivesse, tudo abaixo
    // passaria medindo nada.
    expect(IDS_DO_HARNESS.size).toBeGreaterThan(0);
    expect([...BLOCKED_TOOL_IDS].sort()).toEqual([...IDS_DO_HARNESS].sort());
  });

  it("toda capacidade do harness existe no catálogo e chega à tela como NÃO marcável, com motivo", () => {
    for (const { id, motivo } of FERRAMENTAS_DO_HARNESS) {
      // Controle positivo: o id existe de verdade. Um typo aqui faria o engine
      // bloquear o nada e a tela mostrar o nada — os dois passariam.
      const servida = SERVIDO.find((c) => c.id === id);
      expect(servida, `controle: ${id} existe no catálogo servido`).toBeDefined();

      expect(servida?.marcavel, `${id} não pode ser marcável na tela`).toBe(false);
      expect(servida?.motivo_nao_marcavel, `${id} precisa chegar com o motivo`).toBe(motivo);
      // O motivo é o que o dono lê no lugar do checkbox morto: tem que dizer algo.
      expect(motivo.length).toBeGreaterThan(40);
      expect(servida?.rotulo.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("o resto do catálogo continua marcável — não é desculpa para esconder capacidade", () => {
    const naoMarcaveis = SERVIDO.filter((c) => !c.marcavel).map((c) => c.id);
    expect(naoMarcaveis.sort()).toEqual([...IDS_DO_HARNESS].sort());
    // E o motivo é exclusivo de quem não é marcável.
    for (const c of SERVIDO) {
      if (c.marcavel) expect(c.motivo_nao_marcavel, `${c.id} é marcável`).toBeNull();
    }
  });

  it("nenhum pacote oferece o que o turno descarta — nem automática, nem crítica", () => {
    let oferecidas = 0;
    for (const pacote of PACOTES) {
      const automaticas = capacidadesAutomaticasDoPacote(PARA_SELECAO, pacote);
      const criticas = capacidadesCriticasDoPacote(PARA_SELECAO, pacote);
      oferecidas += automaticas.length + criticas.length;
      for (const nome of [...automaticas, ...criticas]) {
        expect(
          IDS_DO_HARNESS.has(nome),
          `o pacote ${pacote} oferece ${nome}, que o engine descarta`,
        ).toBe(false);
      }
    }
    // Controle positivo: a varredura passou por pacote com conteúdo de verdade.
    expect(oferecidas).toBeGreaterThan(0);
    expect(PACOTES.length).toBeGreaterThan(0);
  });

  it("a contagem do pacote 'atender' não promete mais do que o motor entrega", () => {
    const noCatalogo = SERVIDO.filter((c) => c.pacotes.includes("atender"));
    const harnessNoPacote = noCatalogo.filter((c) => IDS_DO_HARNESS.has(c.id));
    // Controle positivo: este era EXATAMENTE o pacote citado na issue — se a
    // lista deixar de ter membro aqui, o teste avisa em vez de passar vazio.
    expect(harnessNoPacote.map((c) => c.id)).toContain("crm_send_whatsapp_message");

    const oferecidas = capacidadesAutomaticasDoPacote(PARA_SELECAO, "atender");
    const criticas = capacidadesCriticasDoPacote(PARA_SELECAO, "atender");
    expect(oferecidas.length + criticas.length).toBe(noCatalogo.length - harnessNoPacote.length);
    // A crítica de envio sumiu daqui: é o checkbox que o dono marcava à toa.
    expect(criticas).not.toContain("crm_send_whatsapp_message");
    expect(capacidadesAutomaticasDoPacote(PARA_SELECAO, "atender")).not.toContain(
      "crm_send_whatsapp_message",
    );
  });

  it("o motivo que a tela mostra é pt-BR e não vaza nome de marca para o cliente", () => {
    for (const { id, motivo } of FERRAMENTAS_DO_HARNESS) {
      expect(motivo, id).toBe(motivoDoHarness(id));
      // pt-BR, frase inteira: é o texto que ocupa o lugar do checkbox morto.
      expect(motivo).toMatch(/[áéíóúãõç]| o agente|Não há/);
    }
    // Capacidade fora da lista não tem motivo — a função não inventa.
    expect(motivoDoHarness("crm_nome_que_nao_existe")).toBeNull();
  });
});
