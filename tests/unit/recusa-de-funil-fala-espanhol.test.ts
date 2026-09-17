/**
 * A RECUSA DE FRONTEIRA DE FUNIL (P-01) FALA ESPANHOL.
 *
 * O texto desta recusa é CHAVE do dicionário. Quando o PR que criou a rota de
 * clone reescreveu a frase nos dois call sites (`/move` e o `moveLeadHandler`)
 * sem tocar `lib/i18n/dicionario.ts`, `traduzir` passou a cair no fallback — quem
 * usa o produto em espanhol voltou a ler português — e as duas entradas antigas
 * ficaram órfãs. O `verify` ficou verde: o gate de i18n
 * (`tests/unit/i18n-espanhol-cobre-a-tela.test.ts`) varre `app` e `components` e
 * ignora `api`, que é justamente onde esta frase vive.
 *
 * Este arquivo mede o COMPORTAMENTO de `traduzir` sobre a constante que os dois
 * call sites usam — não o texto-fonte deles. Mudar a frase e esquecer a tradução
 * deixa isto vermelho.
 */
import { describe, expect, it } from "vitest";

import { traduzir } from "@/lib/i18n/dicionario";
import { ACTIVITY_LABELS } from "@/lib/leads/activity-vocabulary";
import {
  FUNIL_DE_DESTINO_NAO_ENCONTRADO,
  ORIGEM_SEM_ETAPA_DE_PERDA,
  RECUSA_DE_TROCA_DE_FUNIL,
  escolheEtapaDeDestino,
  recusaTrocaDeFunil,
  type EtapaDoFunil,
} from "@/lib/leads/clonar-para-funil";

describe("mover para outro funil, em espanhol", () => {
  it("a recusa tem tradução — e não volta em português pelo fallback", () => {
    const es = traduzir(RECUSA_DE_TROCA_DE_FUNIL, "es");
    expect(es).not.toBe(RECUSA_DE_TROCA_DE_FUNIL);
    expect(es).toContain("embudo");
  });

  it("e continua apontando o endpoint do clone nas duas línguas", () => {
    // O ponteiro é o que o consumidor lê para saber o que fazer: uma tradução
    // que o perca transforma a recusa num beco, que é o defeito original.
    for (const idioma of ["pt-BR", "es"] as const) {
      expect(traduzir(RECUSA_DE_TROCA_DE_FUNIL, idioma)).toContain(
        "/api/v1/leads/[id]/clone",
      );
    }
  });
});

/**
 * AS RECUSAS DA PRÓPRIA TROCA DE FUNIL.
 *
 * A rota `POST /api/v1/leads/[id]/clone` nasceu com sete frases passando por
 * `traduzir` e nenhuma no dicionário: quem usa o produto em espanhol recebia
 * todas em português. O gate de i18n não viu pelo mesmo motivo da recusa de
 * cima — ele varre telas, e a frase mora em `lib/` e `app/api`.
 *
 * As frases são tiradas das FUNÇÕES que as devolvem, provocando cada ramo — não
 * de uma lista copiada aqui, que ficaria verde com uma frase nova esquecida.
 */
function etapa(over: Partial<EtapaDoFunil>): EtapaDoFunil {
  return {
    id: "e1",
    pipeline_id: "p2",
    position: 1000,
    is_won: false,
    is_lost: false,
    is_archived: false,
    ...over,
  };
}

function textoDe(r: { texto: string } | { ok: true } | null): string {
  if (r === null || !("texto" in r)) throw new Error("esperava uma recusa");
  return r.texto;
}

describe("a troca de funil recusa em espanhol", () => {
  const recusas: Record<string, string> = {
    pipeline_unchanged: textoDe(recusaTrocaDeFunil({ pipeline_id: "p1", status: "open" }, "p1")),
    lead_not_open: textoDe(recusaTrocaDeFunil({ pipeline_id: "p1", status: "won" }, "p2")),
    stage_pipeline_mismatch: textoDe(escolheEtapaDeDestino([etapa({})], "outra")),
    stage_destino_terminal: textoDe(escolheEtapaDeDestino([etapa({ is_lost: true })], "e1")),
    pipeline_without_initial_stage: textoDe(escolheEtapaDeDestino([etapa({ is_won: true })])),
    pipeline_not_found: FUNIL_DE_DESTINO_NAO_ENCONTRADO,
    pipeline_no_lost_stage: ORIGEM_SEM_ETAPA_DE_PERDA,
  };

  for (const [codigo, texto] of Object.entries(recusas)) {
    it(`${codigo}: tem tradução`, () => {
      expect(traduzir(texto, "es")).not.toBe(texto);
    });
  }

  it("a linha do tempo do negócio novo também", () => {
    const rotulo = ACTIVITY_LABELS.moved_from_pipeline;
    expect(traduzir(rotulo, "es")).not.toBe(rotulo);
    for (const razao of ["Veio de outro funil", "Levado para outro funil"]) {
      expect(traduzir(razao, "es")).not.toBe(razao);
    }
  });
});
