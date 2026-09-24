/**
 * O pedido de empresa nova numa instalação em `com_aprovacao` (migration 0383).
 *
 * A fila é desenho de @betoarts (PR #714). Duas partes do desenho original
 * ficaram de fora por serem bloqueadores de segurança publicados no PR:
 *
 * - o pedido para ENTRAR numa empresa existente, que exigia listar as empresas
 *   da instalação a visitante anônimo. Quem entra numa empresa existente entra
 *   pelo convite, o código que o produto já tem;
 * - marcar o e-mail como confirmado ao criar o pedido. Este módulo nunca toca
 *   na confirmação: quem chega aqui já tem sessão, e a sessão só existe depois
 *   do fluxo normal do provedor de auth.
 *
 * Service role porque o pedido é anterior à organização: não há vínculo que a
 * RLS pudesse usar, e a tabela não tem policy nenhuma. O `userId` vem sempre de
 * sessão validada (`getUser()`), nunca do corpo de uma requisição.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export type EstadoDoPedido = "pending" | "approved" | "rejected";

export type PedidoPendente = {
  id: string;
  email: string | null;
  organizationName: string;
  createdAt: string;
};

/**
 * Cria o pedido pendente. Idempotente: o índice único parcial faz o segundo
 * envio cair em `23505`, e o pedido que já está na fila é a resposta.
 */
export async function createRegistrationRequest(
  userId: string,
  organizationName: string,
): Promise<{ created: boolean; id: string | null }> {
  const { data, error } = await createAdminClient()
    .from("registration_requests")
    .insert({ user_id: userId, requested_organization_name: organizationName })
    .select("id")
    .single();

  if (error?.code === "23505") return { created: false, id: null };
  if (error) throw new Error(`registration_request_insert_failed: ${error.message}`);
  return { created: true, id: (data as { id: string }).id };
}

/**
 * O estado do pedido MAIS RECENTE desta conta, ou `null` se ela nunca pediu.
 * Leitura que falha também vira `null`: quem chama mostra o formulário, e o
 * envio repetido é idempotente pelo índice.
 */
export async function estadoDoPedido(userId: string): Promise<EstadoDoPedido | null> {
  const { data, error } = await createAdminClient()
    .from("registration_requests")
    .select("status")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return (data as { status: EstadoDoPedido }).status;
}

/** A fila que o administrador da instalação vê em `/admin/cadastro`. */
export async function listPendingRegistrationRequests(): Promise<PedidoPendente[]> {
  const admin = createAdminClient();
  // ponytail: teto de 100 na tela; paginar se uma instalação acumular mais que isso sem decidir.
  const { data, error } = await admin
    .from("registration_requests")
    .select("id, user_id, requested_organization_name, created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(100);
  if (error || !data) return [];

  const linhas = data as Array<{
    id: string;
    user_id: string;
    requested_organization_name: string;
    created_at: string;
  }>;
  // O e-mail não é copiado para a fila: ele vive em `auth.users`, e a linha do
  // pedido some junto com a conta (`on delete cascade`).
  return Promise.all(
    linhas.map(async (linha) => {
      const { data: auth } = await admin.auth.admin.getUserById(linha.user_id);
      return {
        id: linha.id,
        email: auth.user?.email ?? null,
        organizationName: linha.requested_organization_name,
        createdAt: linha.created_at,
      };
    }),
  );
}
