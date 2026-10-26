/**
 * O cofre de acessos dos clientes (docs/agencia/SPEC-cofre-e-formulario.md, F5).
 *
 * A senha só existe em claro dentro deste módulo, no instante de cifrar ou de
 * devolver a quem tem `cofre.ver_senhas` — nunca em log, aviso, WhatsApp, Drive
 * ou coluna de texto. Quem chama confere a permissão; aqui se registra cada
 * visualização.
 */
import { bufToBytea, byteaToBuffer, decryptKey, encryptKey } from "@/lib/crypto/aes_gcm";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { PLATAFORMAS_DO_FORMULARIO, ROTULO_DA_PLATAFORMA, type Respostas } from "../formulario/perguntas";
import type { ItemDoCofre, PlataformaDoCofre } from "./vocabulario";

export { PLATAFORMAS_DO_COFRE, ROTULO_DA_PLATAFORMA_DO_COFRE, type ItemDoCofre, type PlataformaDoCofre } from "./vocabulario";

export function cifrarSenha(senha: string): { senha_ct: string; senha_iv: string; senha_tag: string } {
  const c = encryptKey(senha);
  return { senha_ct: bufToBytea(c.ciphertext), senha_iv: bufToBytea(c.iv), senha_tag: bufToBytea(c.tag) };
}

export function decifrarSenha(l: { senha_ct: unknown; senha_iv: unknown; senha_tag: unknown }): string | null {
  if (!l.senha_ct) return null;
  try {
    return decryptKey({ ciphertext: byteaToBuffer(l.senha_ct), iv: byteaToBuffer(l.senha_iv), tag: byteaToBuffer(l.senha_tag) });
  } catch {
    logger.warn("agência: senha do cofre não decifrou (chave trocada?)");
    return null;
  }
}


/** Os itens do cofre de um cliente, SEM as senhas. */
export async function listarCofre(clienteId: string): Promise<ItemDoCofre[]> {
  const db = createAdminClient();
  const { data } = await db
    .from("agencia_cofre_itens")
    .select("id, plataforma, rotulo, login, extra, senha_ct, origem, atualizado_em")
    .eq("cliente_id", clienteId)
    .order("plataforma")
    .order("rotulo");
  const itens = (data ?? []) as Array<{
    id: string;
    plataforma: PlataformaDoCofre;
    rotulo: string;
    login: string | null;
    extra: string | null;
    senha_ct: unknown;
    origem: "formulario" | "manual";
    atualizado_em: string;
  }>;
  const { data: vistas } = itens.length
    ? await db
        .from("agencia_cofre_visualizacoes")
        .select("item_id, user_id, visto_em")
        .in("item_id", itens.map((i) => i.id))
        .order("visto_em", { ascending: false })
        .limit(200)
    : { data: [] };
  const ultimaPorItem = new Map<string, { user_id: string | null; visto_em: string }>();
  for (const v of (vistas ?? []) as Array<{ item_id: string; user_id: string | null; visto_em: string }>) {
    if (!ultimaPorItem.has(v.item_id)) ultimaPorItem.set(v.item_id, v);
  }
  const usuarios = [...new Set([...ultimaPorItem.values()].map((v) => v.user_id).filter((x): x is string => !!x))];
  const { data: membros } = usuarios.length
    ? await db.from("agencia_membros").select("user_id, nome").in("user_id", usuarios)
    : { data: [] };
  const nomeDe = new Map(((membros ?? []) as Array<{ user_id: string; nome: string }>).map((m) => [m.user_id, m.nome]));
  return itens.map((i) => {
    const v = ultimaPorItem.get(i.id);
    return {
      id: i.id,
      plataforma: i.plataforma,
      rotulo: i.rotulo,
      login: i.login,
      extra: i.extra,
      temSenha: !!i.senha_ct,
      origem: i.origem,
      atualizadoEm: i.atualizado_em,
      ultimaVisualizacao: v ? { quem: v.user_id ? (nomeDe.get(v.user_id) ?? "Administrador") : null, quando: v.visto_em } : null,
    };
  });
}

/** Registra que alguém viu uma senha (ou gerou o relatório). Nunca lança. */
export async function registrarVisualizacao(p: {
  itemId: string | null;
  clienteId: string;
  userId: string;
  motivo: "ver" | "relatorio";
}): Promise<void> {
  const { error } = await createAdminClient()
    .from("agencia_cofre_visualizacoes")
    .insert({ item_id: p.itemId, cliente_id: p.clienteId, user_id: p.userId, motivo: p.motivo });
  if (error) logger.error("agência: visualização do cofre não registrou", { codigo: error.code, motivo: p.motivo });
}

/**
 * Grava no cofre os acessos que vieram do formulário (F4): substitui os que o
 * formulário anterior tinha posto, sem tocar nos cadastrados à mão.
 */
export async function gravarAcessosDoFormulario(clienteId: string, formularioId: string, acessos: Respostas["acessos"]): Promise<number> {
  const db = createAdminClient();
  const linhas = PLATAFORMAS_DO_FORMULARIO.flatMap((p) => {
    const a = acessos[p];
    if (a.naoTem || (!a.login && !a.senha && !a.pagina)) return [];
    return [
      {
        cliente_id: clienteId,
        plataforma: p,
        rotulo: ROTULO_DA_PLATAFORMA[p],
        login: a.login || null,
        extra: a.pagina || null,
        ...(a.senha ? cifrarSenha(a.senha) : {}),
        origem: "formulario",
        formulario_id: formularioId,
      },
    ];
  });
  await db.from("agencia_cofre_itens").delete().eq("cliente_id", clienteId).eq("origem", "formulario");
  if (linhas.length) {
    const { error } = await db.from("agencia_cofre_itens").insert(linhas);
    if (error) {
      logger.error("agência: acessos do formulário não foram para o cofre", { codigo: error.code });
      return 0;
    }
  }
  return linhas.length;
}
