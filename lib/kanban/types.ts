import type { Lead } from "@/lib/types/leads";

export interface PipelineVocabulary {
  lead?: string;
  deal?: string;
  won?: string;
  lost?: string;
}

export interface Pipeline {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  description: string | null;
  is_default: boolean;
  is_archived: boolean;
  position: number;
  vocabulary: PipelineVocabulary;
  settings: Record<string, unknown>;
}

export interface Stage {
  id: string;
  organization_id: string;
  pipeline_id: string;
  name: string;
  slug: string;
  position: number;
  color: string | null;
  is_won: boolean;
  is_lost: boolean;
  is_archived: boolean;
  expected_duration_hours: number | null;
  /**
   * Probabilidade de GANHO da etapa, 0–100 (migration 0426). `null` = sem
   * calibração — a coluna do quadro só mostra a linha "ponderado" quando a
   * etapa tem número, para não exibir um zero que ninguém calibrou.
   *
   * `is_won`/`is_lost` valem 100 e 0 na regra (`lib/leads/previsao.ts`).
   */
  win_probability?: number | null;
}

export interface BoardData {
  pipeline: Pipeline;
  stages: Stage[];
  leads: Lead[];
  /**
   * A leitura do quadro NÃO provou o fim (#4321): veio um recorte, não o funil
   * inteiro. Ausente é o caso normal — quando o fim é provado pelo `count` da
   * primeira página, o corpo é exatamente o de sempre. Presente, a tela tem de
   * dizer que há mais cards do que os que estão na mão.
   */
  truncado?: true;
}
