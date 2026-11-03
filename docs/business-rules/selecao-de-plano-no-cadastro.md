# Seleção de plano no link de cadastro

Destino: núcleo. A operação comum sem query continua inteira; não depende de uma marca.

/signup?plano=<UUID> sugere um ID da lista de planos ativos/oferecidos que lerCadastroNaTela já resolve para esta instalação. Nunca aceita preço, intervalo ou plano oculto da URL. selecionarPlanoDoLink valida UUID único com Zod e presença nessa lista. Invites têm precedência; o caminho nativo não muda. Query ausente conserva o padrão; inválida/oculta/repetida mostra alerta e o seletor existente, sem troca silenciosa. SignupForm mantém cobranca_plan_id e revalidação na signUp; padrão global não é alterado.

Google atual não transporta escolha de plano. Com query de plano, a página oferece somente email/senha e explica essa condição. Sem query ou em convite, comportamento anterior permanece. Não se altera callback, cookie, actionGoogle, convite, gateway ou entidade financeira.

## Living System Checklist

Entrada: query pública e oferecidos da leitura nativa. Saída: planoInicial no SignupForm -> cobranca_plan_id -> signUp existente. Registro: leitura não muta nem audita; cadastro mantém auditoria nativa. Tela/porta: signup existente, alcançada por link público; nenhuma tela nova. Falha: alerta visível permite conferir/reselecionar ou voltar, sem criar usuário. Configuração: planos oferecidos/padrão no administrativo existente, não query. Continuidade IA/humano não se aplica à leitura anônima. Laço: escolha inválida retorna ao seletor, validação da action continua autoridade; sem treinamento ou nova decisão automática. Mapa: selecao-plano-cadastro.architecture.json, entrada e saída concretas.

Validação: o teste puro cobre quatro opções, ausência, oculto, malformado, repetição, convite e lista vazia. Ele não substitui tipos, build ou prova pela tela. Conferir o valor e período selecionados, o padrão sem query e o aviso do link inválido sem criar conta ou assinatura. A moeda usa o idioma resolvido pelo IdiomaProvider, para manter o mesmo texto no HTML do servidor e no navegador.
