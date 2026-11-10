/**
 * Semente do módulo API Oficial da Meta (Admin): não cria nada. Ela devolve a
 * instalação ao estado de fábrica do App da Meta — sem linha em
 * `platform_meta_app` —, que é o que a primeira lição fotografa ("Nunca
 * configurado por aqui.", "Ainda não existe.").
 *
 * As lições 2 e 3 clicam em "Salvar" de verdade (é local: cifra e grava no
 * banco, nada sai para a Meta), então a linha fica preenchida até a próxima
 * lição. A última lição do módulo só lê, para o módulo terminar com a linha
 * apagada: preenchida, ela mudaria as fotos de "Recursos opcionais" e da aba
 * "API Oficial (Meta)" de Conexões. A base também guarda e restaura
 * `platform_meta_app`, inclusive depois de uma captura parcial.
 *
 * DELETE pelo banco direto, e não pelo client: o `service_role` só tem
 * select/insert/update nessa tabela, e esvaziar as colunas deixaria o
 * `updated_at` preenchido — a tela diria "Última alteração em …" numa
 * instalação que nunca configurou nada.
 */
import pg from "pg";

import type { Contexto } from "../semear-demonstracao";
import { exigirBancoLocal } from "../seguranca";

export async function semear(c: Contexto) {
  const url = exigirBancoLocal(process.env.SUPABASE_DB_URL);
  const cli = new pg.Client({ connectionString: url });
  await cli.connect();
  try {
    const identidade = await cli.query("select id from public.organizations where id = $1", [c.org]);
    if (identidade.rowCount !== 1) throw new Error("admin-meta: Postgres direto não corresponde à bancada Supabase");
    const r = await cli.query("delete from public.platform_meta_app where id = 1");
    console.info(`admin-meta: App da Meta ${r.rowCount ? "apagado" : "já estava vazio"}`);
  } finally {
    await cli.end();
  }
}
