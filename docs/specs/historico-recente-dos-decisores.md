# Histórico recente dos decisores

Destino: núcleo. A configuração nativa `ai_routers.config.context_message_count`
é editada em Agentes IA → Roteadores → roteador → Histórico recente dos decisores.
Unidade: mensagens históricas (cliente e atendimento), além da atual. Inteiro
0–16; zero desativa a janela. Escopo: organização e canal do roteador ativo.
Não é uma preferência global e não cria outro campo ou migração.

`quantidadeDeHistoricoSalva` centraliza a leitura/normalização. O loader nativo
do roteador mantém oito sem valor válido salvo. O worker de sentimento resolve
o roteador ativo da empresa/canal da conversa persistida e herda o valor válido;
sem canal, roteador, valor válido ou leitura confiável, mantém o padrão anterior
de dezesseis. Vínculo ativo ambíguo não escolhe o primeiro: router não se aplica
e sentimento usa seu padrão, com motivo explícito. Cada turno relê a configuração.
O painel explica os defaults diferentes até a primeira gravação válida.

Quantidade não é autorização. Roteador usa seu aceite próprio (v1 até quatro,
v2 até dezesseis); sentimento mantém `contexto_clima/v1`, até dezesseis e
16 mil caracteres, textos inteiros. Não há aumento dos máximos autorizados.
Ausência/revogação/destino alterado retiram o histórico pelo mecanismo nativo.
Principal e reserva da mesma finalidade usam a fotografia preparada enquanto
autorizada; revalidação antes da rede preservada. Sentimento não recebe o
aceite do roteador ou da revisão por herdar a quantidade.

A janela do sentimento conserva empresa/conversa/revisão/data persistidas,
ordem, autoria, sanitização, saídas efetivamente enviadas e omissões. Quantidade,
origem, motivo, cobertura e hash ficam em `messages.metadata.sentiment_context`,
sem duplicar conteúdo privado. Zero é cobertura deliberadamente limitada, não
prova de inexistência de mensagens. Histórico ausente não comprova irritação.

Não altera o pacote factual dos revisores/confirmador, pedido, evidências,
ferramentas, decisões humanas ou recibos. JEV principal, fallback e confiança
da revisão, limiar de sentimento e regras comerciais continuam independentes.
Pedido de humano/opt-out/manipulação/urgência/follow-up continuam inventariados
em seu contrato anterior, sem herdar esta janela automaticamente.

Sistema vivo: painel/rotas nativas → campo salvo → loaders/worker → entradas
JEV/reserva → metadata e Execuções. A mesma porta existente permite corrigir
a quantidade; aceites podem ser revogados em Provedores. Leitura sem valor
aplicável conserva fallback documentado, sem impedir o atendimento. Sem novo
efeito de negócio, fila, cron ou mecanismo de transferência.
