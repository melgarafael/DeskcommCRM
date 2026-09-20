# Assinaturas escreve.ai

Estado: interface e catálogo publicados em 20/09/2026; contratação e cobrança permanecem indisponíveis.

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
- `BILLING_ENABLED` permanece desativado. Ativação depende da conta recebedora, webhook real, limites aplicados no backend e QA de pagamentos em teste. Nenhum pagamento foi cobrado e nenhum plano de cliente foi alterado. A publicação posterior da interface está registrada abaixo.

## Revalidação antes da publicação

- Suíte unitária completa: 927 arquivos passaram; 9.412 testes passaram e um caso está marcado como falha esperada pelo próprio teste. Log local: `work/release-final-unit.log`, fora do repositório.
- Dez casos adicionais provaram recusa de checkout sem permissão, em acompanhamento administrativo, com origem externa, campos de preço/empresa enviados pelo cliente, plano desconhecido ou cobrança desativada. Webhooks sem assinatura, de ambiente incompatível ou sem efeito também foram verificados. Isso prova as guardas, não um pagamento real.
- TypeScript, lint dos arquivos revisados e seis casos de configuração passaram. A suíte de shell falhou no caso legado de nome com apóstrofo (`Sant'Ana Odontologia`); os arquivos do kit e dos testes de shell são idênticos aos da branch `versao-atual`. O deploy desta edição usa a imagem Docker, sem executar esse instalador.
- Bloqueios de ativação permanecem: conta recebedora, fluxo de cancelamento/faturas, vínculo inequívoco entre tentativa de checkout e eventos de assinaturas substituídas, auditoria das mutações e aplicação dos limites. A interface de planos permanece informativa.

## Publicação da interface — 20/09/2026

- Imagem `escreve-app:e698f004`, Linux amd64, compilada a partir de `e698f004`. Os commits posteriores desta rodada acrescentam testes e documentação, sem mudar o código da imagem.
- Candidato validado antes da troca: health saudável e login, logo e ilustrações respondendo 200. A primeira tentativa foi descartada porque `docker run --env-file` preservava as aspas do `.env`; o candidato validado usou as variáveis já interpretadas do container anterior. O aplicativo anterior permaneceu saudável durante essa correção.
- Apenas o serviço `app` foi substituído. Health público confirmou `escreve-e698f004`, Supabase, Redis e WAHA saudáveis. Imagem anterior preservada: `deskcomm-app:saraiva-voice-048e55ed`; configuração anterior em `.env.before-escreve-e698f004` no diretório de produção.
- Banco conferido após a troca: 4 empresas, 6 agentes e 5 canais, sem alteração. Hashes das linhas completas dos agentes permaneceram iguais.
- Marca da instalação atualizada para escreve.ai com auditoria e cópia dos valores anteriores; personalizações das empresas preservadas. Login e favicon confirmados no endereço público.
- Lista de agentes, criação ilustrada em desktop/mobile e planos conferidos na sessão real do navegador. Cartão de tarefa preenche a ideia, sem criar nem publicar agente. Nenhum erro de console observado na revisão. Evidências visuais em `outputs/remake-frontend/`, fora do repositório.
- `BILLING_ENABLED=false`; migration 0265 ainda não aplicada em produção. Publicação do catálogo não significa contratação operacional: os bloqueios da seção anterior continuam pendentes.
