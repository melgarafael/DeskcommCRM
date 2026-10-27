# Continuidade do primeiro pagamento

Destino: núcleo. Sem mudança de schema, trigger financeiro, provedor ou configuração de autenticação.

## Autoridade e caminho

SignupForm envia `continuar_pagamento` somente para escolha explícita de plano sem trial, fora de convite. `signUp` revalida o plano oferecido antes de criar a conta. Só uma identidade nova efetivamente criada pelo GoTrue pode gerar a intenção, vinculada a usuário, UUID planejado da empresa, plano, nonce, versão e sete dias de validade. `INTERNAL_SECRET` assina o recibo HMAC SHA-256; não há segredo público de reserva. A auditoria aceita INSERT autenticado de tenants: sua mera presença **não** autoriza cobrança. Só a assinatura verificada prova a origem. Ausência, expiração, adulteração ou segredo indisponível mantêm continuação manual.

`ensureTenantForUser` verifica o recibo antes do INSERT e usa o UUID da empresa escolhido pelo servidor. Não toma esse UUID da metadata editável. Sem recibo válido, conserva a geração nativa de UUID. Membership existente continua retornando antes de qualquer provisionamento; colisão do UUID reservado não gera uma segunda empresa com outro UUID. Leitura de intenção que falha fecha o provisionamento e conserva o caminho de erro/recuperação nativo. A continuação exige igualdade exata entre esse UUID assinado e a empresa da sessão: outra empresa da mesma pessoa/plano não herda o aceite.

A confirmação anti-scanner, convite, Google, recuperação e MFA conservam seus handlers. Após Auth, o gate financeiro continua barrando acesso ao produto. O hub reconhece `pagamento_inicial_pendente=true`, sem período pago nem assinatura ativa, e leva administradores fora do modo suporte a `/cobranca/contratar`. Pedido LGPD e ajuda continuam no hub. Dívida posterior e suspensão administrativa conservam seu fluxo. Usuários sem papel financeiro recebem orientação, sem checkout automático.

O GET da continuação só lê estado da organização da sessão e preço/período do plano no banco. O componente inicia POST nativo apenas quando recebeu intenção válida e os dados obrigatórios já existem. CPF/CNPJ faltante pede preenchimento e um único Continuar para pagamento; digitar não envia. Não guarda documento na intenção nem na auditoria. Convite, trial e login sem intenção não criam pagamento automático.

## Dinheiro, concorrência e retorno

`POST /api/v1/cobranca/assinatura/checkout` conserva requireRole, suporte, MFA e módulo nativos. A continuação automática relê o recibo; usa seu nonce como chave idempotente e exige o mesmo plano antes do CAS da reserva. Reserva também filtra esse plano. Link ainda válido ou assinatura já existente são reutilizados pelo mecanismo nativo. Falhas não provocam loop de retry automático. O caminho manual exige clique atual autenticado como antes.

O retorno passa pela ponte nativa de cookie Strict e destino fixo permitido. Antes de sair ao gateway, histórico local ganha `retomar=1`, evitando redirecionamento automático ao voltar. `voltou=1` e Já paguei apenas chamam a sincronização nativa. Só `estado=ativa` **e** `org_operante=true` levam ao onboarding. Query de sucesso ou declaração humana não liberam uso. Valor anual mostra o total pago de uma vez; preço não vem da URL.

## Living System Checklist

1. Entrada: formulário validado, identidade nova do GoTrue, auditoria assinada e estado atual da org da sessão.
2. Saída: hub → `/cobranca/contratar` → checkout nativo → ponte de retorno → sincronização → onboarding.
3. Registro: `auth.signup_requested` recebe intenção assinada; `cobranca.checkout_iniciado` continua no helper financeiro nativo.
4. Tela: continuação mostra plano/período, estado e erro recuperável; hub mantém LGPD e recuperação.
5. Porta: redirect do hub financeiro, link Continuar para pagamento em ajuda, retorno nativo do provedor. Fora de `app/app/**`, não é item do menu do produto bloqueado.
6. Anti-morte: documento faltante, ausência de provedor, erro e retorno pendente sempre mostram próximo passo. Sem reenvio externo automático.
7. Configuração: planos e provedor nas superfícies administrativas nativas; módulo desligado conserva seus gates; falha de provedor aparece na continuação.
8. Continuidade IA/humano: não há agente, conversa ou handoff nesta contratação autenticada; não altera os mecanismos existentes.
9. Laço: erro permite retry explícito; checkout pendente é reutilizado; confirmação nativa reavalia estado e acesso. Não cria aprendizado nem aprovação financeira pela tela.
10. Mapa: `continuidade-primeiro-pagamento.architecture.json`, com entradas e saídas concretas.

## Prova e limites

Testes dirigidos verificam assinatura adulterada/expirada, vínculo de pessoa e plano, negativa sem intenção, primeiro pagamento versus dívida, LGPD, suporte/papéis, POST único/StrictMode, documento, reserva, erro, link inseguro e retorno pendente/confirmado. Os handlers de confirmação e recuperação são reutilizados em regressão. Banco, Auth e gateway são dublês; não prova entrega de e-mail nem liquidação real. Build, UI servida e promoção têm recibos próprios; não se inferem destes testes.
