# Consulta geográfica brasileira

`compareCities` resolve nomes de municípios e ordena destinos por Haversine entre seus pontos de referência. Não mede estradas ou lojas. Não aceita coordenadas inventadas pelo modelo. Nomes ambíguos exigem UF; destino não resolvido impede ranking parcial. Sem egress, chaves, dados pessoais ou consultas tenant-aware.

`municipios.json` deriva de `csv/municipios.csv` de [kelvins/municipios-brasileiros](https://github.com/kelvins/municipios-brasileiros/tree/503e2f70bbf1b4b7ec0b1f68b09086ccc38fe861), revisão fixa 503e2f70bbf1b4b7ec0b1f68b09086ccc38fe861, obtida em 17/09/2026 UTC. Licença MIT preservada em LICENSE.municipios. Contém código IBGE, nome, UF, latitude e longitude. Não é um serviço oficial do IBGE nem uma base de filiais.

Atualização: obtenha o CSV de uma revisão fixa e a licença, converta codigo_ibge/nome/codigo_uf/latitude/longitude para ibge/city/state/latitude/longitude, registre a revisão e execute os testes. Cidades ausentes retornam origin_not_found e pedem confirmação. Não aplicar correspondência aproximada silenciosa.

A ferramenta MCP `crm_compare_city_distances` é leitura opcional no catálogo (Comparar cidades próximas). O agente primeiro consulta as cidades com unidades na base de conhecimento da própria organização e fornece essa lista. O resultado só certifica a distância entre os candidatos, não a existência nem a completude das lojas. Não move funil, transfere ou envia mensagem.

Living System: entrada = base selecionada + cidade da conversa; saída = ranking para a resposta do agente; registro = ponte MCP/auditMcpToolCall e execução da IA; superfície = Agentes > capacidades e Execuções; configuração = tool_ids na versão pela tela; retorno de erro = status estruturado e próximo passo para confirmar UF/nome. Consulta pura não exige follow-up próprio; histórico e handoff continuam no motor existente. Correção da lista de lojas é feita na base e da geografia neste módulo. Nenhuma tabela ou variável de ambiente adicionada.
