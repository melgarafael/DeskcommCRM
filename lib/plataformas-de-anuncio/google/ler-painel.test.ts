import { describe, expect, it, vi } from "vitest";
import { lerPainelGoogle } from "./ler-painel";

const negocio = {
  id: "a", organization_id: "org-a", created_at: "2026-04-02T01:10:00Z",
  source: "google_ads", status: "won", value_cents: 12_000, currency: "BRL" as string | null,
  google_customer_id: "1111111111", google_campaign_id: "42", utm_campaign: "Verão",
  utm_term: "palavra A", gclid: "identificador-privado",
};

// O limite do servidor é menor que o tamanho de página solicitado, como pode ocorrer em self-host.
function banco(dados: (typeof negocio)[], falharNaPagina?: number) {
  let paginas = 0;
  const select = vi.fn(() => {
    let pagina = dados;
    return {
      eq(campo: "organization_id", valor: string) { pagina = pagina.filter(n => n[campo] === valor); return this; },
      or: vi.fn().mockReturnThis(),
      gte(campo: "created_at", valor: string) { pagina = pagina.filter(n => n[campo] >= valor); return this; },
      lt(campo: "created_at", valor: string) { pagina = pagina.filter(n => n[campo] < valor); return this; },
      gt(campo: "id", valor: string) { pagina = pagina.filter(n => n[campo] > valor); return this; },
      order: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(),
      then(resolve: (r: unknown) => void) {
        paginas++;
        resolve(paginas === falharNaPagina ? { error: { code: "falha" } } : { data: pagina.slice(0, 2) });
      },
    };
  });
  return { db: { from: () => ({ select }) } as never, select };
}

const argumentos = ["org-a", "2026-04-01", "2026-04-04", "America/Sao_Paulo", "BRL"] as const;

describe("negócios do Google Ads no painel", () => {
  it("agrega pelo dia local, preserva campanhas homônimas por conta e separa moedas", async () => {
    const { db, select } = banco([
      negocio,
      { ...negocio, id: "b", status: "lost", currency: null },
      { ...negocio, id: "c", google_customer_id: "222-222-2222", currency: "USD" },
      { ...negocio, id: "d", google_customer_id: "", google_campaign_id: "", utm_campaign: "", utm_term: "", currency: "USD" },
      { ...negocio, id: "e", organization_id: "outra-org" },
      { ...negocio, id: "f", created_at: "2026-04-04T04:00:00Z" },
    ]);
    const linhas = await lerPainelGoogle(db, ...argumentos);
    expect(linhas).toMatchObject([
      { dia: "2026-04-01", conta: "1111111111", moeda: "BRL", negocios: 2, ganhos: 1, perdidos: 1, valorGanhoCentavos: 12_000 },
      { conta: "2222222222", moeda: "USD", negocios: 1, ganhos: 1 },
      { conta: null, campanha: null, campanhaId: null, palavraChave: null, negocios: 1 },
    ]);
    expect(select).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(linhas)).not.toContain(negocio.gclid);
  });

  it("interrompe em caso de falha em vez de apresentar totais parciais como completos", async () => {
    const { db } = banco([negocio], 2);
    await expect(lerPainelGoogle(db, ...argumentos)).rejects.toThrow("Falha ao consultar");
  });
});
