---
impacto: capacidade_nova
secao: corrigido
titulo: Cópias de playbook editadas antes da 1.64.1 voltam a avisar versão nova do catálogo
---

Até a 1.64.1, editar pela tela um playbook instalado do catálogo gravava a versão nova sem a ligação com a origem. A cópia passava a aparecer como "manual" e nunca mais avisava quando o catálogo trazia uma versão nova. A 1.64.1 corrigiu as edições daí em diante, mas as cópias editadas antes continuavam desligadas. Agora a atualização reconstrói essa ligação a partir do próprio histórico de versões da cópia, só para versões gravadas entre 23 e 30 de setembro de 2026 (do lançamento do editor até a correção), e só quando a cópia veio do catálogo. O conteúdo dos playbooks não muda, e cópias criadas por importação de pacote .zip fora desse período continuam manuais. Quem só atualizou para a 1.64.1 bem depois de 30 de setembro e editou nesse meio-tempo não é alcançado por esta reconstrução.

Você não precisa fazer nada. Depois da atualização, as cópias reconstruídas podem passar a mostrar o aviso de versão nova do catálogo.

Contribuição de @webtecnica (#2716), a partir da issue #1974.
