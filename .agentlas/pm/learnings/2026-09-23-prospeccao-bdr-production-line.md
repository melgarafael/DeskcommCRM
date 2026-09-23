# Prospecção, BDR e linha real de produção

- Em 2026-09-23, `crm.escreve.ai` estava na imagem `escreve-app:97f859e9`, branch
  `release/pr3-97f859e9`; a branch de trabalho de voz não era a fonte direta da
  interface publicada. Antes de corrigir regressão visual, confirme commit e
  imagem da VM para não publicar uma linha paralela por cima de correções novas.
- A navegação enxuta já continha `/app/prospecting`, mas o catálogo e overrides
  da casca a apresentavam como “Conquiste novos clientes” e “Agentes de IA”. A
  correção deve remover os overrides e preservar o catálogo como fonte única.
- Prospecção ativa é responsabilidade padrão de BDR. Funcionários criados pela
  conversa da campanha devem persistir `config.employee_role = "bdr"`; a seleção
  manual pode oferecer BDR e SDR, mantendo campanhas antigas visíveis pelo ID já
  salvo.
- Evidência local: typecheck verde; 56 testes direcionados de Prospecção e
  navegação verdes; 17 testes de idioma e papéis verdes; lint global com zero
  erros (avisos preexistentes permanecem).
