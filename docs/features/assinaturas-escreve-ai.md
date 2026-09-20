# Assinaturas escreve.ai

Estado: implementação em andamento; cobrança e deploy ainda não validados.

## Oferta mensal

| Plano | Mensalidade | Pessoas | Canais | Agentes | Franquia de IA |
| --- | ---: | ---: | ---: | ---: | ---: |
| Essencial | R$ 197 | 2 | 1 | 2 | R$ 30 |
| Crescer | R$ 397 | 5 | 3 | 5 | R$ 80 |
| Escala | R$ 797 | 15 | 8 | 15 | R$ 180 |

Preços em reais por empresa. A franquia de IA representa consumo, não um número garantido de mensagens. Tarifas Meta e de outros canais são separadas. Não oferecer consumo ilimitado, teste gratuito ou desconto anual antes da implementação correspondente. Contas existentes não são convertidas nem cobradas automaticamente.

A oferta mantém os recursos centrais nos três planos; a diferença é capacidade operacional. A franquia de IA ocupa aproximadamente 15%, 20% e 23% da receita bruta. Isso é uma hipótese inicial de preço, não margem líquida comprovada: impostos, meios de pagamento, infraestrutura e atendimento ainda precisam ser medidos na operação.

Referências de posicionamento consultadas em 20/09/2026: [Zaia](https://www.zaia.app/plans-team/) e [respond.io](https://respond.io/pricing). Preços e unidades desses produtos não são equivalentes e não foram copiados.

## Invariantes da implementação

- O servidor resolve organização e permissão; o navegador nunca define preço, beneficiário ou organização de cobrança.
- Somente uma confirmação verificada do provedor altera a assinatura. Redirecionamento de sucesso não prova pagamento.
- Eventos duplicados devem ser idempotentes; eventos atrasados não podem regredir uma assinatura mais recente.
- Cancelamento, renovação, falha de pagamento e gestão de faturas precisam do estado real do provedor.
- Valores comerciais em BRL não podem ser gravados diretamente no orçamento atual de IA: a contabilidade existente usa centavos de USD. Conversão e teto precisam de regra explícita e teste antes de ativar a venda.
- Limites comerciais ainda precisam de enforcement no backend para novos recursos. Não remover agentes, canais ou pessoas preexistentes ao mudar de plano.
- Sem provedor configurado, a interface mostra contratação indisponível, sem fabricar checkout ou assinatura ativa.

## Deploy

Produção confirmada em `crm.escreve.ai`, host Azure, app Docker. O checkout de produção contém alterações próprias não commitadas; não executar reset, clean ou atualização in-place sem reconciliação. Preservar imagens atuais para rollback. Código de produção foi solicitado para cópia de auditoria fora do repositório; conclusão da transferência deve ser verificada.

## Evidência da preparação — 20/09/2026

- Catálogo comercial: 3 testes passaram; adaptador Stripe e assinatura HMAC: 3 testes passaram.
- Migration 0265: baseline aplicado em instalação e atualização pelo harness; 4 invariantes passaram (isolamento entre empresas, leitura restrita, bloqueio de escrita pelo tenant e idempotência).
- TypeScript e lint focado passaram nesta revisão intermediária. Rotas de checkout/webhook ainda precisam de testes de ciclo completo, cancelamento e concorrência; esses checks não provam cobrança funcional.
- Cópia filtrada de produção concluída em `work/production-audit/source-filtered.tar.gz`, fora do repo. Comparação: 61 arquivos diferentes e uma migration exclusiva de produção, `20260915230000_0252_redes_sociais_nativas.sql`. Reconciliar antes do deploy; não remover a migration de produção.
- Produção: app `deskcomm-app:saraiva-voice-048e55ed`; imagem anterior deve ser mantida. Disco tinha apenas 1,4 GB livres; build exige liberar cache dispensável ou construir em outro ambiente.
- `BILLING_ENABLED` permanece desativado. Ativação depende da conta recebedora, webhook real, limites aplicados no backend e QA de pagamentos em teste. Nenhum pagamento foi cobrado, nenhum plano de cliente foi alterado e nenhum deploy desta revisão foi executado.
