# Identificação dos responsáveis da agenda

Nome do perfil após trim, se for texto não vazio; senão, e-mail do mesmo usuário. Sem ambos: “Sem nome ou e-mail” com ID completo para distinguir opções. Leitura indisponível: aviso distinto com ID completo. Texto é renderizado como texto, nunca HTML. Conta Google não define identidade do usuário CRM.

Configuração usa membros não revogados da organização ativa pelo client de sessão. GET agenda/pessoas conserva papel mínimo agent, query e escopo atuais; só enriquece IDs já autorizados. A leitura administrativa fica restrita a esses IDs e valida o ID retornado. O DTO conserva full_name (nome-only) e acrescenta display_label, sem expor metadata, telefone, último acesso ou e-mail separado. Nenhum campo de identidade aparece em logs. O helper global nomesDosAtendentes e seus consumidores permanecem intactos.

IDs selecionados, cores, permissões, disponibilidade, vínculos, Google, motor e contextos não mudam. Não há migration ou alteração de perfil.

Destino: núcleo; identificação é necessária à operação comum, sem extensão. Entrada: membros ativos e Auth do mesmo usuário. Saídas: responsáveis/profissionais nas configurações e filtro/formulário da agenda. Porta: navegação existente de Agenda e Configurações. Falha: rótulo distinguível, contagem de falhas sem PII e nova leitura no próximo carregamento; não grava fallback nem inventa nome. Continuidade IA/humano e decisões automatizadas: não tocadas. Living System Checklist: leitura sem mutação, estado explícito e caminhos existentes preservados; não cria jornada isolada.
