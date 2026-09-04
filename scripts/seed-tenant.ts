/**
 * scripts/seed-tenant.ts — placeholder.
 *
 * CLI para super-admin criar um tenant manualmente em dev/produção (modo BPO).
 * Conforme Spec 01 §3.7 (Onboarding de tenant).
 *
 * Uso (planejado):
 *   npx tsx scripts/seed-tenant.ts \
 *     --name "Loja do João" \
 *     --nuit "12.345.678/0001-90" \
 *     --admin-email "joao@lojadojoao.com.br"
 *
 * O que vai fazer:
 *  1. Validar NUIT não duplicado (409 tenant_already_exists se sim)
 *  2. INSERT em organizations
 *  3. Seed de pipeline default ("Pedidos") com stages canônicas e-commerce:
 *     "Carrinho abandonado | Aguardando pagamento | Pago | Em separação |
 *      Enviado | Entregue | Pós-venda"
 *  4. Criar convite assinado (24h TTL) pro admin do tenant
 *  5. Audit log da criação com acting_as_platform_admin=true
 *
 * Dependências (a instalar quando implementar): tsx, commander ou cac, zod.
 */

async function main() {
  console.error(
    "[seed-tenant] Placeholder — implementação virá com Spec 01 (Plataforma Base).",
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
