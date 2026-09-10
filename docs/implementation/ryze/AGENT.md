# Governança de Agente — Provider RyzeAPI

Este arquivo define as regras de execução do agente de IA durante a implementação da feature `ryze-channel`.

## Regras de Execução
- **Contenção de Escopo:** O agente altera exclusivamente arquivos autorizados em `.specs/features/ryze-channel/context-manifest.json`.
- **Invariantes da Arquitetura:**
  - Nenhuma alteração nos provedores existentes (`waha`, `meta_cloud`, `zernio`).
  - Nenhuma criação de rota dedicada de webhook.
  - Zero alteração em frontend, IA, automações comerciais ou auth.
- **Assinatura Obrigatória:** Todo comentário no Linear deve ser assinado explicitamente com `— Stark`.
- **Workflow TDD:** RED → GREEN → REFACTOR → REGRESSÃO para cada entrega de código.
- **Gates do Linear:** Fases são transicionadas para `In Review` e aguardam autorização externa (`Done`) para avançar.
