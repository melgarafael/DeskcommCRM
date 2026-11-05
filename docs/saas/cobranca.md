# Cobrar os seus clientes

Com a **Stripe**, o **Asaas** ou o **Efi Bank** conectados, o próprio DeskcommCRM cobra cada empresa-cliente,
avisa quem atrasou, suspende quem não paga e libera quem pagou. A cobrança vem **desligada**
em toda instalação: quem não revende nunca a vê.

Com outro provedor (Pix direto, link avulso), a cobrança é manual: veja o
[caminho manual](#caminho-manual) no fim.

O desenho e as decisões estão na spec
[`../superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md`](../superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md)
e na [ADR-0004](../adr/0004-cobranca-do-revendedor.md).

## Stripe, Asaas ou Efi Bank

| | Stripe (conta Brasil) | Asaas |
|---|---|---|
| Desde a versão | 1.78.0 | 1.79.0 |
| Como o cliente paga | Cartão recorrente, cobrado sozinho todo mês. É o único meio testado no sistema. Não tem Pix | **Pix, boleto ou cartão**, escolhido na fatura a cada cobrança. Não é débito automático: o cliente paga cada fatura |
| O que o cliente informa | Os dados do cartão, na página da Stripe | O **CPF ou CNPJ** de quem paga, antes de assinar. Vai direto para o Asaas e não fica guardado no sistema |
| Trocar cartão e ver faturas | Botão **Gerenciar pagamento** (portal da Stripe) | Não há portal: o cliente abre a fatura de cada mês |
| Nota fiscal | O DeskcommCRM não emite | O DeskcommCRM não emite; a emissão, se você quiser, é no painel do Asaas |
| Preço mínimo do plano | R$ 5,00 | R$ 5,00 |

**Efi Bank.** Boleto **recorrente** com link de pagamento do próprio Efi, que também aceita Pix e
cartão na página dele. O cliente paga cada fatura; não é débito automático. Diferenças que
importam: o Efi **não tem cadastro de cliente** (o pagador é informado na página dele, a cada
fatura), **não tem portal** (gerenciar é abrir a fatura aberta) e **não aplica troca de plano** na
assinatura — a troca passa a valer no próximo ciclo assistido, e a tela diz isso. O aviso de
pagamento **não é cadastrado no painel do Efi**: a URL e o token viajam em cada cobrança criada
por esta instalação, então não há passo manual e não há o que colar no painel dele.

Vende para pequena empresa brasileira que paga no Pix ou no boleto? **Asaas** (fatura avulsa) ou
**Efi Bank** (boleto recorrente). Cliente que
prefere cartão no automático? **Stripe.** Uma instalação trabalha com um provedor por vez.
Trocar de provedor só é possível enquanto nenhuma empresa paga de verdade pelo provedor atual:
depois disso a tela recusa, para não deixar essas assinaturas sem leitura.

## Antes de começar

- O sistema num endereço **https público**. Os dois provedores só avisam pagamento num
  endereço assim; com o domínio errado, a tela da Conexão avisa e não deixa conectar. O
  endereço vem da instalação (`NEXT_PUBLIC_APP_URL` no `.env`), não do navegador.
- O **envio de e-mail** configurado (painel › E-mail). Sem ele, os avisos de atraso aparecem
  só dentro do sistema.
- A chave de cifra do servidor (`AI_CRED_AES_KEY`), que o instalador já gera. Sem ela a
  Conexão recusa, porque a chave do provedor é guardada cifrada.

## Ligar e conectar

1. **Ligar.** Painel › **Recursos opcionais** › **Cobrança dos seus clientes**. O item
   **Cobrança** aparece no menu do painel. As empresas que já existem ficam **isentas**:
   você escolhe quem passa a pagar.
2. **Conectar.** **Cobrança** › aba **Conexão** › campo **Provedor**. Comece **sempre pela
   chave de teste**.

### Stripe

1. Na Stripe, em **Desenvolvedores › Chaves de API**, copie a chave de teste (`sk_test_` ou
   `rk_test_`).
2. Cole em **Chave secreta** e clique em **Testar e conectar**.
3. Aparecem o selo **MODO DE TESTE** e "Os avisos de pagamento chegam em …". O sistema
   cadastra o aviso de pagamento (o webhook) na Stripe sozinho.

Uma chave restrita (`rk_`) precisa de escrita em **produtos**, clientes, assinaturas, checkout,
portal e avisos (webhooks), e de leitura de faturas. O "Testar e conectar" lê clientes e cadastra
o portal e o aviso de pagamento, mas não toca em produtos: uma chave sem **produtos** conecta, e o
erro só aparece quando o primeiro cliente clica em **Assinar**, porque é no checkout que o sistema
cria o produto do plano na Stripe.

### Asaas

1. Comece pela conta de **sandbox** do Asaas (a conta de testes, em que nenhum pagamento é real). Em **Integrações › Chaves de API**, copie a
   chave: a de sandbox começa com `$aact_hmlg_` e a de produção com `$aact_prod_`. É pelo
   começo da chave que o sistema sabe se é teste.
2. Cole em **Chave de API do Asaas** e clique em **Testar e conectar**.
3. Aparecem o selo **MODO DE TESTE**, "Chave conectada" com só os 4 últimos caracteres e
   "Os avisos de pagamento chegam em …". Normalmente o sistema cadastra o aviso no Asaas
   sozinho, pela API.
4. Se aparecer o quadro **"Falta um passo: cadastre o aviso de pagamento no Asaas"**, siga-o:
   no Asaas, **Integrações › Webhooks** › **Adicionar** (ou edite o aviso que já tiver o mesmo
   endereço e troque só o token), preencha os campos como o quadro mostra, cole a **URL do
   aviso** e o **Token de autenticação**, marque os eventos listados e clique em **Pronto, já
   cadastrei**. O token aparece **uma vez só**: se sair da tela sem copiá-lo, conecte de novo.

### Efi Bank

1. No painel do Efi, em **Aplicações**, abra (ou crie) a aplicação e habilite a **API de Cobranças**.
   Homologação e produção são **pares diferentes** de Client-Id/Client-Secret: a credencial de
   homologação só vale no ambiente de teste, e vice-versa.
2. Monte a credencial no formato `ambiente:client_id:client_secret` — por exemplo
   `teste:1a2b3c4d5e6f:9f8e7d6c5b4a` — e cole em **Credencial do Efi**.
3. Clique em **Testar e conectar**. O sistema autentica em `/v1/authorize` (OAuth2) e mostra o selo
   **MODO DE TESTE** com só os 4 últimos caracteres do segredo.
4. Aparece o quadro **"O aviso de pagamento no Efi"** com a URL e o token: **não há nada a cadastrar
   no painel do Efi**. Eles são levados em cada cobrança criada por esta instalação, e o token fica
   guardado para conferir quem chamou.

Se a credencial estiver errada, o Efi responde 401 e a tela diz para conferir o par
(Client-Id/Client-Secret) daquele ambiente — os outros provedores seguem intactos.

Quem avisa o pagador é a régua do sistema, e ele pede ao Asaas que não mande os avisos dele.
Mesmo assim, quem paga pode receber também o aviso padrão do Asaas: na conta de testes, a
configuração de avisos do cliente continuou ligada (8 de 8 avisos com algum canal, em
`evidence/cobranca-asaas/smoke-asaas.txt`), e se o aviso chega mesmo não foi medido. Se
incomodar, desligue os avisos desse cliente no painel do Asaas.

## Planos

Aba **Planos**:

| Campo | O que saber |
|---|---|
| Nome do plano | Até 60 caracteres |
| Preço (R$) | A partir de R$ 5,00 |
| Intervalo de cobrança | Mensal ou Anual |
| Dias de teste grátis | De 0 a 90; o padrão é 14. **0 = entrada paga:** a empresa que nasce nesse plano fica suspensa até o provedor confirmar o primeiro pagamento |
| Máximo de pessoas | Vazio = sem limite |
| Máximo de números conectados | Vazio = sem limite |
| Teto de uso de IA por mês (US$) | Só para a empresa que usa a chave de IA da instalação. Com a chave da própria empresa (BYOK), não se aplica |

- **Salvar plano** grava. Depois, no plano que quem se cadastra sozinho deve ganhar, clique em
  **Usar no cadastro** (o plano padrão).
- Com a cobrança ligada, **toda empresa nova nasce com plano**: o que a pessoa escolhe na tela de
  cadastro (a lista mostra os planos visíveis às empresas e já vem marcada no padrão) ou, sem
  escolha (entrada pelo Google, integração), o padrão.
- **Sem plano padrão, mas com planos visíveis às empresas:** o "Entrar com Google" some da tela
  de cadastro, o cadastro sem plano é recusado e a integração (`/api/v1/tenants/provision`)
  recebe `409 plano_obrigatorio`. A aba Planos avisa quando você está nessa situação. Quem
  entra pela primeira vez com o Google pela tela de login escolhe o plano na tela seguinte.
- **Sem plano nenhum** (nenhum padrão e nenhum visível às empresas): tudo como antes da cobrança
  por plano — quem se cadastra sozinho fica **isento** (usa de graça e sem limite) e o Google
  aparece.
- O preço e o intervalo de um plano **travam** quando alguém o assina. Para mudar, arquive e crie
  outro.
- Plano negociado com um só cliente: **Esconder das empresas**. Ele ganha o selo "Só você
  atribui", e a empresa não o vê nem o escolhe.

## Testar e publicar

1. Crie uma empresa de teste com outro e-mail seu e, em **Plano de cobrança**, escolha um plano.
2. Abra o convite numa janela anônima, vá em **Configurações › Plano e cobrança** e assine:
   - **Stripe:** clique em **Assinar** e pague com o cartão de teste `4242 4242 4242 4242`,
     qualquer validade futura e qualquer CVC.
   - **Asaas:** preencha **CPF ou CNPJ de quem paga** (sem documento válido o botão fica
     desligado), clique em **Assinar** e depois em **Abrir a fatura**. Confirme o pagamento de
     teste pelo sandbox, volte e clique em **Já paguei**: Pix confirma em minutos, boleto em
     até 1 dia útil.
   - **Efi Bank:** clique em **Assinar**, escolha **boleto** (ou cartão) na página do Efi e pague
     no ambiente de homologação; volte e clique em **Já paguei**. O boleto de homologação não é
     liquidado automaticamente, então use o simulador do próprio Efi ou o cartão de teste dele.
3. Em **Cobrança › Visão geral**, a lista "Primeira cobrança: o que falta" mostra o que ainda
   falta.
4. Deu certo? Volte à **Conexão** e troque pela credencial de produção (`sk_live_`/`rk_live_`,
   `$aact_prod_` ou `producao:client_id:client_secret`). Até lá, clientes reais **não conseguem pagar**, e uma faixa avisa disso. Se
   alguma empresa assinou em teste, a tela avisa que ela volta para o teste grátis; confirme em
   **Publicar mesmo assim**.

A compra de teste pela tela foi provada contra a Stripe de verdade, em modo de teste. Com o
Asaas, ela foi provada contra a conta de testes do Asaas por programa e, pela tela, contra um
simulador do Asaas; a compra **pela tela** contra a conta de testes de verdade ainda não foi
feita. (Para quem audita: o teste de tela da Stripe passou em 08/10/2026, commit `f2a65a7ae`; o
do Asaas é `scripts/smoke-asaas.ts` e `tests/e2e/cobranca-asaas.spec.ts`.)

## A régua

Aba **Régua** › **Dias de tolerância** (de 5 a 30, padrão 7) › **Salvar régua**.

| Quando | O que acontece |
|---|---|
| Dia 0 | Aviso de pagamento não identificado, com o link para pagar |
| Dia da tolerância menos 2 | Aviso final, com a data da suspensão |
| Dia da tolerância, e pelo menos 48 h depois do aviso final | A empresa é suspensa |
| Pagou | Volta a funcionar sozinha, na hora, sem disparar o que ficou parado |

Também sai um aviso 3 dias antes do fim do teste grátis, e a empresa suspensa que continua
devendo recebe um lembrete por semana. Teste grátis vencido sem pagamento entra na régua como
atraso. Os avisos vão por e-mail, com a **marca da empresa-cliente**, para cada administrador
dela, aparecem na Central e numa faixa no topo do sistema. Quem não administra a empresa vê só
um aviso para chamar quem administra.

Suspender **cala** a IA e os envios da empresa. As mensagens que chegam continuam guardadas, e
ao reativar nada sai em rajada.

## Trocar de plano

A troca vale para a empresa (Configurações › Plano e cobrança › **Trocar de plano**) e para
você (Tenants › empresa › card Cobrança › **Trocar plano**). As regras:

- **No teste grátis**, a troca vale na hora.
- **Depois do teste, a empresa sobe de plano:** ela paga na hora a diferença proporcional aos
  dias que faltam no período. O plano novo e os limites dele valem quando o provedor confirma
  esse pagamento (Pix e cartão: minutos; boleto: até 1 dia útil), e a data da renovação não muda.
  A cobrança da diferença vale até o fim do período em que foi feita: não paga até lá, ela é
  cancelada no provedor; paga depois disso, o plano novo só vale a partir da próxima renovação
  paga. Diferença abaixo de R$ 5,00 (perto do fim do período) não é cobrada: a troca fica
  agendada para a renovação.
- **Com uma diferença esperando pagamento**, escolher outro plano cancela essa cobrança no
  provedor. Se ela já foi paga, a troca é recusada por alguns minutos, enquanto o plano pago é
  aplicado.
- **Descer de plano** fica **agendado** e vira na próxima cobrança paga, sem crédito do que
  sobrou. A próxima fatura já sai com o preço novo.
- **Você (o dono) trocando o plano depois do teste**, para cima ou para baixo, também fica
  agendado: plano negociado não paga diferença.
- **Em atraso**, ou com o teste vencido sem assinatura, a troca é recusada: regularize antes.
- **No Efi Bank**, a troca **não é aplicada na assinatura** (o Efi só edita assinatura de cartão, e
  aqui o checkout é link): o preço novo passa a valer no próximo ciclo assistido pela régua, e a
  Visão geral registra `preco_no_provedor: recusado` na auditoria do ciclo.
- **No Asaas**, com a mensalidade do período ainda em aberto, a troca é recusada até o pagamento
  ser confirmado.
- **Só entre planos com o mesmo intervalo.** Mensal para anual (ou o contrário) é recusado:
  cancele e assine o plano novo.
- **Com um link de pagamento ainda em aberto** no teste grátis, o sistema expira o link antigo no
  provedor e a troca vale; se não conseguir expirá-lo, recusa até o link ser pago ou vencer.
- **Uso acima do plano novo** (pessoas ou números a mais) é recusado, com a lista do que remover.
- A empresa só escolhe planos oferecidos a ela; o plano negociado, só você atribui.

## Mandar o link de pagamento para a empresa

Quando a empresa não vai entrar no sistema para assinar (o cliente pediu "me manda o Pix"), gere
o link por ela: **Tenants** › empresa › card **Cobrança** › **Gerar link de pagamento**, e mande
pelo WhatsApp com **Copiar link de pagamento**. O botão aparece em toda assinatura que ainda não
está **Em dia**: no teste grátis, em atraso ou cancelada. Empresa isenta não tem o botão
(atribua um plano antes).

- **No Asaas**, a primeira vez pede o **CPF ou CNPJ de quem paga**, já preenchido com o CNPJ do
  cadastro quando ele confere. O documento vai direto ao Asaas e não fica guardado no sistema.
- **O cliente no provedor nasce com o e-mail do administrador mais antigo da empresa**, nunca o
  seu nem o de outro dono da instalação, mesmo que você ainda apareça como administrador dela
  (empresas criadas antes de 12/09). Na primeira vez, empresa sem outro administrador com e-mail
  é recusada. São dois casos:
  - **a empresa que você acabou de criar para outra pessoa:** até o convite ser aceito, o único
    administrador dela é você, de forma provisória. Gere o link depois do aceite;
  - **a empresa em que o único administrador é você mesmo:** a recusa não passa sozinha.
    Convide um administrador da empresa em Equipe e gere o link depois que ele aceitar.

  Depois que o cliente existe no provedor, o e-mail não é mais pedido e a recusa não acontece.
- **Clicar de novo devolve o mesmo link** enquanto ele vale. Com a fatura já aberta no
  provedor, o botão devolve o link dela, sem criar outra assinatura. No Asaas, depois do aviso
  do provedor, a empresa vê o mesmo link em Configurações › Plano e cobrança › **Pagar agora**.
  Na Stripe ela não vê o link: o **Assinar** dela abre a mesma sessão enquanto ela vale.
- **Na Stripe, o link vale 24 horas.** Passou disso, gere de novo.
- **Trocar o plano no teste grátis** expira o link aberto: gere outro depois da troca.
- **O link gerado com a chave de teste morre ao publicar.** Gere de novo depois de trocar pela
  chave de produção.
- **Quem paga pela Stripe volta para a tela de login** do sistema, e não para uma página de
  "pagamento recebido". O pagamento não depende dessa volta: a confirmação vem do aviso do
  provedor. Avise o cliente para fechar a aba depois de pagar.

## Dar prazo, isentar e acompanhar

Em **Tenants** › empresa › card **Cobrança**:

- **Dar prazo até** [data] › **Dar prazo**: até 60 dias.
- **Tornar isenta**: a empresa não paga e não tem limites.

Os dois reativam na hora uma empresa suspensa por falta de pagamento.

Em **Cobrança › Visão geral**, "Situação da cobrança" mostra o último aviso do provedor e a
última leitura, e "Problemas para resolver" aponta casos como chave que parou de funcionar ou
cliente com duas assinaturas ativas. O agendador relê cada assinatura a cada 6 horas; leitura
com mais de 7 horas mostra "Confira se o agendador está rodando". A aba **Clientes** tem uma
linha por empresa que paga, com **Copiar link de pagamento**.

**Desligar** a cobrança faz os limites dos planos deixarem de valer e libera as empresas
suspensas por falta de pagamento (a tela mostra quantas). Nada é cancelado no provedor.

## Nota fiscal

O DeskcommCRM **não emite nota fiscal**, com nenhum dos dois provedores. Emitir é obrigação
sua, como prestador do serviço. O Asaas oferece emissão de nota de serviço na conta dele;
confira com o seu contador antes de ligar.

## Caminho manual

Para quem usa outro provedor ou não ligou a cobrança automática:

1. No provedor, crie para cada cliente uma assinatura ou um link de pagamento.
2. Controle numa planilha: empresa, plano, valor, vencimento, forma de pagamento, situação,
   último pagamento, aviso enviado.
3. Combine a régua no contrato ([`contrato-e-lgpd.md`](contrato-e-lgpd.md)) e avise pelo
   WhatsApp, no mesmo horário todo mês.
4. Não pagou no prazo: painel › Tenants › empresa › **Suspender tenant**, com o motivo (mínimo
   de 10 caracteres). Pagou: **Reativar tenant**.

A régua automática não mexe na suspensão que você faz à mão: ela não avisa nem reativa essa
empresa.
