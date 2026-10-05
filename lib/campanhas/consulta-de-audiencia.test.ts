import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { FILTRO_VAZIO } from "./audiencia";
import { buscarCandidatos } from "./consulta-de-audiencia";

/**
 * `{{lead.x}}` NÃO PODE DERRUBAR A PREPARAÇÃO NEM PERDER O NEGÓCIO MAIS NOVO.
 *
 * A primeira versão punha os ids de TODA a audiência num único
 * `contact_id=in.(…)`: com a audiência padrão de 500 contatos a URL tinha
 * ~19,7 KB, e o gateway (Kong 2.8.1) devolve `414` acima de 8.192 B — a
 * preparação inteira caía. E o `.limit(n*4)` global cortava quem tem o negócio
 * mais antigo. Aqui a URL sai do `postgrest-js` de verdade e um PostgREST falso
 * aplica filtro, ordem, `offset/limit` e o corte de `max_rows`.
 */

const MURO_DO_GATEWAY = 8_192;
const MAX_ROWS = 1_000;
const uuid = (i: number, p = "1111") => `${String(i).padStart(8, "0")}-${p}-4111-8111-111111111111`;
const ORG = uuid(999, "9999");

interface Negocio {
  id: string;
  contact_id: string;
  created_at: string;
  custom_fields: Record<string, unknown>;
}

function json(corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Um PostgREST de mentira, com o comportamento que importa aqui. */
function bancoFalso(contatos: string[], negocios: Negocio[]) {
  const urls: string[] = [];
  const sb = createClient("http://127.0.0.1:54321", "x".repeat(200), {
    global: {
      fetch: async (entrada: RequestInfo | URL) => {
        const bruta = String(entrada);
        urls.push(bruta);
        const url = new URL(bruta);
        if (url.pathname.endsWith("/contacts")) {
          return json(
            contatos.map((id) => ({
              id,
              name: "Ana Souza",
              display_name: null,
              phone_number: "5511999990000",
              is_blocked: false,
              is_anonymized: false,
              consent: null,
            })),
          );
        }
        const filtroIn = url.searchParams.getAll("contact_id").find((v) => v.startsWith("in."));
        const ids = new Set(filtroIn ? filtroIn.slice(4, -1).split(",") : []);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const limite = Math.min(Number(url.searchParams.get("limit") ?? MAX_ROWS), MAX_ROWS);
        const linhas = negocios
          .filter((n) => ids.has(n.contact_id))
          .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
          .slice(offset, offset + limite)
          .map(({ contact_id, custom_fields }) => ({ contact_id, custom_fields }));
        return json(linhas);
      },
    },
  });
  return { sb, urls, urlsDeNegocio: () => urls.filter((u) => u.includes("/crm_leads")) };
}

const quando = (minutos: number) => new Date(Date.UTC(2026, 0, 1) + minutos * 60_000).toISOString();

async function candidatos(sb: ReturnType<typeof bancoFalso>["sb"]) {
  return buscarCandidatos(sb, {
    organizationId: ORG,
    filtro: { ...FILTRO_VAZIO, limite: 5000 },
    agora: new Date(Date.UTC(2026, 5, 1)),
    corpo: "Oi {{nome}}, {{lead.gancho}}",
  });
}

describe("negócios dos contatos para {{lead.x}}", () => {
  it("a sonda ENXERGA o estouro: os 500 ids numa URL só passam do muro — controle positivo", async () => {
    const { sb, urls } = bancoFalso([], []);
    const ids = Array.from({ length: 500 }, (_, i) => uuid(i));
    await sb.from("crm_leads").select("contact_id, custom_fields").in("contact_id", ids);
    expect(urls[0]!.length).toBeGreaterThan(MURO_DO_GATEWAY);
  });

  it("audiência de 500: mais de uma consulta, nenhuma URL acima do muro, e todo mundo acha o seu negócio", async () => {
    const contatos = Array.from({ length: 500 }, (_, i) => uuid(i));
    const negocios = contatos.map((c, i) => ({
      id: uuid(i, "2222"),
      contact_id: c,
      created_at: quando(i),
      custom_fields: { gancho: `gancho ${i}` },
    }));
    const banco = bancoFalso(contatos, negocios);

    const lista = await candidatos(banco.sb);

    const urls = banco.urlsDeNegocio();
    expect(urls.length, "os ids foram numa consulta só").toBeGreaterThan(1);
    for (const u of urls) expect(u.length).toBeLessThan(MURO_DO_GATEWAY);
    expect(lista).toHaveLength(500);
    expect(lista.filter((c) => c.lead?.gancho === undefined)).toEqual([]);
    expect(lista[499]!.lead?.gancho).toBe("gancho 499");
  });

  it("contato com muitos negócios no mesmo lote não esconde o mais novo do vizinho", async () => {
    // A tem 1.500 negócios recentes; o único negócio de B é mais antigo que todos.
    // Um `.limit` global, ou o corte de `max_rows` sem paginar, devolve só os de A.
    const [a, b] = [uuid(1), uuid(2)];
    const negocios: Negocio[] = Array.from({ length: 1500 }, (_, i) => ({
      id: uuid(i, "3333"),
      contact_id: a,
      created_at: quando(10_000 + i),
      custom_fields: { gancho: `a ${i}` },
    }));
    negocios.push(
      { id: uuid(1, "4444"), contact_id: b, created_at: quando(5), custom_fields: { gancho: "b velho" } },
      { id: uuid(2, "4444"), contact_id: b, created_at: quando(6), custom_fields: { gancho: "b novo" } },
    );
    const banco = bancoFalso([a, b], negocios);

    const lista = await candidatos(banco.sb);

    expect(lista.find((c) => c.contactId === a)?.lead?.gancho).toBe("a 1499");
    expect(lista.find((c) => c.contactId === b)?.lead?.gancho).toBe("b novo");
  });
});
