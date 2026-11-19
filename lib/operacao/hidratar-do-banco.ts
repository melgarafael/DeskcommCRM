/**
 * O leitor AO VIVO do relatório guardado (`LeitorAoVivo`, `conteudo.ts`) sobre o
 * banco. `db` é o client da SESSÃO: a RLS recorta o que quem lê pode ver, e a
 * organização vai ESCRITA em toda consulta. Só os nomes da equipe vêm pelo
 * service role (`fn_nomes_dos_membros`, que a sessão não executa), com a
 * organização da sessão.
 *
 * Erro de leitura LANÇA, nunca vira mapa vazio: um mapa vazio se leria como
 * "contato apagado / não registrado", e uma falha do banco não pode se passar
 * por dado ausente. `hidratar` pega a falha e a tela diz "não foi possível ler
 * agora".
 *
 * Nada aqui é cache: o nome sai da linha de `contacts` de AGORA — anonimizada,
 * ela diz `Cliente Anonimizado #N`, e é isso que a tela mostra.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";

import type { ContatoAtual, LeitorAoVivo } from "./conteudo";
import type { NomesDaEquipe } from "./operacao-do-dia";

const LOTE = 200;

async function emLotes<T>(ids: string[], ler: (lote: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += LOTE) out.push(...(await ler(ids.slice(i, i + LOTE))));
  return out;
}

export function leitorDoBanco(db: SupabaseClient, orgId: string, nomesDaEquipe?: NomesDaEquipe): LeitorAoVivo {
  return {
    async contatos(ids) {
      const linhas = await emLotes(ids, async (lote) => {
        const { data, error } = await db
          .from("contacts")
          .select("id, name, display_name, phone_number, social_identity")
          .eq("organization_id", orgId)
          .in("id", lote);
        if (error) throw new Error(error.message);
        return (data ?? []) as Array<{
          id: string;
          name: string | null;
          display_name: string | null;
          phone_number: string | null;
          social_identity: string | null;
        }>;
      });
      return new Map<string, ContatoAtual>(
        linhas.map((c) => [
          c.id,
          { nome: nomeDoContato(c), telefone: c.phone_number?.trim() || null, identidade: c.social_identity?.trim() || null },
        ]),
      );
    },
    async conversas(ids) {
      const linhas = await emLotes(ids, async (lote) => {
        const { data, error } = await db
          .from("conversations")
          .select("id, last_message_preview, assigned_to_user_name")
          .eq("organization_id", orgId)
          .in("id", lote);
        if (error) throw new Error(error.message);
        return (data ?? []) as Array<{ id: string; last_message_preview: string | null; assigned_to_user_name: string | null }>;
      });
      return new Map(
        linhas.map((c) => [c.id, { previa: c.last_message_preview?.trim() || null, responsavel: c.assigned_to_user_name?.trim() || null }]),
      );
    },
    async passagens(ids) {
      const linhas = await emLotes(ids, async (lote) => {
        const { data, error } = await db
          .from("passagens_de_atendimento")
          .select("conversation_id, title, body")
          .eq("organization_id", orgId)
          .in("conversation_id", lote)
          .order("criado_em", { ascending: false })
          .limit(1000);
        if (error) throw new Error(error.message);
        return (data ?? []) as Array<{ conversation_id: string; title: string | null; body: string | null }>;
      });
      const out = new Map<string, string>();
      for (const p of linhas) {
        if (out.has(p.conversation_id)) continue;
        const texto = [p.title, p.body].filter((s) => s && s.trim() !== "").join(" — ").trim();
        if (texto !== "") out.set(p.conversation_id, texto.slice(0, 400));
      }
      return out;
    },
    async tarefas(idsDeContato) {
      const linhas = await emLotes(idsDeContato, async (lote) => {
        const { data, error } = await db
          .from("crm_tasks")
          .select("contact_id, title, due_date")
          .eq("organization_id", orgId)
          .in("contact_id", lote)
          .in("status", ["pending", "in_progress"])
          .order("due_date", { ascending: true, nullsFirst: false })
          .limit(1000);
        if (error) throw new Error(error.message);
        return (data ?? []) as Array<{ contact_id: string | null; title: string }>;
      });
      const out = new Map<string, string>();
      for (const t of linhas) if (t.contact_id && !out.has(t.contact_id)) out.set(t.contact_id, t.title);
      return out;
    },
    async negocios(ids) {
      const linhas = await emLotes(ids, async (lote) => {
        const { data, error } = await db
          .from("crm_leads")
          .select("id, title, lost_reason")
          .eq("organization_id", orgId)
          .in("id", lote);
        if (error) throw new Error(error.message);
        return (data ?? []) as Array<{ id: string; title: string | null; lost_reason: string | null }>;
      });
      return new Map(linhas.map((n) => [n.id, { titulo: n.title, motivo_da_perda: n.lost_reason?.trim() || null }]));
    },
    async nomes(ids) {
      if (ids.length === 0 || !nomesDaEquipe) return new Map();
      // A falha SOBE: `hidratar` a transforma em "não foi possível ler agora".
      return nomesDaEquipe(ids);
    },
  };
}
