# Etiquetas pesquisáveis e paginadas

Entrada: vocabulário curado, tags em uso e regras add_tag da organização. Saída: gerência paginada e sugestões nos editores do Inbox. Porta: Configurações → Tags e editor de etiquetas do Inbox. Leitura usa sessão e security invoker; não recebe organização do cliente. Operações e audit transacionais existentes permanecem.

A busca é literal, inclui nomes após a 500ª posição e mostra total verdadeiro. Erro de leitura aparece nos dois editores. A função antiga permanece para consumidores sem parâmetros. Junção aceita nome exato existente para destino fora da página, validado pelo banco.

Leitura não cria demanda nem dispara mensagens. Editar vocabulário preserva a continuidade das regras e expõe os efeitos. Falha mostra erro e permite correção; paginação/busca impede sumiço silencioso. Mapa fonte: etiquetas-paginadas.architecture.json.
