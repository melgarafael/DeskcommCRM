# Plano de implementação — Fase 6 (contratos)

> Estado: **construída, publicada no teste.emmovimento.tech e provada** em 26/10/2026, branch
> `feat/agencia-fase-6` (sai da Fase 5). Prova pela tela em `evidence/agencia-fase-6/`.
> Spec: [`SPEC-contratos`](SPEC-contratos.md), decidida pelas sugestões.
>
> **Verificação (26/10/2026):** typecheck e lint limpos; regras dos contratos 6/6 (campos,
> validade, situação, data de assinado-e-pago, grupo); no Postgres da VPS, baseline install +
> update sem erro e 104/104 invariantes da agência (7 novos). No teste, com um cliente de
> prova próprio ("Cliente Prova F6") e o membro de teste com uma função temporária (retirada
> depois): trilha iniciada em "Contrato assinado e pago"; a prévia apontou o endereço em falta;
> contrato gerado (rascunho), PDF 200 `application/pdf`; texto ajustado; "Marcar assinado" e
> depois "Marcar pago" dispararam a conclusão sozinhos — contrato `concluido`, trilha com
> contrato a partir de 01/11/2026 até 31/01/2027 e preparação até 30/11 (regra do dia 15), 5
> tarefas da Etapa 2 liberadas, link do formulário gerado, aviso `contrato_concluido` dizendo
> o que faltou (formulário e grupo à mão, porque o WhatsApp da agência não está configurado);
> segundo contrato recusado; lista, editor de modelos e integrações (InfiniteTag guarda e
> limpa); 375 px sem rolagem lateral. Os dois webhooks respondem 403 com segredo errado.
>
> **Achado na prova e consertado:** recusar uma **segunda** proposta de um cliente que já
> estava assinado e pago o jogava para remarketing. Agora só vai para remarketing quem não tem
> nenhum contrato concluído; o cliente ativo segue ativo.
>
> **Não provado ainda:** ZapSign e InfinitePay de verdade (dependem do token e do InfiniteTag
> reais do dono), o grupo criado pelo WAHA e o link do formulário pelo WhatsApp (dependem do
> número da agência).

## Decisões de arquitetura

- **Migration 9008** + apêndice no baseline antes da varredura de anon.
- **Texto final guardado** no contrato; o PDF (`lib/agencia/contratos/pdf.tsx`) sai sempre dele.
- **Webhooks** em `app/api/v1/webhooks/agencia/{zapsign,infinitepay}/[segredo]` (prefixo já
  público no proxy e isento da cerca de suporte): segredo no caminho, cifrado na config, e
  **conferência ativa** na API do fornecedor antes de marcar; processamento com `after()`
  para responder rápido.
- **Conclusão atômica** (`lib/agencia/contratos/conclusao.ts`): a troca para `concluido` é um
  UPDATE condicional; cada efeito (cliente ativo, trilha, formulário, grupo, aviso) é
  independente e o que falhar vira pendência no aviso.
- **Grupo** pelo WAHA (`WahaClient.criarGrupo`, `lib/agencia/whatsapp/grupo.ts`), só para
  canal por QR Code.
