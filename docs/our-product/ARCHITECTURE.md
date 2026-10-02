# Arquitetura-alvo da nossa camada

Visão de produto. A implementação segue o que o DeskcommCRM já tem. Onde o desenho aspiracional pedia uma segunda infraestrutura, usamos a que já funciona.

## Dois planos

O data plane é este fork. É onde roda o CRM, a inbox, os canais, a IA e, no futuro, os módulos oficiais. Pode ser hospedado por nós ou instalado com Docker na infraestrutura do revendedor.

O control plane ainda não existe neste repositório. Licenças, billing da plataforma, metering e o Hub de integrações vão morar num repositório separado, operado só por nós. Cada instalação do revendedor não carrega OAuth, segredos de provedor nem split de pagamento.

## O que já reaproveitamos

| Peça | Onde está hoje | O que fazemos |
|---|---|---|
| Tenant | `organization_id` + RLS via `fn_user_org_ids()` | Preservar. Service role continua filtrando a organização por fonte confiável, nunca pelo body. |
| API | Zod, guard, `resolveActiveOrg`, `ok()` / `fail()` | Toda rota nova segue o mesmo contrato. Dinheiro em centavos + moeda. |
| Eventos | `event_log` + `workers/` | Barramento inicial. Sem Kafka, RabbitMQ ou fila paralela enquanto esta fila der conta. |
| Extensões | pacote JSON declarativo, sem execução de código | Guias e contribuições leves. Módulo oficial com tabela e regra de negócio não entra aqui. |
| Marca | `lib/branding/`, `APP_NAME`, `APP_LOGO_URL`, `APP_ACCENT_HEX` | Uma imagem para todas as marcas. Sem fork por revendedor e sem troca de nome no código. |
| IA | `lib/agent-engine/`, `lib/ai/`, MCP | Ferramentas novas entram nesse runtime. Outro orquestrador só se este não representar o fluxo. |
| Canais | `lib/channels/` | O CRM fala com contrato de canal. O provedor externo fica no Hub, quando ele existir. |
| Schema | `supabase/migrations/` + `supabase/baseline.sql` | Migration nova e apêndice idempotente no baseline. Migration já publicada não se edita. |

## Três tipos de módulo

1. **Core.** Auth, tenancy, conversa, auditoria. Sempre presente. Mudança conservadora.
2. **Módulo oficial compilado.** Estoque, financeiro, ordens de serviço, marketplace. O código viaja na imagem Docker e fica invisível sem entitlement da organização. Desligar não apaga dado. O gate vale na API, não só no menu.
3. **Extensão declarativa.** O framework que o upstream já tem. Não vamos fazê-lo executar SQL nem script.

O piloto, quando a linha de base estiver registrada, é `service_orders`: tela, API, tabela com `organization_id` e RLS, auditoria e entitlement. Só depois o ERP na ordem catálogo, estoque, vendas, compras, financeiro.

## Hierarquia que não se mistura

Plataforma (nós) → revendedor → organização (tenant) → usuário da organização → contato, que é o cliente daquele tenant.

Billing da plataforma (assinatura do revendedor, conexão, split) não é o caixa do tenant (contas a pagar e a receber). Fiscal do tenant é um adaptador, não um motor tributário no core.

## O que fica para depois

Hub com webhook fictício, primeiro conector real, marketplace, tools de IA dos módulos novos, hierarquia de revendedor, metering, billing, split, imagens nossas e escala por células. Cada um espera o anterior estar aceito. Kubernetes, sharding e dezenas de conectores não entram sem métrica.
