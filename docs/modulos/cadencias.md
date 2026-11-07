# Cadências de e-mail — módulo oficial opcional

Recorte do PR [#1738](https://github.com/melgarafael/DeskcommCRM/pull/1738), de Marcelo (@lmarceloc), conforme decisão de produto75B. O construtor e a intenção da sequência vêm do contribuidor; a integração ao contrato de módulos e as proteções desta adaptação estão em commits separados.

## Instalação e uso

O dono do servidor instala **Cadências de e-mail** em `/admin/modulos`, a vitrine oficial por imagem (ADR-0002). Não depende de catálogo HTTP de pacotes de terceiros. A atualização entrega a provisionadora; as três tabelas só nascem na instalação do módulo. Não há URL ou chave nova para preencher.

Depois, cada administrador de empresa liga o recurso em **Configurações → Configurar cadências** (`/app/settings/cadencias`). O padrão é desligado. O menu **CRM → Cadências de e-mail** só aparece após as duas decisões. A interface de montagem e inscrição é de gerente ou superior; a API de inscrição mantém o corte `agent` da fonte.

Crie um rascunho, escreva os e-mails, ajuste dias, horários e fuso, e revise antes de ativar. O motor usa o transporte de e-mail já configurado pelo dono do servidor. Sem transporte funcional não há entrega: a falha aparece na inscrição. As variáveis disponíveis são primeiro nome, nome, segmento e vendedor. Dado faltante não sai como template para o destinatário: encerra a inscrição com falha visível. Não existe caixa por vendedor; se o dono do negócio tiver e-mail, ele é o endereço de resposta. O prefixo `Re:` reaproveita o assunto, sem prometer threading IMAP.

Em **Inscrições e atividade**, busque um negócio pelo título e inscreva-o. Ele precisa pertencer à empresa e ter contato com e-mail não anonimizado. Bloqueio, contato pessoal e recusa de marketing já registrada seguem os vetos canônicos do produto, conferidos na inscrição e antes do envio. O opt-in de abertura começa desmarcado: marque somente quando o destinatário autorizou o rastreio. São guardados flag, instante e responsável pela inscrição. Sem autorização o e-mail não contém pixel e a RPC não registra abertura. Abertura automática do provedor pode contar; não é prova de leitura humana.

A lista de cadências e as inscrições permitem carregar páginas anteriores. Em cada inscrição, **Ver histórico** mostra os eventos reais com data/hora e paginação; a fila ativa também informa a próxima execução agendada.

O cron anda a fila a cada minuto. E-mail só sai dentro da janela e dos dias configurados. A espera e o prazo de tarefa usam o calendário de dias úteis brasileiros já presente na fonte; a condição de abertura usa dias corridos, explicitados na tela. O sinal precisa ter sido registrado até o prazo do ramo; atraso do cron não transforma abertura tardia em abertura dentro do prazo. Os tetos são de tentativas por janela fixa de24h: o valor desta cadência e `CADENCIA_LIMITE_EMAILS_POR_DIA` da instalação. Sem Upstash, o limitador existente é por processo em memória; não é um limite global entre várias réplicas.

## Paradas e preservação

Pausar a cadência ou desligar o uso na empresa preserva os dados e impede os próximos envios. Retirar uma inscrição a encerra, sem apagar histórico. Cadência com inscrições não é excluída: pause para preservar histórico e supressões. A montagem dos passos não muda enquanto houver inscrição ativa, mesmo em cadência pausada: termine ou retire as inscrições primeiro.

Todo e-mail tem descadastro assinado, sem sessão e sem expiração artificial. A abertura e o descadastro usam finalidades HMAC distintas. Descadastrar interrompe as inscrições ativas desse contato na empresa e registra supressão na inscrição de origem, inclusive quando ela já estava concluída ou a empresa desligada. Clique repetido é idempotente. A reinscrição comum não remove a supressão.

A anonimização encerra a fila, revoga rastreio e redige metadados do titular. O export LGPD inclui inscrições e eventos. Tabela ausente é seção vazia; falha de leitura de módulo existente aborta a coleta, em vez de entregar cópia incompleta como completa.

## Laço de retorno e limites

A reivindicação lê o estado atual com trava e um identificador por rodada, após filtrar empresas e cadências habilitadas. Avanço e efeitos comparam essa posse. Criar tarefa e registrar seu recibo é uma transação, para não duplicar a tarefa ao perder a confirmação do avanço. Inscrição e descadastro serializam pela mesma linha canônica do contato.

O envio grava uma reserva durável antes de chamar o transporte. Se o processo perde a confirmação ou não consegue gravar o avanço depois de enviar, a próxima rodada encerra a inscrição com `cadencia_delivery_unconfirmed`, visível na atividade, e não reenvia cegamente. A tela avisa que o provedor pode ter aceitado o e-mail. O operador confere o transporte e o histórico; não existe ação de retomada nem reenvio automático para esse resultado incerto. Isso não promete entrega exatamente uma vez pelo provedor.

WhatsApp, detecção de resposta/bounce, clique, inscrição automática por tag/Treg, caixa por vendedor e classificação de lead quente não estão nesta entrega. O construtor não oferece execução para esses passos e a ativação os recusa se vierem pela API. O módulo não instala código de terceiro nem anexa arquivos ao e-mail.

## Evidência deste recorte

Unitários e cercas têm resultados medidos no despacho da execução e no PR. Banco (install/update, provisionadora, RLS, LGPD), build e prova visual com e-mail de teste continuam obrigatórios antes de retirar o draft. Presença na vitrine do código não é publicação de imagem: a publicação final é do pipeline após merge/release.
