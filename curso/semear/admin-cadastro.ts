/**
 * Semente do módulo Cadastro (Admin): três pedidos de empresa nova esperando
 * aprovação, para a fila do modo "Cadastro com aprovação" ter o que mostrar.
 *
 * O modo de cadastro NÃO é mexido aqui: a base devolve `platform_settings` ao
 * estado de fábrica ("aberto") antes de cada lição, e a fila só aparece quando a
 * lição liga a chave pela tela. Desligado, os pedidos ficam invisíveis.
 *
 * `registration_requests` não tem DELETE nem para o service_role, então a
 * semente não apaga: devolve o pedido mais recente de cada conta a "pendente"
 * (uma lição pode ter recusado um) e só insere quando a conta nunca pediu. As
 * contas (auth) são confirmadas e ficam de uma rodada para a outra; nenhuma é
 * membro de empresa nenhuma, e ninguém daqui entra no sistema.
 */
import { type Contexto, exigir, ha, semErro } from "../semear-demonstracao";

const HORA = 60;
const DIA = 24 * HORA;

const PEDIDOS = [
  { email: "camila.reis@nutrirclinica.com.br", nome: "Camila Reis", empresa: "Nutrir Nutrição Clínica", ha: 2 * DIA + 3 * HORA },
  { email: "leonardo.alves@espacomovimento.com.br", nome: "Leonardo Alves", empresa: "Espaço Movimento Fisioterapia", ha: 20 * HORA },
  { email: "contato@odontovitasorrisos.com.br", nome: "Beatriz Fontes", empresa: "OdontoVita Sorrisos", ha: 2 * HORA },
];

export async function semear(c: Contexto) {
  const { db } = c;
  const r = await db.auth.admin.listUsers({ perPage: 1000 });
  if (r.error) throw new Error(`listUsers: ${r.error.message}`);

  for (const p of PEDIDOS) {
    let id = r.data.users.find((u) => u.email === p.email)?.id;
    if (!id) {
      // senha aleatória: ninguém daqui entra no sistema
      const novo = await db.auth.admin.createUser({ email: p.email, password: crypto.randomUUID(), email_confirm: true, user_metadata: { full_name: p.nome } });
      if (novo.error || !novo.data.user) throw new Error(`createUser ${p.email}: ${novo.error?.message ?? "sem usuário"}`);
      id = novo.data.user.id;
    }
    const pedido = { requested_organization_name: p.empresa, status: "pending", decided_by: null, decided_at: null, created_at: ha(p.ha) };
    const existentes = exigir(
      await db.from("registration_requests").select("id").eq("user_id", id).order("created_at", { ascending: false }),
      `pedidos de ${p.email}`,
    ) as Array<{ id: string }>;
    // só um pendente por conta (índice único parcial): os mais antigos ficam recusados
    for (const velho of existentes.slice(1)) {
      semErro(await db.from("registration_requests").update({ status: "rejected", decided_at: ha(30 * DIA) }).eq("id", velho.id), `arquivar pedido de ${p.email}`);
    }
    if (existentes[0]) semErro(await db.from("registration_requests").update(pedido).eq("id", existentes[0].id), `pedido de ${p.email}`);
    else semErro(await db.from("registration_requests").insert({ user_id: id, ...pedido }), `pedido de ${p.email}`);
  }
}
