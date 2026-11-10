import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminEmConexao, novaConexaoDeCadencias } from "../support/cadencias-pg";
const pg = novaConexaoDeCadencias();
const admin = adminEmConexao(pg);
const agora = "2026-10-26T12:00:00Z";
beforeAll(async () => { await pg.connect(); await pg.query("create table public.sonda_cadencias_pg(id integer primary key,vence timestamptz,claim timestamptz,grupo text); create table public.sonda_cadencias_arrays(id integer primary key,documento jsonb check(jsonb_typeof(documento)='array'), legado json check(json_typeof(legado)='array'), etiquetas text[])"); });
afterAll(async () => { await pg.end(); });
beforeEach(async () => { await pg.query(`truncate public.sonda_cadencias_pg; insert into public.sonda_cadencias_pg values
  (1,'2026-10-25',null,'a'),(2,'2026-10-27','2026-10-25','b'),(3,'2026-10-25','2026-10-27','a'),(4,'2026-10-25','2026-10-25','a')`); });
describe("o instrumento de concorrência não ignora filtros nem contagem", () => {
  it("UPDATE respeita lte E (trava ausente OU expirada)", async () => {
    const { data, error } = await admin.from("sonda_cadencias_pg").update({ grupo: "feito" }).lte("vence", agora).or(`claim.is.null,claim.lt.${agora}`).select("id");
    expect(error).toBeNull(); expect(data?.map((r) => r.id).sort()).toEqual([1, 4]);
    expect((await pg.query("select id from public.sonda_cadencias_pg where grupo<>'feito' order by id")).rows.map((r) => r.id)).toEqual([2, 3]);
  });
  it("count exato conta o recorte antes do limit e HEAD não devolve dados", async () => {
    const { data, count, error } = await admin.from("sonda_cadencias_pg").select("id", { count: "exact", head: true }).eq("grupo", "a").lte("vence", agora).limit(1);
    expect(error).toBeNull(); expect(data).toBeNull(); expect(count).toBe(3);
  });
  it("OR não implementado estoura em vez de virar sucesso vazio", () => {
    expect(() => admin.from("sonda_cadencias_pg").update({ grupo: "x" }).or("grupo.eq.a,grupo.eq.b")).toThrow("não está implementado");
  });
  it("INSERT e UPDATE distinguem [] JSON de text[] vazio e preservam seus elementos", async () => {
    // Controle vermelho: o driver SEM o encoder vira {} para jsonb, mas []
    // nativo continua correto para text[]. O CHECK real recusa o primeiro.
    expect((await pg.query("select jsonb_typeof($1::jsonb) tipo, cardinality($2::text[]) total", [[], []])).rows).toEqual([{ tipo: "object", total: 0 }]);
    await expect(pg.query("insert into public.sonda_cadencias_arrays(id,documento) values(99,$1)", [[]])).rejects.toMatchObject({ code: "23514" });
    const inserir = await admin.from("sonda_cadencias_arrays").insert({ id: 1, documento: [], legado: [], etiquetas: [] }).select("*").single();
    expect(inserir.error).toBeNull(); expect(inserir.data).toMatchObject({ documento: [], legado: [], etiquetas: [] });
    const alterar = await admin.from("sonda_cadencias_arrays").update({ documento: [{ nome: "a,b" }], legado: ["x", "y"], etiquetas: ["a,b", 'c"d'] }).eq("id", 1).select("*").single();
    expect(alterar.error).toBeNull(); expect(alterar.data).toMatchObject({ documento: [{ nome: "a,b" }], legado: ["x", "y"], etiquetas: ["a,b", 'c"d'] });
    const voltar = await admin.from("sonda_cadencias_arrays").update({ documento: [], legado: [], etiquetas: [] }).eq("id", 1);
    expect(voltar.error).toBeNull();
    expect((await pg.query("select jsonb_typeof(documento) as tipo, json_typeof(legado) as legado, cardinality(etiquetas) as total from public.sonda_cadencias_arrays")).rows).toEqual([{ tipo: "array", legado: "array", total: 0 }]);
  });
});
