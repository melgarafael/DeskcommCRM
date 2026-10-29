export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      account_plans: {
        Row: {
          created_at: string;
          direction: string;
          id: string;
          is_active: boolean;
          name: string;
          organization_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          direction: string;
          id?: string;
          is_active?: boolean;
          name: string;
          organization_id: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          direction?: string;
          id?: string;
          is_active?: boolean;
          name?: string;
          organization_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "account_plans_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      ad_conversion_dispatches: {
        Row: {
          attempted_at: string;
          claim_token: string | null;
          claimed_until: string | null;
          created_at: string;
          currency: string | null;
          detail: string | null;
          event_id: string | null;
          event_name: string;
          event_occurred_at: string | null;
          google_action_id: string | null;
          id: string;
          lead_id: string;
          meta_event_name: string | null;
          organization_id: string;
          platform: string;
          reason: string | null;
          remote_request_id: string | null;
          remote_requested_at: string | null;
          status: string;
          updated_at: string;
          value_cents: number | null;
        };
        ComputedFields: never;
        Insert: {
          attempted_at?: string;
          claim_token?: string | null;
          claimed_until?: string | null;
          created_at?: string;
          currency?: string | null;
          detail?: string | null;
          event_id?: string | null;
          event_name: string;
          event_occurred_at?: string | null;
          google_action_id?: string | null;
          id?: string;
          lead_id: string;
          meta_event_name?: string | null;
          organization_id: string;
          platform: string;
          reason?: string | null;
          remote_request_id?: string | null;
          remote_requested_at?: string | null;
          status: string;
          updated_at?: string;
          value_cents?: number | null;
        };
        Update: {
          attempted_at?: string;
          claim_token?: string | null;
          claimed_until?: string | null;
          created_at?: string;
          currency?: string | null;
          detail?: string | null;
          event_id?: string | null;
          event_name?: string;
          event_occurred_at?: string | null;
          google_action_id?: string | null;
          id?: string;
          lead_id?: string;
          meta_event_name?: string | null;
          organization_id?: string;
          platform?: string;
          reason?: string | null;
          remote_request_id?: string | null;
          remote_requested_at?: string | null;
          status?: string;
          updated_at?: string;
          value_cents?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "ad_conversion_dispatches_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "crm_leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ad_conversion_dispatches_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      ad_hierarchy_cache: {
        Row: {
          ad_id: string;
          ad_name: string | null;
          adset_id: string | null;
          adset_name: string | null;
          campaign_id: string | null;
          campaign_name: string | null;
          created_at: string;
          fetched_at: string;
          id: string;
          organization_id: string;
          platform: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          ad_id: string;
          ad_name?: string | null;
          adset_id?: string | null;
          adset_name?: string | null;
          campaign_id?: string | null;
          campaign_name?: string | null;
          created_at?: string;
          fetched_at?: string;
          id?: string;
          organization_id: string;
          platform: string;
          updated_at?: string;
        };
        Update: {
          ad_id?: string;
          ad_name?: string | null;
          adset_id?: string | null;
          adset_name?: string | null;
          campaign_id?: string | null;
          campaign_name?: string | null;
          created_at?: string;
          fetched_at?: string;
          id?: string;
          organization_id?: string;
          platform?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ad_hierarchy_cache_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      ad_insights_connections: {
        Row: {
          access_token_encrypted: string;
          created_at: string;
          default_account_id: string | null;
          id: string;
          organization_id: string;
          platform: string;
          updated_at: string;
          updated_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          access_token_encrypted: string;
          created_at?: string;
          default_account_id?: string | null;
          id?: string;
          organization_id: string;
          platform: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          access_token_encrypted?: string;
          created_at?: string;
          default_account_id?: string | null;
          id?: string;
          organization_id?: string;
          platform?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "ad_insights_connections_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      ad_platform_connections: {
        Row: {
          access_token_encrypted: string | null;
          created_at: string;
          dataset_id: string | null;
          enabled: boolean;
          google_api: string;
          google_conversion_action_id: string | null;
          google_customer_id: string | null;
          google_login_customer_id: string | null;
          google_purchase_category: string;
          google_purchase_value_mode: string;
          google_qualification_action_id: string | null;
          google_qualification_configured_at: string | null;
          google_qualification_stage_id: string | null;
          google_refresh_token_encrypted: string | null;
          google_send_hashed_phone: boolean;
          id: string;
          organization_id: string;
          platform: string;
          test_event_code: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          access_token_encrypted?: string | null;
          created_at?: string;
          dataset_id?: string | null;
          enabled?: boolean;
          google_api?: string;
          google_conversion_action_id?: string | null;
          google_customer_id?: string | null;
          google_login_customer_id?: string | null;
          google_purchase_category?: string;
          google_purchase_value_mode?: string;
          google_qualification_action_id?: string | null;
          google_qualification_configured_at?: string | null;
          google_qualification_stage_id?: string | null;
          google_refresh_token_encrypted?: string | null;
          google_send_hashed_phone?: boolean;
          id?: string;
          organization_id: string;
          platform: string;
          test_event_code?: string | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          access_token_encrypted?: string | null;
          created_at?: string;
          dataset_id?: string | null;
          enabled?: boolean;
          google_api?: string;
          google_conversion_action_id?: string | null;
          google_customer_id?: string | null;
          google_login_customer_id?: string | null;
          google_purchase_category?: string;
          google_purchase_value_mode?: string;
          google_qualification_action_id?: string | null;
          google_qualification_configured_at?: string | null;
          google_qualification_stage_id?: string | null;
          google_refresh_token_encrypted?: string | null;
          google_send_hashed_phone?: boolean;
          id?: string;
          organization_id?: string;
          platform?: string;
          test_event_code?: string | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "ad_platform_connections_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ad_qualification_stage_org_fk";
            columns: ["organization_id", "google_qualification_stage_id"];
            isOneToOne: false;
            referencedRelation: "crm_stages";
            referencedColumns: ["organization_id", "id"];
          },
        ];
      };
      ad_tracking_links: {
        Row: {
          created_at: string;
          enabled: boolean;
          id: string;
          message_template: string;
          name: string;
          organization_id: string;
          updated_at: string;
          use_case: string;
          utm: NonNullable<Json>;
          whatsapp_e164: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          enabled?: boolean;
          id?: string;
          message_template: string;
          name: string;
          organization_id: string;
          updated_at?: string;
          use_case: string;
          utm?: NonNullable<Json>;
          whatsapp_e164: string;
        };
        Update: {
          created_at?: string;
          enabled?: boolean;
          id?: string;
          message_template?: string;
          name?: string;
          organization_id?: string;
          updated_at?: string;
          use_case?: string;
          utm?: NonNullable<Json>;
          whatsapp_e164?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ad_tracking_links_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      agent_case_chat_messages: {
        Row: {
          agent_id: string | null;
          author_kind: string;
          author_user_id: string | null;
          body: string | null;
          case_id: string;
          contact_id: string;
          conversation_id: string;
          created_at: string;
          error_code: string | null;
          id: string;
          llm_call_id: string | null;
          organization_id: string;
          redacted_at: string | null;
          service_stale: boolean;
          turn_id: string;
        };
        ComputedFields: never;
        Insert: {
          agent_id?: string | null;
          author_kind: string;
          author_user_id?: string | null;
          body?: string | null;
          case_id: string;
          contact_id: string;
          conversation_id: string;
          created_at?: string;
          error_code?: string | null;
          id?: string;
          llm_call_id?: string | null;
          organization_id: string;
          redacted_at?: string | null;
          service_stale?: boolean;
          turn_id: string;
        };
        Update: {
          agent_id?: string | null;
          author_kind?: string;
          author_user_id?: string | null;
          body?: string | null;
          case_id?: string;
          contact_id?: string;
          conversation_id?: string;
          created_at?: string;
          error_code?: string | null;
          id?: string;
          llm_call_id?: string | null;
          organization_id?: string;
          redacted_at?: string | null;
          service_stale?: boolean;
          turn_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "agent_case_chat_messages_agent_id_fkey";
            columns: ["agent_id"];
            isOneToOne: false;
            referencedRelation: "ai_agents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "agent_case_chat_messages_case_id_fkey";
            columns: ["case_id"];
            isOneToOne: false;
            referencedRelation: "agent_cases";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "agent_case_chat_messages_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "agent_case_chat_messages_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "agent_case_chat_messages_llm_call_id_fkey";
            columns: ["llm_call_id"];
            isOneToOne: false;
            referencedRelation: "llm_calls";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "agent_case_chat_messages_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      agent_case_events: {
        Row: {
          actor_kind: string;
          actor_user_id: string | null;
          body: string | null;
          case_id: string;
          created_at: string;
          human_action: string | null;
          id: string;
          kind: string;
          metadata: NonNullable<Json>;
          organization_id: string;
        };
        ComputedFields: never;
        Insert: {
          actor_kind: string;
          actor_user_id?: string | null;
          body?: string | null;
          case_id: string;
          created_at?: string;
          human_action?: string | null;
          id?: string;
          kind: string;
          metadata?: NonNullable<Json>;
          organization_id: string;
        };
        Update: {
          actor_kind?: string;
          actor_user_id?: string | null;
          body?: string | null;
          case_id?: string;
          created_at?: string;
          human_action?: string | null;
          id?: string;
          kind?: string;
          metadata?: NonNullable<Json>;
          organization_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "agent_case_events_case_id_fkey";
            columns: ["case_id"];
            isOneToOne: false;
            referencedRelation: "agent_cases";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "agent_case_events_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      agent_cases: {
        Row: {
          agent_id: string | null;
          blocker: string;
          closed_at: string | null;
          cobrancas_na_espera: number;
          context_snapshot: NonNullable<Json>;
          conversation_id: string;
          created_at: string;
          espera_desde: string | null;
          followup_attempts: number;
          id: string;
          kind: string;
          lead_id: string | null;
          opened_at: string;
          organization_id: string;
          source: string;
          status: string;
          summary: string;
          title: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          agent_id?: string | null;
          blocker: string;
          closed_at?: string | null;
          cobrancas_na_espera?: number;
          context_snapshot?: NonNullable<Json>;
          conversation_id: string;
          created_at?: string;
          espera_desde?: string | null;
          followup_attempts?: number;
          id?: string;
          kind?: string;
          lead_id?: string | null;
          opened_at?: string;
          organization_id: string;
          source?: string;
          status?: string;
          summary: string;
          title: string;
          updated_at?: string;
        };
        Update: {
          agent_id?: string | null;
          blocker?: string;
          closed_at?: string | null;
          cobrancas_na_espera?: number;
          context_snapshot?: NonNullable<Json>;
          conversation_id?: string;
          created_at?: string;
          espera_desde?: string | null;
          followup_attempts?: number;
          id?: string;
          kind?: string;
          lead_id?: string | null;
          opened_at?: string;
          organization_id?: string;
          source?: string;
          status?: string;
          summary?: string;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "agent_cases_agent_id_fkey";
            columns: ["agent_id"];
            isOneToOne: false;
            referencedRelation: "ai_agents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "agent_cases_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "agent_cases_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "crm_leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "agent_cases_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      agent_inbox_items: {
        Row: {
          appointment_revision: number | null;
          body: string | null;
          created_at: string;
          id: string;
          kind: string;
          legacy_recovery_code: string | null;
          organization_id: string | null;
          para_user_id: string | null;
          ref_id: string | null;
          ref_kind: string | null;
          resolved_at: string | null;
          severity: string;
          status: string;
          task_reminder_due_at: string | null;
          title: string;
        };
        ComputedFields: never;
        Insert: {
          appointment_revision?: number | null;
          body?: string | null;
          created_at?: string;
          id?: string;
          kind: string;
          legacy_recovery_code?: string | null;
          organization_id?: string | null;
          para_user_id?: string | null;
          ref_id?: string | null;
          ref_kind?: string | null;
          resolved_at?: string | null;
          severity?: string;
          status?: string;
          task_reminder_due_at?: string | null;
          title: string;
        };
        Update: {
          appointment_revision?: number | null;
          body?: string | null;
          created_at?: string;
          id?: string;
          kind?: string;
          legacy_recovery_code?: string | null;
          organization_id?: string | null;
          para_user_id?: string | null;
          ref_id?: string | null;
          ref_kind?: string | null;
          resolved_at?: string | null;
          severity?: string;
          status?: string;
          task_reminder_due_at?: string | null;
          title?: string;
        };
        Relationships: [
          {
            foreignKeyName: "agent_inbox_items_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      agent_turn_traces: {
        Row: {
          abort_reason: string | null;
          agent_id: string | null;
          agent_version_id: string | null;
          contact_id: string | null;
          conversation_id: string | null;
          cost_cents: number;
          created_at: string;
          error_code: string | null;
          error_message: string | null;
          ferramentas: NonNullable<Json>;
          ferramentas_truncadas: boolean;
          historico_mensagens: number | null;
          id: string;
          is_dry_run: boolean;
          job_id: string | null;
          kb_sources: NonNullable<Json>;
          latency_ms: number;
          messages_sent: number;
          model: string | null;
          organization_id: string;
          preview_run_id: string | null;
          provider: string | null;
          skills: NonNullable<Json>;
          status: string;
          tokens_in: number;
          tokens_out: number;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          abort_reason?: string | null;
          agent_id?: string | null;
          agent_version_id?: string | null;
          contact_id?: string | null;
          conversation_id?: string | null;
          cost_cents?: number;
          created_at?: string;
          error_code?: string | null;
          error_message?: string | null;
          ferramentas?: NonNullable<Json>;
          ferramentas_truncadas?: boolean;
          historico_mensagens?: number | null;
          id?: string;
          is_dry_run?: boolean;
          job_id?: string | null;
          kb_sources?: NonNullable<Json>;
          latency_ms?: number;
          messages_sent?: number;
          model?: string | null;
          organization_id: string;
          preview_run_id?: string | null;
          provider?: string | null;
          skills?: NonNullable<Json>;
          status: string;
          tokens_in?: number;
          tokens_out?: number;
          updated_at?: string;
        };
        Update: {
          abort_reason?: string | null;
          agent_id?: string | null;
          agent_version_id?: string | null;
          contact_id?: string | null;
          conversation_id?: string | null;
          cost_cents?: number;
          created_at?: string;
          error_code?: string | null;
          error_message?: string | null;
          ferramentas?: NonNullable<Json>;
          ferramentas_truncadas?: boolean;
          historico_mensagens?: number | null;
          id?: string;
          is_dry_run?: boolean;
          job_id?: string | null;
          kb_sources?: NonNullable<Json>;
          latency_ms?: number;
          messages_sent?: number;
          model?: string | null;
          organization_id?: string;
          preview_run_id?: string | null;
          provider?: string | null;
          skills?: NonNullable<Json>;
          status?: string;
          tokens_in?: number;
          tokens_out?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "agent_turn_traces_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_agent_runs: {
        Row: {
          abort_reason: string | null;
          agent_id: string;
          agent_version_id: string;
          channel_session_id: string | null;
          completed_at: string | null;
          contact_id: string | null;
          conversation_id: string | null;
          cost_cents: number;
          created_at: string;
          error_code: string | null;
          error_message: string | null;
          id: string;
          inbound_message_id: string | null;
          is_dry_run: boolean;
          latency_ms: number | null;
          organization_id: string;
          outbound_message_id: string | null;
          started_at: string;
          status: string;
          steps_count: number;
          tokens_in: number;
          tokens_out: number;
          tool_calls: NonNullable<Json>;
        };
        ComputedFields: never;
        Insert: {
          abort_reason?: string | null;
          agent_id: string;
          agent_version_id: string;
          channel_session_id?: string | null;
          completed_at?: string | null;
          contact_id?: string | null;
          conversation_id?: string | null;
          cost_cents?: number;
          created_at?: string;
          error_code?: string | null;
          error_message?: string | null;
          id?: string;
          inbound_message_id?: string | null;
          is_dry_run?: boolean;
          latency_ms?: number | null;
          organization_id: string;
          outbound_message_id?: string | null;
          started_at?: string;
          status?: string;
          steps_count?: number;
          tokens_in?: number;
          tokens_out?: number;
          tool_calls?: NonNullable<Json>;
        };
        Update: {
          abort_reason?: string | null;
          agent_id?: string;
          agent_version_id?: string;
          channel_session_id?: string | null;
          completed_at?: string | null;
          contact_id?: string | null;
          conversation_id?: string | null;
          cost_cents?: number;
          created_at?: string;
          error_code?: string | null;
          error_message?: string | null;
          id?: string;
          inbound_message_id?: string | null;
          is_dry_run?: boolean;
          latency_ms?: number | null;
          organization_id?: string;
          outbound_message_id?: string | null;
          started_at?: string;
          status?: string;
          steps_count?: number;
          tokens_in?: number;
          tokens_out?: number;
          tool_calls?: NonNullable<Json>;
        };
        Relationships: [
          {
            foreignKeyName: "ai_agent_runs_agent_id_fkey";
            columns: ["agent_id"];
            isOneToOne: false;
            referencedRelation: "ai_agents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_agent_runs_agent_version_id_fkey";
            columns: ["agent_version_id"];
            isOneToOne: false;
            referencedRelation: "ai_agent_versions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_agent_runs_channel_session_id_fkey";
            columns: ["channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_agent_runs_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_agent_runs_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_agent_runs_inbound_message_id_fkey";
            columns: ["inbound_message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_agent_runs_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_agent_runs_outbound_message_id_fkey";
            columns: ["outbound_message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_agent_version_channels: {
        Row: {
          agent_version_id: string;
          channel_session_id: string;
          created_at: string;
          id: string;
          organization_id: string;
        };
        ComputedFields: never;
        Insert: {
          agent_version_id: string;
          channel_session_id: string;
          created_at?: string;
          id?: string;
          organization_id: string;
        };
        Update: {
          agent_version_id?: string;
          channel_session_id?: string;
          created_at?: string;
          id?: string;
          organization_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ai_agent_version_channels_numero_da_org_fk";
            columns: ["organization_id", "channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "ai_agent_version_channels_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_agent_version_channels_versao_da_org_fk";
            columns: ["organization_id", "agent_version_id"];
            isOneToOne: false;
            referencedRelation: "ai_agent_versions";
            referencedColumns: ["organization_id", "id"];
          },
        ];
      };
      ai_agent_versions: {
        Row: {
          agent_id: string;
          cases_enabled: boolean;
          channel_session_id: string | null;
          cost_budget_cents: number;
          created_at: string;
          created_by: string | null;
          credential_id: string | null;
          followup: NonNullable<Json>;
          handoff_keywords: string[];
          handoff_legal_enabled: boolean;
          handoff_tool_enabled: boolean;
          history_message_window: number;
          history_token_window: number;
          id: string;
          inbound_debounce_ms: number | null;
          knowledge_source_ids: string[];
          max_steps: number;
          model: string;
          multimodal_input: boolean;
          operator_enabled: boolean;
          operator_model: string | null;
          operator_tool_ids: string[];
          organization_id: string;
          pipeline_ids: string[];
          proposal_ai_draft_enabled: boolean;
          provider: string;
          provisioning_origin: string | null;
          published_at: string | null;
          split_max_chars: number;
          split_messages: boolean;
          status: string;
          superseded_at: string | null;
          system_prompt: string;
          token_budget: number;
          tool_ids: string[];
          trigger_config: NonNullable<Json>;
          version_number: number;
          video_frames_enabled: boolean;
        };
        ComputedFields: never;
        Insert: {
          agent_id: string;
          cases_enabled?: boolean;
          channel_session_id?: string | null;
          cost_budget_cents?: number;
          created_at?: string;
          created_by?: string | null;
          credential_id?: string | null;
          followup?: NonNullable<Json>;
          handoff_keywords?: string[];
          handoff_legal_enabled?: boolean;
          handoff_tool_enabled?: boolean;
          history_message_window?: number;
          history_token_window?: number;
          id?: string;
          inbound_debounce_ms?: number | null;
          knowledge_source_ids?: string[];
          max_steps?: number;
          model: string;
          multimodal_input?: boolean;
          operator_enabled?: boolean;
          operator_model?: string | null;
          operator_tool_ids?: string[];
          organization_id: string;
          pipeline_ids?: string[];
          proposal_ai_draft_enabled?: boolean;
          provider: string;
          provisioning_origin?: string | null;
          published_at?: string | null;
          split_max_chars?: number;
          split_messages?: boolean;
          status?: string;
          superseded_at?: string | null;
          system_prompt: string;
          token_budget?: number;
          tool_ids?: string[];
          trigger_config?: NonNullable<Json>;
          version_number: number;
          video_frames_enabled?: boolean;
        };
        Update: {
          agent_id?: string;
          cases_enabled?: boolean;
          channel_session_id?: string | null;
          cost_budget_cents?: number;
          created_at?: string;
          created_by?: string | null;
          credential_id?: string | null;
          followup?: NonNullable<Json>;
          handoff_keywords?: string[];
          handoff_legal_enabled?: boolean;
          handoff_tool_enabled?: boolean;
          history_message_window?: number;
          history_token_window?: number;
          id?: string;
          inbound_debounce_ms?: number | null;
          knowledge_source_ids?: string[];
          max_steps?: number;
          model?: string;
          multimodal_input?: boolean;
          operator_enabled?: boolean;
          operator_model?: string | null;
          operator_tool_ids?: string[];
          organization_id?: string;
          pipeline_ids?: string[];
          proposal_ai_draft_enabled?: boolean;
          provider?: string;
          provisioning_origin?: string | null;
          published_at?: string | null;
          split_max_chars?: number;
          split_messages?: boolean;
          status?: string;
          superseded_at?: string | null;
          system_prompt?: string;
          token_budget?: number;
          tool_ids?: string[];
          trigger_config?: NonNullable<Json>;
          version_number?: number;
          video_frames_enabled?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "ai_agent_versions_agent_id_fkey";
            columns: ["agent_id"];
            isOneToOne: false;
            referencedRelation: "ai_agents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_agent_versions_channel_session_id_fkey";
            columns: ["channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_agent_versions_credential_id_fkey";
            columns: ["credential_id"];
            isOneToOne: false;
            referencedRelation: "ai_provider_credentials";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_agent_versions_credential_id_fkey";
            columns: ["credential_id"];
            isOneToOne: false;
            referencedRelation: "ai_provider_credentials_safe";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_agent_versions_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_agents: {
        Row: {
          active_kb_version_id: string | null;
          archived_at: string | null;
          channel: string;
          config: NonNullable<Json>;
          created_at: string;
          created_by: string | null;
          description: string | null;
          guardrails: NonNullable<Json>;
          id: string;
          is_active: boolean;
          is_default: boolean;
          kind: string;
          model: string;
          name: string;
          operation_mode: string;
          operation_revision: number;
          organization_id: string;
          paused_at: string | null;
          priority: number;
          published_version_id: string | null;
          system_prompt: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          active_kb_version_id?: string | null;
          archived_at?: string | null;
          channel?: string;
          config?: NonNullable<Json>;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          guardrails?: NonNullable<Json>;
          id?: string;
          is_active?: boolean;
          is_default?: boolean;
          kind?: string;
          model?: string;
          name: string;
          operation_mode?: string;
          operation_revision?: number;
          organization_id: string;
          paused_at?: string | null;
          priority?: number;
          published_version_id?: string | null;
          system_prompt: string;
          updated_at?: string;
        };
        Update: {
          active_kb_version_id?: string | null;
          archived_at?: string | null;
          channel?: string;
          config?: NonNullable<Json>;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          guardrails?: NonNullable<Json>;
          id?: string;
          is_active?: boolean;
          is_default?: boolean;
          kind?: string;
          model?: string;
          name?: string;
          operation_mode?: string;
          operation_revision?: number;
          organization_id?: string;
          paused_at?: string | null;
          priority?: number;
          published_version_id?: string | null;
          system_prompt?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ai_agents_active_kb_version_id_fkey";
            columns: ["active_kb_version_id"];
            isOneToOne: false;
            referencedRelation: "ai_knowledge_versions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_agents_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_agents_published_version_id_fkey";
            columns: ["published_version_id"];
            isOneToOne: false;
            referencedRelation: "ai_agent_versions";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_budgets: {
        Row: {
          action_at_100pct: string;
          alarm_threshold_pct: number;
          current_month_consumed_cents: number;
          current_period_start: string;
          enforcement_effective_at: string | null;
          enforcement_mode: string;
          is_disabled: boolean;
          is_throttled: boolean;
          last_alarm_sent_at: string | null;
          monthly_limit_cents: number;
          organization_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          action_at_100pct?: string;
          alarm_threshold_pct?: number;
          current_month_consumed_cents?: number;
          current_period_start?: string;
          enforcement_effective_at?: string | null;
          enforcement_mode?: string;
          is_disabled?: boolean;
          is_throttled?: boolean;
          last_alarm_sent_at?: string | null;
          monthly_limit_cents?: number;
          organization_id: string;
          updated_at?: string;
        };
        Update: {
          action_at_100pct?: string;
          alarm_threshold_pct?: number;
          current_month_consumed_cents?: number;
          current_period_start?: string;
          enforcement_effective_at?: string | null;
          enforcement_mode?: string;
          is_disabled?: boolean;
          is_throttled?: boolean;
          last_alarm_sent_at?: string | null;
          monthly_limit_cents?: number;
          organization_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ai_budgets_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: true;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_chunks: {
        Row: {
          content: string;
          content_hash: string;
          created_at: string;
          embedding: string;
          id: string;
          kb_version_id: string;
          knowledge_source_id: string;
          metadata: NonNullable<Json>;
          organization_id: string;
          position: number;
          token_count: number;
        };
        ComputedFields: never;
        Insert: {
          content: string;
          content_hash: string;
          created_at?: string;
          embedding: string;
          id?: string;
          kb_version_id: string;
          knowledge_source_id: string;
          metadata?: NonNullable<Json>;
          organization_id: string;
          position: number;
          token_count: number;
        };
        Update: {
          content?: string;
          content_hash?: string;
          created_at?: string;
          embedding?: string;
          id?: string;
          kb_version_id?: string;
          knowledge_source_id?: string;
          metadata?: NonNullable<Json>;
          organization_id?: string;
          position?: number;
          token_count?: number;
        };
        Relationships: [
          {
            foreignKeyName: "ai_chunks_kb_version_id_fkey";
            columns: ["kb_version_id"];
            isOneToOne: false;
            referencedRelation: "ai_knowledge_versions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_chunks_knowledge_source_id_fkey";
            columns: ["knowledge_source_id"];
            isOneToOne: false;
            referencedRelation: "ai_knowledge_sources";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_chunks_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_faq_items: {
        Row: {
          answer: string;
          created_at: string;
          id: string;
          knowledge_source_id: string;
          locale: string;
          organization_id: string;
          position: number;
          question: string;
          tags: string[];
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          answer: string;
          created_at?: string;
          id?: string;
          knowledge_source_id: string;
          locale?: string;
          organization_id: string;
          position?: number;
          question: string;
          tags?: string[];
          updated_at?: string;
        };
        Update: {
          answer?: string;
          created_at?: string;
          id?: string;
          knowledge_source_id?: string;
          locale?: string;
          organization_id?: string;
          position?: number;
          question?: string;
          tags?: string[];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ai_faq_items_knowledge_source_id_fkey";
            columns: ["knowledge_source_id"];
            isOneToOne: false;
            referencedRelation: "ai_knowledge_sources";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_faq_items_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_invocations: {
        Row: {
          agent_id: string | null;
          citations: NonNullable<Json>;
          completion_tokens: number;
          conversation_id: string | null;
          cost_cents: number;
          created_at: string;
          error_payload: Json | null;
          finish_reason: string | null;
          id: string;
          invocation_kind: string;
          latency_ms: number;
          message_id: string | null;
          model: string;
          organization_id: string;
          prompt_blob_path: string | null;
          prompt_tokens: number;
          response_blob_path: string | null;
          total_tokens: number | null;
        };
        ComputedFields: never;
        Insert: {
          agent_id?: string | null;
          citations?: NonNullable<Json>;
          completion_tokens?: number;
          conversation_id?: string | null;
          cost_cents?: number;
          created_at?: string;
          error_payload?: Json | null;
          finish_reason?: string | null;
          id?: string;
          invocation_kind: string;
          latency_ms: number;
          message_id?: string | null;
          model: string;
          organization_id: string;
          prompt_blob_path?: string | null;
          prompt_tokens?: number;
          response_blob_path?: string | null;
          total_tokens?: never;
        };
        Update: {
          agent_id?: string | null;
          citations?: NonNullable<Json>;
          completion_tokens?: number;
          conversation_id?: string | null;
          cost_cents?: number;
          created_at?: string;
          error_payload?: Json | null;
          finish_reason?: string | null;
          id?: string;
          invocation_kind?: string;
          latency_ms?: number;
          message_id?: string | null;
          model?: string;
          organization_id?: string;
          prompt_blob_path?: string | null;
          prompt_tokens?: number;
          response_blob_path?: string | null;
          total_tokens?: never;
        };
        Relationships: [
          {
            foreignKeyName: "ai_invocations_agent_id_fkey";
            columns: ["agent_id"];
            isOneToOne: false;
            referencedRelation: "ai_agents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_invocations_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_invocations_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_invocations_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_knowledge_sources: {
        Row: {
          active_kb_version_id: string | null;
          agent_id: string | null;
          chunks_count: number;
          content_hash: string | null;
          created_at: string;
          id: string;
          ingested_at: string | null;
          is_active: boolean;
          last_index_error: string | null;
          last_index_status: string | null;
          last_indexed_at: string | null;
          name: string;
          organization_id: string;
          source_metadata: NonNullable<Json>;
          source_type: string;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          active_kb_version_id?: string | null;
          agent_id?: string | null;
          chunks_count?: number;
          content_hash?: string | null;
          created_at?: string;
          id?: string;
          ingested_at?: string | null;
          is_active?: boolean;
          last_index_error?: string | null;
          last_index_status?: string | null;
          last_indexed_at?: string | null;
          name?: string;
          organization_id: string;
          source_metadata?: NonNullable<Json>;
          source_type: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          active_kb_version_id?: string | null;
          agent_id?: string | null;
          chunks_count?: number;
          content_hash?: string | null;
          created_at?: string;
          id?: string;
          ingested_at?: string | null;
          is_active?: boolean;
          last_index_error?: string | null;
          last_index_status?: string | null;
          last_indexed_at?: string | null;
          name?: string;
          organization_id?: string;
          source_metadata?: NonNullable<Json>;
          source_type?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ai_knowledge_sources_active_kb_version_id_fkey";
            columns: ["active_kb_version_id"];
            isOneToOne: false;
            referencedRelation: "ai_knowledge_versions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_knowledge_sources_agent_id_fkey";
            columns: ["agent_id"];
            isOneToOne: false;
            referencedRelation: "ai_agents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_knowledge_sources_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_knowledge_versions: {
        Row: {
          activated_at: string | null;
          activated_by: string | null;
          agent_id: string | null;
          created_at: string;
          description: string | null;
          embedding_dims: number | null;
          embedding_model: string | null;
          error_message: string | null;
          id: string;
          indexed_at: string | null;
          is_active: boolean;
          knowledge_source_id: string | null;
          organization_id: string;
          sources_snapshot: NonNullable<Json>;
          status: string | null;
          total_chunks: number;
          version_number: number;
        };
        ComputedFields: never;
        Insert: {
          activated_at?: string | null;
          activated_by?: string | null;
          agent_id?: string | null;
          created_at?: string;
          description?: string | null;
          embedding_dims?: number | null;
          embedding_model?: string | null;
          error_message?: string | null;
          id?: string;
          indexed_at?: string | null;
          is_active?: boolean;
          knowledge_source_id?: string | null;
          organization_id: string;
          sources_snapshot?: NonNullable<Json>;
          status?: string | null;
          total_chunks?: number;
          version_number: number;
        };
        Update: {
          activated_at?: string | null;
          activated_by?: string | null;
          agent_id?: string | null;
          created_at?: string;
          description?: string | null;
          embedding_dims?: number | null;
          embedding_model?: string | null;
          error_message?: string | null;
          id?: string;
          indexed_at?: string | null;
          is_active?: boolean;
          knowledge_source_id?: string | null;
          organization_id?: string;
          sources_snapshot?: NonNullable<Json>;
          status?: string | null;
          total_chunks?: number;
          version_number?: number;
        };
        Relationships: [
          {
            foreignKeyName: "ai_knowledge_versions_agent_id_fkey";
            columns: ["agent_id"];
            isOneToOne: false;
            referencedRelation: "ai_agents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_knowledge_versions_knowledge_source_id_fkey";
            columns: ["knowledge_source_id"];
            isOneToOne: false;
            referencedRelation: "ai_knowledge_sources";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_knowledge_versions_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_models: {
        Row: {
          context_window: number | null;
          deprecated_at: string | null;
          description: string | null;
          display_name: string;
          embedding_dims: number | null;
          id: string;
          input_price_per_million_cents: number | null;
          is_default_for_provider: boolean;
          metadata: NonNullable<Json>;
          model_id: string;
          output_price_per_million_cents: number | null;
          provider: string;
          released_at: string | null;
          source: string;
          supports_embedding: boolean;
          supports_tools: boolean;
          supports_vision: boolean;
          synced_at: string | null;
        };
        ComputedFields: never;
        Insert: {
          context_window?: number | null;
          deprecated_at?: string | null;
          description?: string | null;
          display_name: string;
          embedding_dims?: number | null;
          id?: string;
          input_price_per_million_cents?: number | null;
          is_default_for_provider?: boolean;
          metadata?: NonNullable<Json>;
          model_id: string;
          output_price_per_million_cents?: number | null;
          provider: string;
          released_at?: string | null;
          source?: string;
          supports_embedding?: boolean;
          supports_tools?: boolean;
          supports_vision?: boolean;
          synced_at?: string | null;
        };
        Update: {
          context_window?: number | null;
          deprecated_at?: string | null;
          description?: string | null;
          display_name?: string;
          embedding_dims?: number | null;
          id?: string;
          input_price_per_million_cents?: number | null;
          is_default_for_provider?: boolean;
          metadata?: NonNullable<Json>;
          model_id?: string;
          output_price_per_million_cents?: number | null;
          provider?: string;
          released_at?: string | null;
          source?: string;
          supports_embedding?: boolean;
          supports_tools?: boolean;
          supports_vision?: boolean;
          synced_at?: string | null;
        };
        Relationships: [];
      };
      ai_pricing: {
        Row: {
          completion_cents_per_million_tokens: number | null;
          effective_from: string;
          embedding_cents_per_million_tokens: number | null;
          model: string;
          notes: string | null;
          prompt_cents_per_million_tokens: number | null;
          superseded_at: string | null;
        };
        ComputedFields: never;
        Insert: {
          completion_cents_per_million_tokens?: number | null;
          effective_from?: string;
          embedding_cents_per_million_tokens?: number | null;
          model: string;
          notes?: string | null;
          prompt_cents_per_million_tokens?: number | null;
          superseded_at?: string | null;
        };
        Update: {
          completion_cents_per_million_tokens?: number | null;
          effective_from?: string;
          embedding_cents_per_million_tokens?: number | null;
          model?: string;
          notes?: string | null;
          prompt_cents_per_million_tokens?: number | null;
          superseded_at?: string | null;
        };
        Relationships: [];
      };
      ai_provider_credentials: {
        Row: {
          api_key_encrypted: string;
          api_key_iv: string;
          api_key_last4: string;
          api_key_tag: string;
          base_url: string | null;
          created_at: string;
          created_by: string | null;
          id: string;
          is_active: boolean;
          label: string;
          models_available: string[] | null;
          organization_id: string;
          provider: string;
          updated_at: string;
          validated_at: string | null;
          validation_error: string | null;
        };
        ComputedFields: never;
        Insert: {
          api_key_encrypted: string;
          api_key_iv: string;
          api_key_last4: string;
          api_key_tag: string;
          base_url?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_active?: boolean;
          label: string;
          models_available?: string[] | null;
          organization_id: string;
          provider: string;
          updated_at?: string;
          validated_at?: string | null;
          validation_error?: string | null;
        };
        Update: {
          api_key_encrypted?: string;
          api_key_iv?: string;
          api_key_last4?: string;
          api_key_tag?: string;
          base_url?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_active?: boolean;
          label?: string;
          models_available?: string[] | null;
          organization_id?: string;
          provider?: string;
          updated_at?: string;
          validated_at?: string | null;
          validation_error?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "ai_provider_credentials_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_purpose_bindings: {
        Row: {
          base_url: string | null;
          created_at: string;
          credential_id: string | null;
          id: string;
          is_enabled: boolean;
          model_id: string;
          organization_id: string;
          provider: string;
          purpose: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          base_url?: string | null;
          created_at?: string;
          credential_id?: string | null;
          id?: string;
          is_enabled?: boolean;
          model_id: string;
          organization_id: string;
          provider: string;
          purpose: string;
          updated_at?: string;
        };
        Update: {
          base_url?: string | null;
          created_at?: string;
          credential_id?: string | null;
          id?: string;
          is_enabled?: boolean;
          model_id?: string;
          organization_id?: string;
          provider?: string;
          purpose?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ai_purpose_bindings_credential_id_fkey";
            columns: ["credential_id"];
            isOneToOne: false;
            referencedRelation: "ai_provider_credentials";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_purpose_bindings_credential_id_fkey";
            columns: ["credential_id"];
            isOneToOne: false;
            referencedRelation: "ai_provider_credentials_safe";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_purpose_bindings_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_reply_drafts: {
        Row: {
          agent_id: string;
          agent_version_id: string;
          approved_at: string | null;
          approved_body: string | null;
          approved_by: string | null;
          approved_support_session_id: string | null;
          channel_session_id: string;
          contact_id: string;
          context_revision: number;
          conversation_id: string;
          created_at: string;
          edited_body: string | null;
          error_code: string | null;
          feedback: Json | null;
          generation_token: string;
          id: string;
          message_id: string | null;
          operation_revision: number;
          organization_id: string;
          original_body: string | null;
          proposals: NonNullable<Json>;
          revision: number;
          send_job_id: string | null;
          service_boundary: NonNullable<Json>;
          status: string;
          trace: NonNullable<Json>;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          agent_id: string;
          agent_version_id: string;
          approved_at?: string | null;
          approved_body?: string | null;
          approved_by?: string | null;
          approved_support_session_id?: string | null;
          channel_session_id: string;
          contact_id: string;
          context_revision: number;
          conversation_id: string;
          created_at?: string;
          edited_body?: string | null;
          error_code?: string | null;
          feedback?: Json | null;
          generation_token?: string;
          id?: string;
          message_id?: string | null;
          operation_revision: number;
          organization_id: string;
          original_body?: string | null;
          proposals?: NonNullable<Json>;
          revision?: number;
          send_job_id?: string | null;
          service_boundary: NonNullable<Json>;
          status?: string;
          trace?: NonNullable<Json>;
          updated_at?: string;
        };
        Update: {
          agent_id?: string;
          agent_version_id?: string;
          approved_at?: string | null;
          approved_body?: string | null;
          approved_by?: string | null;
          approved_support_session_id?: string | null;
          channel_session_id?: string;
          contact_id?: string;
          context_revision?: number;
          conversation_id?: string;
          created_at?: string;
          edited_body?: string | null;
          error_code?: string | null;
          feedback?: Json | null;
          generation_token?: string;
          id?: string;
          message_id?: string | null;
          operation_revision?: number;
          organization_id?: string;
          original_body?: string | null;
          proposals?: NonNullable<Json>;
          revision?: number;
          send_job_id?: string | null;
          service_boundary?: NonNullable<Json>;
          status?: string;
          trace?: NonNullable<Json>;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ai_reply_drafts_agent_id_fkey";
            columns: ["agent_id"];
            isOneToOne: false;
            referencedRelation: "ai_agents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_reply_drafts_agent_version_id_fkey";
            columns: ["agent_version_id"];
            isOneToOne: false;
            referencedRelation: "ai_agent_versions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_reply_drafts_approved_support_session_id_fkey";
            columns: ["approved_support_session_id"];
            isOneToOne: false;
            referencedRelation: "platform_support_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_reply_drafts_channel_session_id_fkey";
            columns: ["channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_reply_drafts_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_reply_drafts_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_reply_drafts_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_reply_drafts_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_reply_drafts_send_job_id_fkey";
            columns: ["send_job_id"];
            isOneToOne: true;
            referencedRelation: "job_queue";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_router_decisions: {
        Row: {
          agent_id: string | null;
          confidence: number | null;
          conversation_id: string | null;
          created_at: string;
          id: string;
          intent_name: string | null;
          job_id: string | null;
          organization_id: string;
          outcome: string;
          router_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          agent_id?: string | null;
          confidence?: number | null;
          conversation_id?: string | null;
          created_at?: string;
          id?: string;
          intent_name?: string | null;
          job_id?: string | null;
          organization_id: string;
          outcome: string;
          router_id?: string | null;
        };
        Update: {
          agent_id?: string | null;
          confidence?: number | null;
          conversation_id?: string | null;
          created_at?: string;
          id?: string;
          intent_name?: string | null;
          job_id?: string | null;
          organization_id?: string;
          outcome?: string;
          router_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "ai_router_decisions_agent_id_fkey";
            columns: ["agent_id"];
            isOneToOne: false;
            referencedRelation: "ai_agents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_router_decisions_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_router_decisions_router_id_fkey";
            columns: ["router_id"];
            isOneToOne: false;
            referencedRelation: "ai_routers";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_router_members: {
        Row: {
          agent_id: string;
          created_at: string;
          examples: string[];
          flow_pointer_id: string | null;
          id: string;
          intent_description: string;
          intent_name: string;
          organization_id: string;
          pipeline_id: string | null;
          position: number;
          router_id: string;
          stage_id: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          agent_id: string;
          created_at?: string;
          examples?: string[];
          flow_pointer_id?: string | null;
          id?: string;
          intent_description: string;
          intent_name: string;
          organization_id: string;
          pipeline_id?: string | null;
          position?: number;
          router_id: string;
          stage_id?: string | null;
          updated_at?: string;
        };
        Update: {
          agent_id?: string;
          created_at?: string;
          examples?: string[];
          flow_pointer_id?: string | null;
          id?: string;
          intent_description?: string;
          intent_name?: string;
          organization_id?: string;
          pipeline_id?: string | null;
          position?: number;
          router_id?: string;
          stage_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ai_router_members_agent_id_fkey";
            columns: ["agent_id"];
            isOneToOne: false;
            referencedRelation: "ai_agents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_router_members_flow_pointer_mesma_org";
            columns: ["organization_id", "flow_pointer_id"];
            isOneToOne: false;
            referencedRelation: "followup_flow_pointers";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "ai_router_members_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_router_members_pipeline_mesma_org";
            columns: ["organization_id", "pipeline_id"];
            isOneToOne: false;
            referencedRelation: "crm_pipelines";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "ai_router_members_router_id_fkey";
            columns: ["router_id"];
            isOneToOne: false;
            referencedRelation: "ai_routers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_router_members_stage_mesma_org";
            columns: ["organization_id", "stage_id"];
            isOneToOne: false;
            referencedRelation: "crm_stages";
            referencedColumns: ["organization_id", "id"];
          },
        ];
      };
      ai_routers: {
        Row: {
          channel_session_id: string;
          config: NonNullable<Json>;
          created_at: string;
          created_by: string | null;
          fallback_agent_id: string | null;
          id: string;
          is_active: boolean;
          name: string;
          organization_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          channel_session_id: string;
          config?: NonNullable<Json>;
          created_at?: string;
          created_by?: string | null;
          fallback_agent_id?: string | null;
          id?: string;
          is_active?: boolean;
          name: string;
          organization_id: string;
          updated_at?: string;
        };
        Update: {
          channel_session_id?: string;
          config?: NonNullable<Json>;
          created_at?: string;
          created_by?: string | null;
          fallback_agent_id?: string | null;
          id?: string;
          is_active?: boolean;
          name?: string;
          organization_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ai_routers_channel_session_id_fkey";
            columns: ["channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_routers_fallback_agent_id_fkey";
            columns: ["fallback_agent_id"];
            isOneToOne: false;
            referencedRelation: "ai_agents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_routers_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      api_audit_log: {
        Row: {
          acting_as_platform_admin: boolean;
          action: string;
          actor_api_token_id: string | null;
          actor_ip: unknown;
          actor_user_agent: string | null;
          actor_user_id: string | null;
          bypassed_rls: boolean;
          created_at: string;
          id: string;
          metadata: NonNullable<Json>;
          organization_id: string | null;
          request_id: string | null;
          resource_id: string | null;
          resource_type: string | null;
        };
        ComputedFields: never;
        Insert: {
          acting_as_platform_admin?: boolean;
          action: string;
          actor_api_token_id?: string | null;
          actor_ip?: unknown;
          actor_user_agent?: string | null;
          actor_user_id?: string | null;
          bypassed_rls?: boolean;
          created_at?: string;
          id?: string;
          metadata?: NonNullable<Json>;
          organization_id?: string | null;
          request_id?: string | null;
          resource_id?: string | null;
          resource_type?: string | null;
        };
        Update: {
          acting_as_platform_admin?: boolean;
          action?: string;
          actor_api_token_id?: string | null;
          actor_ip?: unknown;
          actor_user_agent?: string | null;
          actor_user_id?: string | null;
          bypassed_rls?: boolean;
          created_at?: string;
          id?: string;
          metadata?: NonNullable<Json>;
          organization_id?: string | null;
          request_id?: string | null;
          resource_id?: string | null;
          resource_type?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "api_audit_log_actor_api_token_id_fkey";
            columns: ["actor_api_token_id"];
            isOneToOne: false;
            referencedRelation: "api_tokens";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "api_audit_log_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      api_tokens: {
        Row: {
          created_at: string;
          created_by: string;
          expires_at: string | null;
          id: string;
          last_used_at: string | null;
          last_used_ip: unknown;
          name: string;
          organization_id: string;
          prefix: string;
          revoked_at: string | null;
          revoked_by: string | null;
          scopes: NonNullable<Json>;
          token_hash: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by: string;
          expires_at?: string | null;
          id?: string;
          last_used_at?: string | null;
          last_used_ip?: unknown;
          name: string;
          organization_id: string;
          prefix: string;
          revoked_at?: string | null;
          revoked_by?: string | null;
          scopes?: NonNullable<Json>;
          token_hash: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string;
          expires_at?: string | null;
          id?: string;
          last_used_at?: string | null;
          last_used_ip?: unknown;
          name?: string;
          organization_id?: string;
          prefix?: string;
          revoked_at?: string | null;
          revoked_by?: string | null;
          scopes?: NonNullable<Json>;
          token_hash?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "api_tokens_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      appointment_recovery_receipts: {
        Row: {
          appointment_id: string;
          appointment_revision: number;
          enrollment_id: string | null;
          invalidated_at: string | null;
          organization_id: string;
          pointer_id: string | null;
          recorded_at: string;
          result: string;
          source_event_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          appointment_id: string;
          appointment_revision: number;
          enrollment_id?: string | null;
          invalidated_at?: string | null;
          organization_id: string;
          pointer_id?: string | null;
          recorded_at?: string;
          result: string;
          source_event_id?: string | null;
        };
        Update: {
          appointment_id?: string;
          appointment_revision?: number;
          enrollment_id?: string | null;
          invalidated_at?: string | null;
          organization_id?: string;
          pointer_id?: string | null;
          recorded_at?: string;
          result?: string;
          source_event_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "appointment_recovery_receipts_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "calendar_appointments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "appointment_recovery_receipts_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "calendar_google_reconcilable_appointments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "appointment_recovery_receipts_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "calendar_service_google_candidates";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "appointment_recovery_receipts_enrollment_id_fkey";
            columns: ["enrollment_id"];
            isOneToOne: false;
            referencedRelation: "followup_enrollments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "appointment_recovery_receipts_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "appointment_recovery_receipts_pointer_id_fkey";
            columns: ["pointer_id"];
            isOneToOne: false;
            referencedRelation: "followup_flow_pointers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "appointment_recovery_receipts_source_event_id_fkey";
            columns: ["source_event_id"];
            isOneToOne: false;
            referencedRelation: "event_log";
            referencedColumns: ["id"];
          },
        ];
      };
      attendant_availability: {
        Row: {
          capacity: number;
          id: string;
          is_available: boolean;
          last_heartbeat_at: string | null;
          organization_id: string;
          schedule: NonNullable<Json>;
          updated_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          capacity?: number;
          id?: string;
          is_available?: boolean;
          last_heartbeat_at?: string | null;
          organization_id: string;
          schedule?: NonNullable<Json>;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          capacity?: number;
          id?: string;
          is_available?: boolean;
          last_heartbeat_at?: string | null;
          organization_id?: string;
          schedule?: NonNullable<Json>;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "attendant_availability_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      automation_rodizio_atribuicoes: {
        Row: {
          created_at: string;
          event_id: string | null;
          id: string;
          lead_id: string | null;
          member_position: number;
          organization_id: string;
          rule_id: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          event_id?: string | null;
          id?: string;
          lead_id?: string | null;
          member_position: number;
          organization_id: string;
          rule_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          event_id?: string | null;
          id?: string;
          lead_id?: string | null;
          member_position?: number;
          organization_id?: string;
          rule_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "automation_rodizio_atribuicoes_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "crm_leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "automation_rodizio_atribuicoes_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "automation_rodizio_atribuicoes_rule_id_fkey";
            columns: ["rule_id"];
            isOneToOne: false;
            referencedRelation: "automation_rules";
            referencedColumns: ["id"];
          },
        ];
      };
      automation_rule_runs: {
        Row: {
          actions_result: NonNullable<Json>;
          created_at: string;
          error: string | null;
          event_id: string | null;
          id: string;
          organization_id: string;
          rule_id: string;
          status: string;
        };
        ComputedFields: never;
        Insert: {
          actions_result?: NonNullable<Json>;
          created_at?: string;
          error?: string | null;
          event_id?: string | null;
          id?: string;
          organization_id: string;
          rule_id: string;
          status: string;
        };
        Update: {
          actions_result?: NonNullable<Json>;
          created_at?: string;
          error?: string | null;
          event_id?: string | null;
          id?: string;
          organization_id?: string;
          rule_id?: string;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "automation_rule_runs_event_id_fkey";
            columns: ["event_id"];
            isOneToOne: false;
            referencedRelation: "event_log";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "automation_rule_runs_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "automation_rule_runs_rule_id_fkey";
            columns: ["rule_id"];
            isOneToOne: false;
            referencedRelation: "automation_rules";
            referencedColumns: ["id"];
          },
        ];
      };
      automation_rules: {
        Row: {
          actions: NonNullable<Json>;
          conditions: NonNullable<Json>;
          created_at: string;
          created_by_user_id: string | null;
          id: string;
          is_active: boolean;
          last_change_actor_kind: string | null;
          last_change_at: string | null;
          last_run_at: string | null;
          name: string;
          organization_id: string;
          run_count: number;
          trigger_config: NonNullable<Json>;
          trigger_event: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          actions?: NonNullable<Json>;
          conditions?: NonNullable<Json>;
          created_at?: string;
          created_by_user_id?: string | null;
          id?: string;
          is_active?: boolean;
          last_change_actor_kind?: string | null;
          last_change_at?: string | null;
          last_run_at?: string | null;
          name: string;
          organization_id: string;
          run_count?: number;
          trigger_config?: NonNullable<Json>;
          trigger_event: string;
          updated_at?: string;
        };
        Update: {
          actions?: NonNullable<Json>;
          conditions?: NonNullable<Json>;
          created_at?: string;
          created_by_user_id?: string | null;
          id?: string;
          is_active?: boolean;
          last_change_actor_kind?: string | null;
          last_change_at?: string | null;
          last_run_at?: string | null;
          name?: string;
          organization_id?: string;
          run_count?: number;
          trigger_config?: NonNullable<Json>;
          trigger_event?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "automation_rules_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      before_send_traces: {
        Row: {
          channel_session_id: string;
          contact_id: string | null;
          created_at: string;
          id: string;
          job_id: string;
          organization_id: string;
          tipo_envio: string | null;
          trace: NonNullable<Json>;
          vetoed_code: string | null;
          vetoed_gate: string | null;
        };
        ComputedFields: never;
        Insert: {
          channel_session_id: string;
          contact_id?: string | null;
          created_at?: string;
          id?: string;
          job_id: string;
          organization_id: string;
          tipo_envio?: string | null;
          trace: NonNullable<Json>;
          vetoed_code?: string | null;
          vetoed_gate?: string | null;
        };
        Update: {
          channel_session_id?: string;
          contact_id?: string | null;
          created_at?: string;
          id?: string;
          job_id?: string;
          organization_id?: string;
          tipo_envio?: string | null;
          trace?: NonNullable<Json>;
          vetoed_code?: string | null;
          vetoed_gate?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "before_send_traces_channel_session_id_fkey";
            columns: ["channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "before_send_traces_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "before_send_traces_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "job_queue";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "before_send_traces_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      calendar_appointments: {
        Row: {
          cancellation_reason: string | null;
          cancelled_at: string | null;
          confirmation_next_at: string | null;
          contact_id: string | null;
          conversation_id: string | null;
          created_at: string;
          created_by_agent_id: string | null;
          created_by_kind: string;
          created_by_user_id: string | null;
          description: string | null;
          ends_at: string;
          event_type_id: string | null;
          google_base_projection: Json | null;
          google_calendar_id: string | null;
          google_claim_epoch: number;
          google_claim_token: string | null;
          google_claim_until: string | null;
          google_conflict: Json | null;
          google_connection_id: string | null;
          google_etag: string | null;
          google_event_id: string | null;
          google_ical_uid: string | null;
          google_local_revision: number;
          google_next_attempt_at: string;
          google_pending_write: Json | null;
          google_sequence: number;
          google_sync_error: string | null;
          google_synced_at: string | null;
          google_synced_local_revision: number;
          guest_email: string | null;
          id: string;
          location_details: string | null;
          location_kind: string;
          meeting_attempts: number;
          meeting_delivery: NonNullable<Json>;
          meeting_delivery_job_id: string | null;
          meeting_last_error: string | null;
          meeting_next_attempt_at: string | null;
          meeting_ready_at: string | null;
          meeting_received_at: string | null;
          meeting_request_id: string | null;
          meeting_requested_at: string | null;
          meeting_state: string;
          meeting_url: string | null;
          needs_google_push: boolean | null;
          notes: string | null;
          organization_id: string;
          outcome_message_id: string | null;
          outcome_recorded_at: string | null;
          outcome_source_kind: string | null;
          outcome_user_id: string | null;
          owner_user_id: string | null;
          participant_key: string | null;
          participant_name: string | null;
          reminder_sent_at: string | null;
          reminder_sent_offsets_minutes: number[];
          rescheduled_from_id: string | null;
          revision: number;
          revision_started_at: string;
          service_block: boolean;
          service_booking_mode: string | null;
          service_capacity_limit: number | null;
          service_capacity_rule: string | null;
          service_confirmed_at: string | null;
          service_confirmed_by_user_id: string | null;
          service_destination_calendar_id: string | null;
          service_occurrence_id: string | null;
          service_operation_key: string | null;
          service_operation_request: Json | null;
          service_publication_mode: string | null;
          service_requires_confirmation: boolean | null;
          service_rule_revision: number | null;
          source: string;
          starts_at: string;
          starts_at_marked_at: string | null;
          status: string;
          time_zone: string;
          title: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          cancellation_reason?: string | null;
          cancelled_at?: string | null;
          confirmation_next_at?: string | null;
          contact_id?: string | null;
          conversation_id?: string | null;
          created_at?: string;
          created_by_agent_id?: string | null;
          created_by_kind?: string;
          created_by_user_id?: string | null;
          description?: string | null;
          ends_at: string;
          event_type_id?: string | null;
          google_base_projection?: Json | null;
          google_calendar_id?: string | null;
          google_claim_epoch?: number;
          google_claim_token?: string | null;
          google_claim_until?: string | null;
          google_conflict?: Json | null;
          google_connection_id?: string | null;
          google_etag?: string | null;
          google_event_id?: string | null;
          google_ical_uid?: string | null;
          google_local_revision?: number;
          google_next_attempt_at?: string;
          google_pending_write?: Json | null;
          google_sequence?: number;
          google_sync_error?: string | null;
          google_synced_at?: string | null;
          google_synced_local_revision?: number;
          guest_email?: string | null;
          id?: string;
          location_details?: string | null;
          location_kind?: string;
          meeting_attempts?: number;
          meeting_delivery?: NonNullable<Json>;
          meeting_delivery_job_id?: string | null;
          meeting_last_error?: string | null;
          meeting_next_attempt_at?: string | null;
          meeting_ready_at?: string | null;
          meeting_received_at?: string | null;
          meeting_request_id?: string | null;
          meeting_requested_at?: string | null;
          meeting_state?: string;
          meeting_url?: string | null;
          needs_google_push?: never;
          notes?: string | null;
          organization_id: string;
          outcome_message_id?: string | null;
          outcome_recorded_at?: string | null;
          outcome_source_kind?: string | null;
          outcome_user_id?: string | null;
          owner_user_id?: string | null;
          participant_key?: string | null;
          participant_name?: string | null;
          reminder_sent_at?: string | null;
          reminder_sent_offsets_minutes?: number[];
          rescheduled_from_id?: string | null;
          revision?: number;
          revision_started_at?: string;
          service_block?: boolean;
          service_booking_mode?: string | null;
          service_capacity_limit?: number | null;
          service_capacity_rule?: string | null;
          service_confirmed_at?: string | null;
          service_confirmed_by_user_id?: string | null;
          service_destination_calendar_id?: string | null;
          service_occurrence_id?: string | null;
          service_operation_key?: string | null;
          service_operation_request?: Json | null;
          service_publication_mode?: string | null;
          service_requires_confirmation?: boolean | null;
          service_rule_revision?: number | null;
          source?: string;
          starts_at: string;
          starts_at_marked_at?: string | null;
          status?: string;
          time_zone?: string;
          title: string;
          updated_at?: string;
        };
        Update: {
          cancellation_reason?: string | null;
          cancelled_at?: string | null;
          confirmation_next_at?: string | null;
          contact_id?: string | null;
          conversation_id?: string | null;
          created_at?: string;
          created_by_agent_id?: string | null;
          created_by_kind?: string;
          created_by_user_id?: string | null;
          description?: string | null;
          ends_at?: string;
          event_type_id?: string | null;
          google_base_projection?: Json | null;
          google_calendar_id?: string | null;
          google_claim_epoch?: number;
          google_claim_token?: string | null;
          google_claim_until?: string | null;
          google_conflict?: Json | null;
          google_connection_id?: string | null;
          google_etag?: string | null;
          google_event_id?: string | null;
          google_ical_uid?: string | null;
          google_local_revision?: number;
          google_next_attempt_at?: string;
          google_pending_write?: Json | null;
          google_sequence?: number;
          google_sync_error?: string | null;
          google_synced_at?: string | null;
          google_synced_local_revision?: number;
          guest_email?: string | null;
          id?: string;
          location_details?: string | null;
          location_kind?: string;
          meeting_attempts?: number;
          meeting_delivery?: NonNullable<Json>;
          meeting_delivery_job_id?: string | null;
          meeting_last_error?: string | null;
          meeting_next_attempt_at?: string | null;
          meeting_ready_at?: string | null;
          meeting_received_at?: string | null;
          meeting_request_id?: string | null;
          meeting_requested_at?: string | null;
          meeting_state?: string;
          meeting_url?: string | null;
          needs_google_push?: never;
          notes?: string | null;
          organization_id?: string;
          outcome_message_id?: string | null;
          outcome_recorded_at?: string | null;
          outcome_source_kind?: string | null;
          outcome_user_id?: string | null;
          owner_user_id?: string | null;
          participant_key?: string | null;
          participant_name?: string | null;
          reminder_sent_at?: string | null;
          reminder_sent_offsets_minutes?: number[];
          rescheduled_from_id?: string | null;
          revision?: number;
          revision_started_at?: string;
          service_block?: boolean;
          service_booking_mode?: string | null;
          service_capacity_limit?: number | null;
          service_capacity_rule?: string | null;
          service_confirmed_at?: string | null;
          service_confirmed_by_user_id?: string | null;
          service_destination_calendar_id?: string | null;
          service_occurrence_id?: string | null;
          service_operation_key?: string | null;
          service_operation_request?: Json | null;
          service_publication_mode?: string | null;
          service_requires_confirmation?: boolean | null;
          service_rule_revision?: number | null;
          source?: string;
          starts_at?: string;
          starts_at_marked_at?: string | null;
          status?: string;
          time_zone?: string;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "calendar_appointments_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_appointments_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_appointments_created_by_agent_id_fkey";
            columns: ["created_by_agent_id"];
            isOneToOne: false;
            referencedRelation: "ai_agents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_appointments_event_type_id_fkey";
            columns: ["event_type_id"];
            isOneToOne: false;
            referencedRelation: "calendar_event_types";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_appointments_google_connection_id_fkey";
            columns: ["google_connection_id"];
            isOneToOne: false;
            referencedRelation: "calendar_connections";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_appointments_meeting_delivery_job_id_fkey";
            columns: ["meeting_delivery_job_id"];
            isOneToOne: false;
            referencedRelation: "job_queue";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_appointments_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_appointments_outcome_message_id_fkey";
            columns: ["outcome_message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_appointments_rescheduled_from_id_fkey";
            columns: ["rescheduled_from_id"];
            isOneToOne: false;
            referencedRelation: "calendar_appointments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_appointments_rescheduled_from_id_fkey";
            columns: ["rescheduled_from_id"];
            isOneToOne: false;
            referencedRelation: "calendar_google_reconcilable_appointments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_appointments_rescheduled_from_id_fkey";
            columns: ["rescheduled_from_id"];
            isOneToOne: false;
            referencedRelation: "calendar_service_google_candidates";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_service_appointment_destination_fk";
            columns: ["organization_id", "service_destination_calendar_id"];
            isOneToOne: false;
            referencedRelation: "calendar_connection_calendars";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "calendar_service_occurrence_fk";
            columns: ["organization_id", "service_occurrence_id"];
            isOneToOne: false;
            referencedRelation: "calendar_service_occurrences";
            referencedColumns: ["organization_id", "id"];
          },
        ];
      };
      calendar_availability_exceptions: {
        Row: {
          created_at: string;
          end_minute: number;
          exception_date: string;
          id: string;
          is_unavailable: boolean;
          organization_id: string;
          reason: string | null;
          start_minute: number;
          updated_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          end_minute?: number;
          exception_date: string;
          id?: string;
          is_unavailable?: boolean;
          organization_id: string;
          reason?: string | null;
          start_minute?: number;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          end_minute?: number;
          exception_date?: string;
          id?: string;
          is_unavailable?: boolean;
          organization_id?: string;
          reason?: string | null;
          start_minute?: number;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "calendar_availability_exceptions_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      calendar_connection_calendars: {
        Row: {
          access_role: string | null;
          allowed_conference_types: string[] | null;
          available: boolean;
          catalog_checked_at: string | null;
          connection_id: string;
          counts_for_conflicts: boolean;
          created_at: string;
          external_calendar_id: string;
          id: string;
          is_destination: boolean;
          is_primary: boolean;
          last_sync_at: string | null;
          name: string;
          organization_id: string;
          sync_claim_epoch: number;
          sync_claim_token: string | null;
          sync_claim_until: string | null;
          sync_coverage: Json | null;
          sync_cursor: Json | null;
          sync_error: string | null;
          sync_next_attempt_at: string;
          sync_token: string | null;
          time_zone: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          access_role?: string | null;
          allowed_conference_types?: string[] | null;
          available?: boolean;
          catalog_checked_at?: string | null;
          connection_id: string;
          counts_for_conflicts?: boolean;
          created_at?: string;
          external_calendar_id: string;
          id?: string;
          is_destination?: boolean;
          is_primary?: boolean;
          last_sync_at?: string | null;
          name: string;
          organization_id: string;
          sync_claim_epoch?: number;
          sync_claim_token?: string | null;
          sync_claim_until?: string | null;
          sync_coverage?: Json | null;
          sync_cursor?: Json | null;
          sync_error?: string | null;
          sync_next_attempt_at?: string;
          sync_token?: string | null;
          time_zone?: string | null;
          updated_at?: string;
        };
        Update: {
          access_role?: string | null;
          allowed_conference_types?: string[] | null;
          available?: boolean;
          catalog_checked_at?: string | null;
          connection_id?: string;
          counts_for_conflicts?: boolean;
          created_at?: string;
          external_calendar_id?: string;
          id?: string;
          is_destination?: boolean;
          is_primary?: boolean;
          last_sync_at?: string | null;
          name?: string;
          organization_id?: string;
          sync_claim_epoch?: number;
          sync_claim_token?: string | null;
          sync_claim_until?: string | null;
          sync_coverage?: Json | null;
          sync_cursor?: Json | null;
          sync_error?: string | null;
          sync_next_attempt_at?: string;
          sync_token?: string | null;
          time_zone?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "calendar_connection_calendars_connection_id_fkey";
            columns: ["connection_id"];
            isOneToOne: false;
            referencedRelation: "calendar_connections";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_connection_calendars_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      calendar_connections: {
        Row: {
          account_email: string;
          calendar_selection_revision: number;
          catalog_retry_at: string | null;
          created_at: string;
          id: string;
          last_sync_at: string | null;
          last_sync_error: string | null;
          oauth_access_token_encrypted: string | null;
          oauth_refresh_token_encrypted: string | null;
          organization_id: string;
          provider: string;
          scopes: string[];
          status: string;
          sync_token: string | null;
          token_expires_at: string | null;
          updated_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          account_email: string;
          calendar_selection_revision?: number;
          catalog_retry_at?: string | null;
          created_at?: string;
          id?: string;
          last_sync_at?: string | null;
          last_sync_error?: string | null;
          oauth_access_token_encrypted?: string | null;
          oauth_refresh_token_encrypted?: string | null;
          organization_id: string;
          provider?: string;
          scopes?: string[];
          status?: string;
          sync_token?: string | null;
          token_expires_at?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          account_email?: string;
          calendar_selection_revision?: number;
          catalog_retry_at?: string | null;
          created_at?: string;
          id?: string;
          last_sync_at?: string | null;
          last_sync_error?: string | null;
          oauth_access_token_encrypted?: string | null;
          oauth_refresh_token_encrypted?: string | null;
          organization_id?: string;
          provider?: string;
          scopes?: string[];
          status?: string;
          sync_token?: string | null;
          token_expires_at?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "calendar_connections_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      calendar_event_types: {
        Row: {
          booking_mode: string;
          booking_window_days: number;
          buffer_after_minutes: number;
          buffer_before_minutes: number;
          category: string;
          created_at: string;
          default_owner_user_id: string | null;
          default_price_cents: number | null;
          description: string | null;
          destination_calendar_id: string | null;
          duration_minutes: number;
          id: string;
          is_active: boolean;
          location_details: string | null;
          location_kind: string;
          minimum_notice_minutes: number;
          name: string;
          organization_id: string;
          position: number;
          reminder_bodies: NonNullable<Json>;
          reminder_body: string | null;
          reminder_channel_session_id: string | null;
          reminder_enabled: boolean;
          reminder_extra_offsets_minutes: number[];
          reminder_minutes_before: number;
          reminder_template_name: string | null;
          requires_confirmation: boolean;
          service_capacity: number | null;
          service_enabled: boolean;
          service_publication_mode: string;
          service_revision: number;
          service_timezone: string;
          slot_interval_minutes: number | null;
          slug: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          booking_mode?: string;
          booking_window_days?: number;
          buffer_after_minutes?: number;
          buffer_before_minutes?: number;
          category?: string;
          created_at?: string;
          default_owner_user_id?: string | null;
          default_price_cents?: number | null;
          description?: string | null;
          destination_calendar_id?: string | null;
          duration_minutes?: number;
          id?: string;
          is_active?: boolean;
          location_details?: string | null;
          location_kind?: string;
          minimum_notice_minutes?: number;
          name: string;
          organization_id: string;
          position?: number;
          reminder_bodies?: NonNullable<Json>;
          reminder_body?: string | null;
          reminder_channel_session_id?: string | null;
          reminder_enabled?: boolean;
          reminder_extra_offsets_minutes?: number[];
          reminder_minutes_before?: number;
          reminder_template_name?: string | null;
          requires_confirmation?: boolean;
          service_capacity?: number | null;
          service_enabled?: boolean;
          service_publication_mode?: string;
          service_revision?: number;
          service_timezone?: string;
          slot_interval_minutes?: number | null;
          slug: string;
          updated_at?: string;
        };
        Update: {
          booking_mode?: string;
          booking_window_days?: number;
          buffer_after_minutes?: number;
          buffer_before_minutes?: number;
          category?: string;
          created_at?: string;
          default_owner_user_id?: string | null;
          default_price_cents?: number | null;
          description?: string | null;
          destination_calendar_id?: string | null;
          duration_minutes?: number;
          id?: string;
          is_active?: boolean;
          location_details?: string | null;
          location_kind?: string;
          minimum_notice_minutes?: number;
          name?: string;
          organization_id?: string;
          position?: number;
          reminder_bodies?: NonNullable<Json>;
          reminder_body?: string | null;
          reminder_channel_session_id?: string | null;
          reminder_enabled?: boolean;
          reminder_extra_offsets_minutes?: number[];
          reminder_minutes_before?: number;
          reminder_template_name?: string | null;
          requires_confirmation?: boolean;
          service_capacity?: number | null;
          service_enabled?: boolean;
          service_publication_mode?: string;
          service_revision?: number;
          service_timezone?: string;
          slot_interval_minutes?: number | null;
          slug?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "calendar_event_types_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_event_types_reminder_channel_org_fkey";
            columns: ["organization_id", "reminder_channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "calendar_service_destination_fk";
            columns: ["organization_id", "destination_calendar_id"];
            isOneToOne: false;
            referencedRelation: "calendar_connection_calendars";
            referencedColumns: ["organization_id", "id"];
          },
        ];
      };
      calendar_external_events: {
        Row: {
          connection_id: string;
          created_at: string;
          ends_at: string | null;
          external_calendar_id: string;
          external_event_id: string;
          external_updated_at: string | null;
          ical_uid: string | null;
          id: string;
          is_all_day: boolean;
          organization_id: string;
          original_start_time: Json | null;
          recurring_event_id: string | null;
          seen_generation: string | null;
          starts_at: string | null;
          status: string;
          title: string | null;
          transparency: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          connection_id: string;
          created_at?: string;
          ends_at?: string | null;
          external_calendar_id: string;
          external_event_id: string;
          external_updated_at?: string | null;
          ical_uid?: string | null;
          id?: string;
          is_all_day?: boolean;
          organization_id: string;
          original_start_time?: Json | null;
          recurring_event_id?: string | null;
          seen_generation?: string | null;
          starts_at?: string | null;
          status?: string;
          title?: string | null;
          transparency?: string;
          updated_at?: string;
        };
        Update: {
          connection_id?: string;
          created_at?: string;
          ends_at?: string | null;
          external_calendar_id?: string;
          external_event_id?: string;
          external_updated_at?: string | null;
          ical_uid?: string | null;
          id?: string;
          is_all_day?: boolean;
          organization_id?: string;
          original_start_time?: Json | null;
          recurring_event_id?: string | null;
          seen_generation?: string | null;
          starts_at?: string | null;
          status?: string;
          title?: string | null;
          transparency?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "calendar_external_events_connection_id_fkey";
            columns: ["connection_id"];
            isOneToOne: false;
            referencedRelation: "calendar_connections";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_external_events_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      calendar_locations: {
        Row: {
          address: string;
          created_at: string;
          created_by: string | null;
          id: string;
          organization_id: string;
        };
        ComputedFields: never;
        Insert: {
          address: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          organization_id: string;
        };
        Update: {
          address?: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          organization_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "calendar_locations_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      calendar_oauth_nonces: {
        Row: {
          expira_em: string;
          nonce: string;
          organization_id: string;
          usado_em: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          expira_em: string;
          nonce: string;
          organization_id: string;
          usado_em?: string;
          user_id: string;
        };
        Update: {
          expira_em?: string;
          nonce?: string;
          organization_id?: string;
          usado_em?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "calendar_oauth_nonces_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      calendar_resources: {
        Row: {
          capacity: number;
          created_at: string;
          id: string;
          is_active: boolean;
          name: string;
          organization_id: string;
          revision: number;
        };
        ComputedFields: never;
        Insert: {
          capacity?: number;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          name: string;
          organization_id: string;
          revision?: number;
        };
        Update: {
          capacity?: number;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          name?: string;
          organization_id?: string;
          revision?: number;
        };
        Relationships: [
          {
            foreignKeyName: "calendar_resources_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      calendar_service_blocks: {
        Row: {
          archived_at: string | null;
          created_at: string;
          ends_at: string;
          event_type_id: string | null;
          id: string;
          operation_key: string;
          organization_id: string;
          owner_user_id: string | null;
          publication_appointment_id: string | null;
          reason: string;
          resource_id: string | null;
          revision: number;
          scope_kind: string;
          starts_at: string;
        };
        ComputedFields: never;
        Insert: {
          archived_at?: string | null;
          created_at?: string;
          ends_at: string;
          event_type_id?: string | null;
          id?: string;
          operation_key: string;
          organization_id: string;
          owner_user_id?: string | null;
          publication_appointment_id?: string | null;
          reason: string;
          resource_id?: string | null;
          revision?: number;
          scope_kind: string;
          starts_at: string;
        };
        Update: {
          archived_at?: string | null;
          created_at?: string;
          ends_at?: string;
          event_type_id?: string | null;
          id?: string;
          operation_key?: string;
          organization_id?: string;
          owner_user_id?: string | null;
          publication_appointment_id?: string | null;
          reason?: string;
          resource_id?: string | null;
          revision?: number;
          scope_kind?: string;
          starts_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "calendar_service_block_owner_member_fk";
            columns: ["organization_id", "owner_user_id"];
            isOneToOne: false;
            referencedRelation: "user_organizations";
            referencedColumns: ["organization_id", "user_id"];
          },
          {
            foreignKeyName: "calendar_service_block_publication_org_fk";
            columns: ["organization_id", "publication_appointment_id"];
            isOneToOne: false;
            referencedRelation: "calendar_appointments";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "calendar_service_block_publication_org_fk";
            columns: ["organization_id", "publication_appointment_id"];
            isOneToOne: false;
            referencedRelation: "calendar_google_reconcilable_appointments";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "calendar_service_block_publication_org_fk";
            columns: ["organization_id", "publication_appointment_id"];
            isOneToOne: false;
            referencedRelation: "calendar_service_google_candidates";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "calendar_service_blocks_organization_id_event_type_id_fkey";
            columns: ["organization_id", "event_type_id"];
            isOneToOne: false;
            referencedRelation: "calendar_event_types";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "calendar_service_blocks_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_service_blocks_organization_id_resource_id_fkey";
            columns: ["organization_id", "resource_id"];
            isOneToOne: false;
            referencedRelation: "calendar_resources";
            referencedColumns: ["organization_id", "id"];
          },
        ];
      };
      calendar_service_calendar_sources: {
        Row: {
          calendar_id: string;
          event_type_id: string;
          organization_id: string;
        };
        ComputedFields: never;
        Insert: {
          calendar_id: string;
          event_type_id: string;
          organization_id: string;
        };
        Update: {
          calendar_id?: string;
          event_type_id?: string;
          organization_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "calendar_service_calendar_sou_organization_id_event_type_i_fkey";
            columns: ["organization_id", "event_type_id"];
            isOneToOne: false;
            referencedRelation: "calendar_event_types";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "calendar_service_calendar_sour_organization_id_calendar_id_fkey";
            columns: ["organization_id", "calendar_id"];
            isOneToOne: false;
            referencedRelation: "calendar_connection_calendars";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "calendar_service_calendar_sources_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      calendar_service_occurrence_resources: {
        Row: {
          occurrence_id: string;
          organization_id: string;
          resource_id: string;
          units: number;
        };
        ComputedFields: never;
        Insert: {
          occurrence_id: string;
          organization_id: string;
          resource_id: string;
          units: number;
        };
        Update: {
          occurrence_id?: string;
          organization_id?: string;
          resource_id?: string;
          units?: number;
        };
        Relationships: [
          {
            foreignKeyName: "calendar_service_occurrence_r_organization_id_occurrence_i_fkey";
            columns: ["organization_id", "occurrence_id"];
            isOneToOne: false;
            referencedRelation: "calendar_service_occurrences";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "calendar_service_occurrence_re_organization_id_resource_id_fkey";
            columns: ["organization_id", "resource_id"];
            isOneToOne: false;
            referencedRelation: "calendar_resources";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "calendar_service_occurrence_resources_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      calendar_service_occurrences: {
        Row: {
          allocation_key: string;
          booking_mode: string;
          created_at: string;
          ends_at: string;
          event_type_id: string;
          id: string;
          organization_id: string;
          starts_at: string;
        };
        ComputedFields: never;
        Insert: {
          allocation_key?: string;
          booking_mode: string;
          created_at?: string;
          ends_at: string;
          event_type_id: string;
          id?: string;
          organization_id: string;
          starts_at: string;
        };
        Update: {
          allocation_key?: string;
          booking_mode?: string;
          created_at?: string;
          ends_at?: string;
          event_type_id?: string;
          id?: string;
          organization_id?: string;
          starts_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "calendar_service_occurrences_organization_id_event_type_id_fkey";
            columns: ["organization_id", "event_type_id"];
            isOneToOne: false;
            referencedRelation: "calendar_event_types";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "calendar_service_occurrences_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      calendar_service_professionals: {
        Row: {
          event_type_id: string;
          organization_id: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          event_type_id: string;
          organization_id: string;
          user_id: string;
        };
        Update: {
          event_type_id?: string;
          organization_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "calendar_service_professional_member_fk";
            columns: ["organization_id", "user_id"];
            isOneToOne: false;
            referencedRelation: "user_organizations";
            referencedColumns: ["organization_id", "user_id"];
          },
          {
            foreignKeyName: "calendar_service_professional_organization_id_event_type_i_fkey";
            columns: ["organization_id", "event_type_id"];
            isOneToOne: false;
            referencedRelation: "calendar_event_types";
            referencedColumns: ["organization_id", "id"];
          },
        ];
      };
      calendar_service_resources: {
        Row: {
          event_type_id: string;
          organization_id: string;
          resource_id: string;
          units: number;
        };
        ComputedFields: never;
        Insert: {
          event_type_id: string;
          organization_id: string;
          resource_id: string;
          units?: number;
        };
        Update: {
          event_type_id?: string;
          organization_id?: string;
          resource_id?: string;
          units?: number;
        };
        Relationships: [
          {
            foreignKeyName: "calendar_service_resources_organization_id_event_type_id_fkey";
            columns: ["organization_id", "event_type_id"];
            isOneToOne: false;
            referencedRelation: "calendar_event_types";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "calendar_service_resources_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_service_resources_organization_id_resource_id_fkey";
            columns: ["organization_id", "resource_id"];
            isOneToOne: false;
            referencedRelation: "calendar_resources";
            referencedColumns: ["organization_id", "id"];
          },
        ];
      };
      calendar_service_schedule: {
        Row: {
          capacity_limit: number | null;
          capacity_rule: string;
          created_at: string;
          duration_minutes: number | null;
          end_minute: number | null;
          event_type_id: string;
          id: string;
          on_date: string | null;
          organization_id: string;
          start_minute: number;
          timing_kind: string;
          weekday: number | null;
        };
        ComputedFields: never;
        Insert: {
          capacity_limit?: number | null;
          capacity_rule?: string;
          created_at?: string;
          duration_minutes?: number | null;
          end_minute?: number | null;
          event_type_id: string;
          id?: string;
          on_date?: string | null;
          organization_id: string;
          start_minute: number;
          timing_kind: string;
          weekday?: number | null;
        };
        Update: {
          capacity_limit?: number | null;
          capacity_rule?: string;
          created_at?: string;
          duration_minutes?: number | null;
          end_minute?: number | null;
          event_type_id?: string;
          id?: string;
          on_date?: string | null;
          organization_id?: string;
          start_minute?: number;
          timing_kind?: string;
          weekday?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "calendar_service_schedule_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_service_schedule_type_fk";
            columns: ["organization_id", "event_type_id"];
            isOneToOne: false;
            referencedRelation: "calendar_event_types";
            referencedColumns: ["organization_id", "id"];
          },
        ];
      };
      campaign_channel_sessions: {
        Row: {
          campaign_id: string;
          channel_session_id: string;
          created_at: string;
          id: string;
          organization_id: string;
        };
        ComputedFields: never;
        Insert: {
          campaign_id: string;
          channel_session_id: string;
          created_at?: string;
          id?: string;
          organization_id: string;
        };
        Update: {
          campaign_id?: string;
          channel_session_id?: string;
          created_at?: string;
          id?: string;
          organization_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "campaign_channel_sessions_campaign_id_fkey";
            columns: ["campaign_id"];
            isOneToOne: false;
            referencedRelation: "campaigns";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_channel_sessions_org_fk";
            columns: ["organization_id", "channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "campaign_channel_sessions_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      campaign_recipients: {
        Row: {
          attempt_count: number;
          campaign_id: string;
          cancelled_at: string | null;
          channel_session_id: string | null;
          contact_id: string;
          content_version: number;
          conversation_id: string | null;
          created_at: string;
          delivered_at: string | null;
          eligibility_status: string;
          exclusion_reason: string | null;
          id: string;
          last_attempt_at: string | null;
          last_error_code: string | null;
          last_error_detail: string | null;
          message_id: string | null;
          next_attempt_at: string | null;
          opted_out_at: string | null;
          organization_id: string;
          queued_at: string | null;
          read_at: string | null;
          recipient_address: string | null;
          rendered_body: string | null;
          replied_at: string | null;
          sending_at: string | null;
          sent_at: string | null;
          status: string;
          updated_at: string;
          variables: NonNullable<Json>;
        };
        ComputedFields: never;
        Insert: {
          attempt_count?: number;
          campaign_id: string;
          cancelled_at?: string | null;
          channel_session_id?: string | null;
          contact_id: string;
          content_version?: number;
          conversation_id?: string | null;
          created_at?: string;
          delivered_at?: string | null;
          eligibility_status?: string;
          exclusion_reason?: string | null;
          id?: string;
          last_attempt_at?: string | null;
          last_error_code?: string | null;
          last_error_detail?: string | null;
          message_id?: string | null;
          next_attempt_at?: string | null;
          opted_out_at?: string | null;
          organization_id: string;
          queued_at?: string | null;
          read_at?: string | null;
          recipient_address?: string | null;
          rendered_body?: string | null;
          replied_at?: string | null;
          sending_at?: string | null;
          sent_at?: string | null;
          status?: string;
          updated_at?: string;
          variables?: NonNullable<Json>;
        };
        Update: {
          attempt_count?: number;
          campaign_id?: string;
          cancelled_at?: string | null;
          channel_session_id?: string | null;
          contact_id?: string;
          content_version?: number;
          conversation_id?: string | null;
          created_at?: string;
          delivered_at?: string | null;
          eligibility_status?: string;
          exclusion_reason?: string | null;
          id?: string;
          last_attempt_at?: string | null;
          last_error_code?: string | null;
          last_error_detail?: string | null;
          message_id?: string | null;
          next_attempt_at?: string | null;
          opted_out_at?: string | null;
          organization_id?: string;
          queued_at?: string | null;
          read_at?: string | null;
          recipient_address?: string | null;
          rendered_body?: string | null;
          replied_at?: string | null;
          sending_at?: string | null;
          sent_at?: string | null;
          status?: string;
          updated_at?: string;
          variables?: NonNullable<Json>;
        };
        Relationships: [
          {
            foreignKeyName: "campaign_recipients_campaign_id_fkey";
            columns: ["campaign_id"];
            isOneToOne: false;
            referencedRelation: "campaigns";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_recipients_channel_org_fk";
            columns: ["organization_id", "channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "campaign_recipients_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_recipients_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_recipients_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_recipients_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      campaign_suppressions: {
        Row: {
          address_tail: string | null;
          contact_id: string | null;
          created_at: string;
          created_by: string | null;
          id: string;
          organization_id: string;
          reason: string | null;
          recipient_address_hash: string;
          source: string;
        };
        ComputedFields: never;
        Insert: {
          address_tail?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          organization_id: string;
          reason?: string | null;
          recipient_address_hash: string;
          source?: string;
        };
        Update: {
          address_tail?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          organization_id?: string;
          reason?: string | null;
          recipient_address_hash?: string;
          source?: string;
        };
        Relationships: [
          {
            foreignKeyName: "campaign_suppressions_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_suppressions_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      campaign_templates: {
        Row: {
          body: string;
          created_at: string;
          created_by: string | null;
          id: string;
          name: string;
          organization_id: string;
          updated_at: string;
          updated_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          body: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          name: string;
          organization_id: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          body?: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          name?: string;
          organization_id?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "campaign_templates_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      campaigns: {
        Row: {
          agent_id: string | null;
          audience_filter: NonNullable<Json>;
          audience_version: number;
          base_legal: string;
          cancelled_at: string | null;
          channel_session_id: string;
          completed_at: string | null;
          content_version: number;
          created_at: string;
          created_by: string | null;
          description: string | null;
          failed_at: string | null;
          failure_code: string | null;
          failure_detail: string | null;
          id: string;
          intervalo_segundos: number | null;
          janela_fim_hora: number | null;
          janela_inicio_hora: number | null;
          lia_ref: string | null;
          message_body: string | null;
          message_mode: string;
          name: string;
          organization_id: string;
          paused_at: string | null;
          pipeline_id: string | null;
          prepared_at: string | null;
          provider_template_language: string | null;
          provider_template_name: string | null;
          provider_template_variables: NonNullable<Json>;
          scheduled_at: string | null;
          snapshot_eligible: number;
          snapshot_excluded: number;
          snapshot_total: number;
          split_messages: boolean;
          stage_id: string | null;
          started_at: string | null;
          status: string;
          teto_diario: number | null;
          teto_horario: number | null;
          updated_at: string;
          updated_by: string | null;
          velocidade: string;
        };
        ComputedFields: never;
        Insert: {
          agent_id?: string | null;
          audience_filter?: NonNullable<Json>;
          audience_version?: number;
          base_legal: string;
          cancelled_at?: string | null;
          channel_session_id: string;
          completed_at?: string | null;
          content_version?: number;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          failed_at?: string | null;
          failure_code?: string | null;
          failure_detail?: string | null;
          id?: string;
          intervalo_segundos?: number | null;
          janela_fim_hora?: number | null;
          janela_inicio_hora?: number | null;
          lia_ref?: string | null;
          message_body?: string | null;
          message_mode?: string;
          name: string;
          organization_id: string;
          paused_at?: string | null;
          pipeline_id?: string | null;
          prepared_at?: string | null;
          provider_template_language?: string | null;
          provider_template_name?: string | null;
          provider_template_variables?: NonNullable<Json>;
          scheduled_at?: string | null;
          snapshot_eligible?: number;
          snapshot_excluded?: number;
          snapshot_total?: number;
          split_messages?: boolean;
          stage_id?: string | null;
          started_at?: string | null;
          status?: string;
          teto_diario?: number | null;
          teto_horario?: number | null;
          updated_at?: string;
          updated_by?: string | null;
          velocidade?: string;
        };
        Update: {
          agent_id?: string | null;
          audience_filter?: NonNullable<Json>;
          audience_version?: number;
          base_legal?: string;
          cancelled_at?: string | null;
          channel_session_id?: string;
          completed_at?: string | null;
          content_version?: number;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          failed_at?: string | null;
          failure_code?: string | null;
          failure_detail?: string | null;
          id?: string;
          intervalo_segundos?: number | null;
          janela_fim_hora?: number | null;
          janela_inicio_hora?: number | null;
          lia_ref?: string | null;
          message_body?: string | null;
          message_mode?: string;
          name?: string;
          organization_id?: string;
          paused_at?: string | null;
          pipeline_id?: string | null;
          prepared_at?: string | null;
          provider_template_language?: string | null;
          provider_template_name?: string | null;
          provider_template_variables?: NonNullable<Json>;
          scheduled_at?: string | null;
          snapshot_eligible?: number;
          snapshot_excluded?: number;
          snapshot_total?: number;
          split_messages?: boolean;
          stage_id?: string | null;
          started_at?: string | null;
          status?: string;
          teto_diario?: number | null;
          teto_horario?: number | null;
          updated_at?: string;
          updated_by?: string | null;
          velocidade?: string;
        };
        Relationships: [
          {
            foreignKeyName: "campaigns_agent_org_fk";
            columns: ["organization_id", "agent_id"];
            isOneToOne: false;
            referencedRelation: "ai_agents";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "campaigns_channel_org_fk";
            columns: ["organization_id", "channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "campaigns_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaigns_pipeline_org_fk";
            columns: ["organization_id", "pipeline_id"];
            isOneToOne: false;
            referencedRelation: "crm_pipelines";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "campaigns_stage_org_fk";
            columns: ["organization_id", "stage_id"];
            isOneToOne: false;
            referencedRelation: "crm_stages";
            referencedColumns: ["organization_id", "id"];
          },
        ];
      };
      catalog_products: {
        Row: {
          ativo: boolean;
          categoria: string | null;
          codigo: string;
          controla_estoque: boolean;
          created_at: string;
          custo_cents: number | null;
          descricao: string | null;
          fotos: string[];
          id: string;
          imagem_url: string | null;
          marca: string | null;
          moeda: string;
          nome: string;
          organization_id: string;
          origem: string;
          preco_cents: number;
          quantidade: number;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          ativo?: boolean;
          categoria?: string | null;
          codigo: string;
          controla_estoque?: boolean;
          created_at?: string;
          custo_cents?: number | null;
          descricao?: string | null;
          fotos?: string[];
          id?: string;
          imagem_url?: string | null;
          marca?: string | null;
          moeda?: string;
          nome: string;
          organization_id: string;
          origem?: string;
          preco_cents: number;
          quantidade?: number;
          updated_at?: string;
        };
        Update: {
          ativo?: boolean;
          categoria?: string | null;
          codigo?: string;
          controla_estoque?: boolean;
          created_at?: string;
          custo_cents?: number | null;
          descricao?: string | null;
          fotos?: string[];
          id?: string;
          imagem_url?: string | null;
          marca?: string | null;
          moeda?: string;
          nome?: string;
          organization_id?: string;
          origem?: string;
          preco_cents?: number;
          quantidade?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "catalog_products_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      channel_connection_requests: {
        Row: {
          channel_session_id: string | null;
          created_at: string;
          id: string;
          idempotency_key: string;
          lease_token: string;
          lease_until: string;
          organization_id: string;
          remote_created: boolean;
          request_hash: string;
          state: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          channel_session_id?: string | null;
          created_at?: string;
          id?: string;
          idempotency_key: string;
          lease_token?: string;
          lease_until?: string;
          organization_id: string;
          remote_created?: boolean;
          request_hash: string;
          state?: string;
          updated_at?: string;
        };
        Update: {
          channel_session_id?: string | null;
          created_at?: string;
          id?: string;
          idempotency_key?: string;
          lease_token?: string;
          lease_until?: string;
          organization_id?: string;
          remote_created?: boolean;
          request_hash?: string;
          state?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "channel_connection_requests_organization_id_channel_sessio_fkey";
            columns: ["organization_id", "channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "channel_connection_requests_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      channel_integrations: {
        Row: {
          created_at: string;
          credential_encrypted: string;
          organization_id: string;
          profile_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          credential_encrypted: string;
          organization_id: string;
          profile_id: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          credential_encrypted?: string;
          organization_id?: string;
          profile_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "channel_integrations_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: true;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      channel_knobs: {
        Row: {
          allow_sunday: boolean | null;
          atraso_maximo_ms: number | null;
          atraso_minimo_ms: number | null;
          atraso_notar_ms: number | null;
          channel_session_id: string;
          created_at: string;
          health_knobs: Json | null;
          jitter_max_ms: number | null;
          ms_por_caractere: number | null;
          number_activated_at: string;
          organization_id: string;
          prospeccao_dias: number[];
          resposta_end_hour: number | null;
          resposta_start_hour: number | null;
          spinning_knobs: Json | null;
          throttle_ms: number | null;
          timezone: string | null;
          updated_at: string;
          warmup_daily_caps: Json | null;
          window_end_hour: number | null;
          window_start_hour: number | null;
        };
        ComputedFields: never;
        Insert: {
          allow_sunday?: boolean | null;
          atraso_maximo_ms?: number | null;
          atraso_minimo_ms?: number | null;
          atraso_notar_ms?: number | null;
          channel_session_id: string;
          created_at?: string;
          health_knobs?: Json | null;
          jitter_max_ms?: number | null;
          ms_por_caractere?: number | null;
          number_activated_at?: string;
          organization_id: string;
          prospeccao_dias?: number[];
          resposta_end_hour?: number | null;
          resposta_start_hour?: number | null;
          spinning_knobs?: Json | null;
          throttle_ms?: number | null;
          timezone?: string | null;
          updated_at?: string;
          warmup_daily_caps?: Json | null;
          window_end_hour?: number | null;
          window_start_hour?: number | null;
        };
        Update: {
          allow_sunday?: boolean | null;
          atraso_maximo_ms?: number | null;
          atraso_minimo_ms?: number | null;
          atraso_notar_ms?: number | null;
          channel_session_id?: string;
          created_at?: string;
          health_knobs?: Json | null;
          jitter_max_ms?: number | null;
          ms_por_caractere?: number | null;
          number_activated_at?: string;
          organization_id?: string;
          prospeccao_dias?: number[];
          resposta_end_hour?: number | null;
          resposta_start_hour?: number | null;
          spinning_knobs?: Json | null;
          throttle_ms?: number | null;
          timezone?: string | null;
          updated_at?: string;
          warmup_daily_caps?: Json | null;
          window_end_hour?: number | null;
          window_start_hour?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "channel_knobs_channel_session_id_fkey";
            columns: ["channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "channel_knobs_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      channel_routing_policies: {
        Row: {
          channel_session_id: string;
          created_at: string;
          default_assignee_user_id: string | null;
          distribution_mode: string | null;
          id: string;
          organization_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          channel_session_id: string;
          created_at?: string;
          default_assignee_user_id?: string | null;
          distribution_mode?: string | null;
          id?: string;
          organization_id: string;
          updated_at?: string;
        };
        Update: {
          channel_session_id?: string;
          created_at?: string;
          default_assignee_user_id?: string | null;
          distribution_mode?: string | null;
          id?: string;
          organization_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "channel_routing_policies_default_assignee_fkey";
            columns: ["organization_id", "default_assignee_user_id"];
            isOneToOne: false;
            referencedRelation: "user_organizations";
            referencedColumns: ["organization_id", "user_id"];
          },
          {
            foreignKeyName: "channel_routing_policies_organization_id_channel_session_i_fkey";
            columns: ["organization_id", "channel_session_id"];
            isOneToOne: true;
            referencedRelation: "channel_sessions";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "channel_routing_policies_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      channel_routing_responsibles: {
        Row: {
          created_at: string;
          organization_id: string;
          policy_id: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          organization_id: string;
          policy_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          organization_id?: string;
          policy_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "channel_routing_responsibles_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "channel_routing_responsibles_organization_id_policy_id_fkey";
            columns: ["organization_id", "policy_id"];
            isOneToOne: false;
            referencedRelation: "channel_routing_policies";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "channel_routing_responsibles_organization_id_user_id_fkey";
            columns: ["organization_id", "user_id"];
            isOneToOne: false;
            referencedRelation: "user_organizations";
            referencedColumns: ["organization_id", "user_id"];
          },
        ];
      };
      channel_schedules: {
        Row: {
          channel_session_id: string | null;
          created_at: string;
          created_by: string | null;
          ends_at: string;
          id: string;
          organization_id: string;
          paused_channel_ids: NonNullable<Json>;
          starts_at: string;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          channel_session_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          ends_at: string;
          id?: string;
          organization_id: string;
          paused_channel_ids?: NonNullable<Json>;
          starts_at: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          channel_session_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          ends_at?: string;
          id?: string;
          organization_id?: string;
          paused_channel_ids?: NonNullable<Json>;
          starts_at?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "channel_schedules_channel_session_id_fkey";
            columns: ["channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "channel_schedules_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      channel_session_groups: {
        Row: {
          channel_session_id: string;
          contact_id: string | null;
          conversation_id: string | null;
          created_at: string;
          enabled: boolean;
          enabled_at: string | null;
          enabled_by_user_id: string | null;
          group_chat_id: string;
          ia_responde: boolean;
          id: string;
          organization_id: string;
          subject: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          channel_session_id: string;
          contact_id?: string | null;
          conversation_id?: string | null;
          created_at?: string;
          enabled?: boolean;
          enabled_at?: string | null;
          enabled_by_user_id?: string | null;
          group_chat_id: string;
          ia_responde?: boolean;
          id?: string;
          organization_id: string;
          subject?: string | null;
          updated_at?: string;
        };
        Update: {
          channel_session_id?: string;
          contact_id?: string | null;
          conversation_id?: string | null;
          created_at?: string;
          enabled?: boolean;
          enabled_at?: string | null;
          enabled_by_user_id?: string | null;
          group_chat_id?: string;
          ia_responde?: boolean;
          id?: string;
          organization_id?: string;
          subject?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "channel_session_groups_channel_session_id_fkey";
            columns: ["channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "channel_session_groups_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "channel_session_groups_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "channel_session_groups_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      channel_session_health: {
        Row: {
          channel_session_id: string;
          escalated_status: string | null;
          health_held_at: string | null;
          health_hold_active: boolean;
          health_hold_reason: string | null;
          health_released_at: string | null;
          id: string;
          organization_id: string;
          status: string;
          status_changed_at: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          channel_session_id: string;
          escalated_status?: string | null;
          health_held_at?: string | null;
          health_hold_active?: boolean;
          health_hold_reason?: string | null;
          health_released_at?: string | null;
          id?: string;
          organization_id: string;
          status: string;
          status_changed_at?: string;
          updated_at?: string;
        };
        Update: {
          channel_session_id?: string;
          escalated_status?: string | null;
          health_held_at?: string | null;
          health_hold_active?: boolean;
          health_hold_reason?: string | null;
          health_released_at?: string | null;
          id?: string;
          organization_id?: string;
          status?: string;
          status_changed_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "channel_session_health_channel_session_id_fkey";
            columns: ["channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "channel_session_health_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      channel_session_warmup: {
        Row: {
          channel_session_id: string;
          day: string;
          id: string;
          messages_received: number;
          messages_sent: number;
          organization_id: string;
          unique_contacts: number;
        };
        ComputedFields: never;
        Insert: {
          channel_session_id: string;
          day: string;
          id?: string;
          messages_received?: number;
          messages_sent?: number;
          organization_id: string;
          unique_contacts?: number;
        };
        Update: {
          channel_session_id?: string;
          day?: string;
          id?: string;
          messages_received?: number;
          messages_sent?: number;
          organization_id?: string;
          unique_contacts?: number;
        };
        Relationships: [
          {
            foreignKeyName: "channel_session_warmup_channel_session_id_fkey";
            columns: ["channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "channel_session_warmup_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      channel_sessions: {
        Row: {
          archived_at: string | null;
          consecutive_health_fails: number;
          created_at: string;
          created_by: string | null;
          daily_message_limit: number;
          datafy_phone_number_id: string | null;
          datafy_token_encrypted: string | null;
          datafy_waba_id: string | null;
          display_name: string | null;
          engine: string;
          id: string;
          is_warmup_complete: boolean | null;
          last_health_check_at: string | null;
          last_status_change_at: string;
          meta_phone_number_id: string | null;
          meta_token_encrypted: string | null;
          meta_waba_id: string | null;
          meta_webhook_override_em: string | null;
          meta_webhook_override_erro: string | null;
          meta_webhook_override_uri: string | null;
          metadata: NonNullable<Json>;
          organization_id: string;
          phone_number: string | null;
          provider: string;
          status: string;
          status_reason: string | null;
          updated_at: string;
          wacalls_jid: string | null;
          wacalls_paired_at: string | null;
          wacalls_session_id: string | null;
          waha_session_name: string | null;
          warmup_completed_at: string | null;
          warmup_started_at: string | null;
          webhook_path_token: string;
          webhook_secret_encrypted: string;
          zernio_account_id: string | null;
          zernio_token_encrypted: string | null;
        };
        ComputedFields: never;
        Insert: {
          archived_at?: string | null;
          consecutive_health_fails?: number;
          created_at?: string;
          created_by?: string | null;
          daily_message_limit?: number;
          datafy_phone_number_id?: string | null;
          datafy_token_encrypted?: string | null;
          datafy_waba_id?: string | null;
          display_name?: string | null;
          engine?: string;
          id?: string;
          is_warmup_complete?: never;
          last_health_check_at?: string | null;
          last_status_change_at?: string;
          meta_phone_number_id?: string | null;
          meta_token_encrypted?: string | null;
          meta_waba_id?: string | null;
          meta_webhook_override_em?: string | null;
          meta_webhook_override_erro?: string | null;
          meta_webhook_override_uri?: string | null;
          metadata?: NonNullable<Json>;
          organization_id: string;
          phone_number?: string | null;
          provider?: string;
          status?: string;
          status_reason?: string | null;
          updated_at?: string;
          wacalls_jid?: string | null;
          wacalls_paired_at?: string | null;
          wacalls_session_id?: string | null;
          waha_session_name?: string | null;
          warmup_completed_at?: string | null;
          warmup_started_at?: string | null;
          webhook_path_token?: string;
          webhook_secret_encrypted: string;
          zernio_account_id?: string | null;
          zernio_token_encrypted?: string | null;
        };
        Update: {
          archived_at?: string | null;
          consecutive_health_fails?: number;
          created_at?: string;
          created_by?: string | null;
          daily_message_limit?: number;
          datafy_phone_number_id?: string | null;
          datafy_token_encrypted?: string | null;
          datafy_waba_id?: string | null;
          display_name?: string | null;
          engine?: string;
          id?: string;
          is_warmup_complete?: never;
          last_health_check_at?: string | null;
          last_status_change_at?: string;
          meta_phone_number_id?: string | null;
          meta_token_encrypted?: string | null;
          meta_waba_id?: string | null;
          meta_webhook_override_em?: string | null;
          meta_webhook_override_erro?: string | null;
          meta_webhook_override_uri?: string | null;
          metadata?: NonNullable<Json>;
          organization_id?: string;
          phone_number?: string | null;
          provider?: string;
          status?: string;
          status_reason?: string | null;
          updated_at?: string;
          wacalls_jid?: string | null;
          wacalls_paired_at?: string | null;
          wacalls_session_id?: string | null;
          waha_session_name?: string | null;
          warmup_completed_at?: string | null;
          warmup_started_at?: string | null;
          webhook_path_token?: string;
          webhook_secret_encrypted?: string;
          zernio_account_id?: string | null;
          zernio_token_encrypted?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "channel_sessions_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      cobranca_assinaturas: {
        Row: {
          assinaturas_vivas: number;
          cancela_no_fim: boolean;
          checkout_expira_em: string | null;
          checkout_sessao_id: string | null;
          checkout_url: string | null;
          created_at: string;
          estado: string;
          link_de_pagamento: string | null;
          modo: string | null;
          organization_id: string;
          pagamento_inicial_pendente: boolean;
          periodo_pago_desde: string | null;
          plano_agendado_id: string | null;
          plano_id: string;
          plano_troca_pendente_id: string | null;
          prazo_extra_ate: string | null;
          provedor: string | null;
          provedor_assinatura_id: string | null;
          provedor_cliente_id: string | null;
          proximo_vencimento: string | null;
          relida_em: string | null;
          trial_ate: string | null;
          troca_id: string | null;
          troca_pagamento_ref: string | null;
          troca_pagamento_url: string | null;
          troca_reserva_ate: string | null;
          troca_status: string | null;
          troca_valor_cents: number | null;
          ultimo_aviso: string | null;
          ultimo_aviso_em: string | null;
          ultimo_erro: string | null;
          ultimo_erro_em: string | null;
          updated_at: string;
          vencida_desde: string | null;
        };
        ComputedFields: never;
        Insert: {
          assinaturas_vivas?: number;
          cancela_no_fim?: boolean;
          checkout_expira_em?: string | null;
          checkout_sessao_id?: string | null;
          checkout_url?: string | null;
          created_at?: string;
          estado?: string;
          link_de_pagamento?: string | null;
          modo?: string | null;
          organization_id: string;
          pagamento_inicial_pendente?: boolean;
          periodo_pago_desde?: string | null;
          plano_agendado_id?: string | null;
          plano_id: string;
          plano_troca_pendente_id?: string | null;
          prazo_extra_ate?: string | null;
          provedor?: string | null;
          provedor_assinatura_id?: string | null;
          provedor_cliente_id?: string | null;
          proximo_vencimento?: string | null;
          relida_em?: string | null;
          trial_ate?: string | null;
          troca_id?: string | null;
          troca_pagamento_ref?: string | null;
          troca_pagamento_url?: string | null;
          troca_reserva_ate?: string | null;
          troca_status?: string | null;
          troca_valor_cents?: number | null;
          ultimo_aviso?: string | null;
          ultimo_aviso_em?: string | null;
          ultimo_erro?: string | null;
          ultimo_erro_em?: string | null;
          updated_at?: string;
          vencida_desde?: string | null;
        };
        Update: {
          assinaturas_vivas?: number;
          cancela_no_fim?: boolean;
          checkout_expira_em?: string | null;
          checkout_sessao_id?: string | null;
          checkout_url?: string | null;
          created_at?: string;
          estado?: string;
          link_de_pagamento?: string | null;
          modo?: string | null;
          organization_id?: string;
          pagamento_inicial_pendente?: boolean;
          periodo_pago_desde?: string | null;
          plano_agendado_id?: string | null;
          plano_id?: string;
          plano_troca_pendente_id?: string | null;
          prazo_extra_ate?: string | null;
          provedor?: string | null;
          provedor_assinatura_id?: string | null;
          provedor_cliente_id?: string | null;
          proximo_vencimento?: string | null;
          relida_em?: string | null;
          trial_ate?: string | null;
          troca_id?: string | null;
          troca_pagamento_ref?: string | null;
          troca_pagamento_url?: string | null;
          troca_reserva_ate?: string | null;
          troca_status?: string | null;
          troca_valor_cents?: number | null;
          ultimo_aviso?: string | null;
          ultimo_aviso_em?: string | null;
          ultimo_erro?: string | null;
          ultimo_erro_em?: string | null;
          updated_at?: string;
          vencida_desde?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "cobranca_assinaturas_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: true;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "cobranca_assinaturas_plano_agendado_id_fkey";
            columns: ["plano_agendado_id"];
            isOneToOne: false;
            referencedRelation: "cobranca_planos";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "cobranca_assinaturas_plano_id_fkey";
            columns: ["plano_id"];
            isOneToOne: false;
            referencedRelation: "cobranca_planos";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "cobranca_assinaturas_plano_troca_pendente_id_fkey";
            columns: ["plano_troca_pendente_id"];
            isOneToOne: false;
            referencedRelation: "cobranca_planos";
            referencedColumns: ["id"];
          },
        ];
      };
      cobranca_planos: {
        Row: {
          arquivado_em: string | null;
          created_at: string;
          id: string;
          intervalo: string;
          max_assentos: number | null;
          max_canais: number | null;
          moeda: string;
          nome: string;
          oferecido_ao_cliente: boolean;
          padrao_no_cadastro: boolean;
          preco_cents: number;
          teto_ia_usd_cents: number | null;
          trial_dias: number;
          updated_at: string;
          updated_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          arquivado_em?: string | null;
          created_at?: string;
          id?: string;
          intervalo: string;
          max_assentos?: number | null;
          max_canais?: number | null;
          moeda?: string;
          nome: string;
          oferecido_ao_cliente?: boolean;
          padrao_no_cadastro?: boolean;
          preco_cents: number;
          teto_ia_usd_cents?: number | null;
          trial_dias?: number;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          arquivado_em?: string | null;
          created_at?: string;
          id?: string;
          intervalo?: string;
          max_assentos?: number | null;
          max_canais?: number | null;
          moeda?: string;
          nome?: string;
          oferecido_ao_cliente?: boolean;
          padrao_no_cadastro?: boolean;
          preco_cents?: number;
          teto_ia_usd_cents?: number | null;
          trial_dias?: number;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };
      companies: {
        Row: {
          brasilapi_raw: Json | null;
          city: string | null;
          cnpj: string | null;
          company_size: string | null;
          complement: string | null;
          created_at: string;
          created_by: string | null;
          district: string | null;
          email: string | null;
          enriched_at: string | null;
          enrichment_error: string | null;
          enrichment_status: string;
          id: string;
          legal_name: string | null;
          legal_nature: string | null;
          main_cnae_code: string | null;
          main_cnae_description: string | null;
          normalized_cnpj: string | null;
          number: string | null;
          opened_at: string | null;
          organization_id: string;
          phone: string | null;
          registration_status: string | null;
          secondary_cnaes: NonNullable<Json>;
          share_capital: number | null;
          state: string | null;
          street: string | null;
          trade_name: string | null;
          updated_at: string;
          zip_code: string | null;
        };
        ComputedFields: never;
        Insert: {
          brasilapi_raw?: Json | null;
          city?: string | null;
          cnpj?: string | null;
          company_size?: string | null;
          complement?: string | null;
          created_at?: string;
          created_by?: string | null;
          district?: string | null;
          email?: string | null;
          enriched_at?: string | null;
          enrichment_error?: string | null;
          enrichment_status?: string;
          id?: string;
          legal_name?: string | null;
          legal_nature?: string | null;
          main_cnae_code?: string | null;
          main_cnae_description?: string | null;
          normalized_cnpj?: string | null;
          number?: string | null;
          opened_at?: string | null;
          organization_id: string;
          phone?: string | null;
          registration_status?: string | null;
          secondary_cnaes?: NonNullable<Json>;
          share_capital?: number | null;
          state?: string | null;
          street?: string | null;
          trade_name?: string | null;
          updated_at?: string;
          zip_code?: string | null;
        };
        Update: {
          brasilapi_raw?: Json | null;
          city?: string | null;
          cnpj?: string | null;
          company_size?: string | null;
          complement?: string | null;
          created_at?: string;
          created_by?: string | null;
          district?: string | null;
          email?: string | null;
          enriched_at?: string | null;
          enrichment_error?: string | null;
          enrichment_status?: string;
          id?: string;
          legal_name?: string | null;
          legal_nature?: string | null;
          main_cnae_code?: string | null;
          main_cnae_description?: string | null;
          normalized_cnpj?: string | null;
          number?: string | null;
          opened_at?: string | null;
          organization_id?: string;
          phone?: string | null;
          registration_status?: string | null;
          secondary_cnaes?: NonNullable<Json>;
          share_capital?: number | null;
          state?: string | null;
          street?: string | null;
          trade_name?: string | null;
          updated_at?: string;
          zip_code?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "companies_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      company_people: {
        Row: {
          company_id: string;
          created_at: string;
          department: string | null;
          id: string;
          is_decision_maker: boolean;
          is_primary: boolean;
          job_title: string | null;
          notes: string | null;
          organization_id: string;
          person_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          company_id: string;
          created_at?: string;
          department?: string | null;
          id?: string;
          is_decision_maker?: boolean;
          is_primary?: boolean;
          job_title?: string | null;
          notes?: string | null;
          organization_id: string;
          person_id: string;
          updated_at?: string;
        };
        Update: {
          company_id?: string;
          created_at?: string;
          department?: string | null;
          id?: string;
          is_decision_maker?: boolean;
          is_primary?: boolean;
          job_title?: string | null;
          notes?: string | null;
          organization_id?: string;
          person_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "company_people_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "company_people_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "company_people_person_id_fkey";
            columns: ["person_id"];
            isOneToOne: false;
            referencedRelation: "people";
            referencedColumns: ["id"];
          },
        ];
      };
      config_aviso_de_agendamento: {
        Row: {
          atualizado_por: string | null;
          channel_session_id: string | null;
          created_at: string;
          criado_por: string | null;
          ligado: boolean;
          organization_id: string;
          telefone_destino: string | null;
          updated_at: string;
          usa_numero_do_aviso_de_caso: boolean;
        };
        ComputedFields: never;
        Insert: {
          atualizado_por?: string | null;
          channel_session_id?: string | null;
          created_at?: string;
          criado_por?: string | null;
          ligado?: boolean;
          organization_id: string;
          telefone_destino?: string | null;
          updated_at?: string;
          usa_numero_do_aviso_de_caso?: boolean;
        };
        Update: {
          atualizado_por?: string | null;
          channel_session_id?: string | null;
          created_at?: string;
          criado_por?: string | null;
          ligado?: boolean;
          organization_id?: string;
          telefone_destino?: string | null;
          updated_at?: string;
          usa_numero_do_aviso_de_caso?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "config_aviso_de_agendamento_channel_session_id_fkey";
            columns: ["channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "config_aviso_de_agendamento_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: true;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      config_aviso_de_caso: {
        Row: {
          atualizado_por: string | null;
          channel_session_id: string | null;
          created_at: string;
          criado_por: string | null;
          destino_jid: string | null;
          ligado: boolean;
          mensagens_ignoradas: number;
          organization_id: string;
          resposta_whatsapp_habilitada: boolean;
          rotulo: string | null;
          telefone_destino: string;
          ultima_mensagem_ignorada_em: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          atualizado_por?: string | null;
          channel_session_id?: string | null;
          created_at?: string;
          criado_por?: string | null;
          destino_jid?: string | null;
          ligado?: boolean;
          mensagens_ignoradas?: number;
          organization_id: string;
          resposta_whatsapp_habilitada?: boolean;
          rotulo?: string | null;
          telefone_destino: string;
          ultima_mensagem_ignorada_em?: string | null;
          updated_at?: string;
        };
        Update: {
          atualizado_por?: string | null;
          channel_session_id?: string | null;
          created_at?: string;
          criado_por?: string | null;
          destino_jid?: string | null;
          ligado?: boolean;
          mensagens_ignoradas?: number;
          organization_id?: string;
          resposta_whatsapp_habilitada?: boolean;
          rotulo?: string | null;
          telefone_destino?: string;
          ultima_mensagem_ignorada_em?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "config_aviso_de_caso_channel_session_id_fkey";
            columns: ["channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "config_aviso_de_caso_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: true;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      contact_field_proposals: {
        Row: {
          campo: string;
          contact_id: string;
          conversation_id: string | null;
          decided_at: string | null;
          decided_by_user_id: string | null;
          expires_at: string;
          id: string;
          message_id: string | null;
          motivo_recusa: string | null;
          organization_id: string;
          proposed_at: string;
          proposed_by_agent_id: string | null;
          status: string;
          trecho: string | null;
          updated_at: string;
          valor_anterior: string | null;
          valor_proposto: string;
        };
        ComputedFields: never;
        Insert: {
          campo: string;
          contact_id: string;
          conversation_id?: string | null;
          decided_at?: string | null;
          decided_by_user_id?: string | null;
          expires_at: string;
          id?: string;
          message_id?: string | null;
          motivo_recusa?: string | null;
          organization_id: string;
          proposed_at?: string;
          proposed_by_agent_id?: string | null;
          status?: string;
          trecho?: string | null;
          updated_at?: string;
          valor_anterior?: string | null;
          valor_proposto: string;
        };
        Update: {
          campo?: string;
          contact_id?: string;
          conversation_id?: string | null;
          decided_at?: string | null;
          decided_by_user_id?: string | null;
          expires_at?: string;
          id?: string;
          message_id?: string | null;
          motivo_recusa?: string | null;
          organization_id?: string;
          proposed_at?: string;
          proposed_by_agent_id?: string | null;
          status?: string;
          trecho?: string | null;
          updated_at?: string;
          valor_anterior?: string | null;
          valor_proposto?: string;
        };
        Relationships: [
          {
            foreignKeyName: "contact_field_proposals_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "contact_field_proposals_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "contact_field_proposals_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "contact_field_proposals_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "contact_field_proposals_proposed_by_agent_id_fkey";
            columns: ["proposed_by_agent_id"];
            isOneToOne: false;
            referencedRelation: "ai_agents";
            referencedColumns: ["id"];
          },
        ];
      };
      contacts: {
        Row: {
          address_book_name: string | null;
          ai_authorized_at: string | null;
          ai_authorized_reason: string | null;
          ai_opt_out: boolean;
          anonymized_at: string | null;
          avatar_storage_path: string | null;
          avatar_updated_at: string | null;
          birthdate: string | null;
          birthday_md: number | null;
          blocked_at: string | null;
          blocked_reason: string | null;
          carteira_definida_em: string | null;
          carteira_origem: string | null;
          carteira_user_id: string | null;
          client_recognized_at: string | null;
          client_tag_by_system: string | null;
          consent: NonNullable<Json>;
          contact_type: string;
          cpf_encrypted: string | null;
          cpf_hash: string | null;
          created_at: string;
          created_by_user_id: string | null;
          custom_fields: NonNullable<Json>;
          display_name: string | null;
          email: string | null;
          email_normalized: string | null;
          first_service_at: string | null;
          force_human: boolean;
          id: string;
          is_anonymized: boolean;
          is_blocked: boolean;
          is_merged_into: string | null;
          is_personal: boolean;
          kind: string;
          last_activity_at: string | null;
          locale: string | null;
          merged_at: string | null;
          name: string | null;
          name_lookup_at: string | null;
          organization_id: string;
          person_id: string | null;
          phone_lookup_at: string | null;
          phone_number: string | null;
          social_identity: string | null;
          source: string;
          source_metadata: NonNullable<Json>;
          tags: string[];
          updated_at: string;
          wa_identity: string | null;
          wa_lid: string | null;
        };
        ComputedFields: never;
        Insert: {
          address_book_name?: string | null;
          ai_authorized_at?: string | null;
          ai_authorized_reason?: string | null;
          ai_opt_out?: boolean;
          anonymized_at?: string | null;
          avatar_storage_path?: string | null;
          avatar_updated_at?: string | null;
          birthdate?: string | null;
          birthday_md?: never;
          blocked_at?: string | null;
          blocked_reason?: string | null;
          carteira_definida_em?: string | null;
          carteira_origem?: string | null;
          carteira_user_id?: string | null;
          client_recognized_at?: string | null;
          client_tag_by_system?: string | null;
          consent?: NonNullable<Json>;
          contact_type?: string;
          cpf_encrypted?: string | null;
          cpf_hash?: string | null;
          created_at?: string;
          created_by_user_id?: string | null;
          custom_fields?: NonNullable<Json>;
          display_name?: string | null;
          email?: string | null;
          email_normalized?: never;
          first_service_at?: string | null;
          force_human?: boolean;
          id?: string;
          is_anonymized?: boolean;
          is_blocked?: boolean;
          is_merged_into?: string | null;
          is_personal?: boolean;
          kind?: string;
          last_activity_at?: string | null;
          locale?: string | null;
          merged_at?: string | null;
          name?: string | null;
          name_lookup_at?: string | null;
          organization_id: string;
          person_id?: string | null;
          phone_lookup_at?: string | null;
          phone_number?: string | null;
          social_identity?: string | null;
          source?: string;
          source_metadata?: NonNullable<Json>;
          tags?: string[];
          updated_at?: string;
          wa_identity?: never;
          wa_lid?: never;
        };
        Update: {
          address_book_name?: string | null;
          ai_authorized_at?: string | null;
          ai_authorized_reason?: string | null;
          ai_opt_out?: boolean;
          anonymized_at?: string | null;
          avatar_storage_path?: string | null;
          avatar_updated_at?: string | null;
          birthdate?: string | null;
          birthday_md?: never;
          blocked_at?: string | null;
          blocked_reason?: string | null;
          carteira_definida_em?: string | null;
          carteira_origem?: string | null;
          carteira_user_id?: string | null;
          client_recognized_at?: string | null;
          client_tag_by_system?: string | null;
          consent?: NonNullable<Json>;
          contact_type?: string;
          cpf_encrypted?: string | null;
          cpf_hash?: string | null;
          created_at?: string;
          created_by_user_id?: string | null;
          custom_fields?: NonNullable<Json>;
          display_name?: string | null;
          email?: string | null;
          email_normalized?: never;
          first_service_at?: string | null;
          force_human?: boolean;
          id?: string;
          is_anonymized?: boolean;
          is_blocked?: boolean;
          is_merged_into?: string | null;
          is_personal?: boolean;
          kind?: string;
          last_activity_at?: string | null;
          locale?: string | null;
          merged_at?: string | null;
          name?: string | null;
          name_lookup_at?: string | null;
          organization_id?: string;
          person_id?: string | null;
          phone_lookup_at?: string | null;
          phone_number?: string | null;
          social_identity?: string | null;
          source?: string;
          source_metadata?: NonNullable<Json>;
          tags?: string[];
          updated_at?: string;
          wa_identity?: never;
          wa_lid?: never;
        };
        Relationships: [
          {
            foreignKeyName: "contacts_is_merged_into_fkey";
            columns: ["is_merged_into"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "contacts_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "contacts_person_id_fkey";
            columns: ["person_id"];
            isOneToOne: false;
            referencedRelation: "people";
            referencedColumns: ["id"];
          },
        ];
      };
      conversation_assignment_events: {
        Row: {
          changed_by: string | null;
          conversation_id: string;
          created_at: string;
          from_user_id: string | null;
          id: string;
          organization_id: string;
          reason: string;
          to_user_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          changed_by?: string | null;
          conversation_id: string;
          created_at?: string;
          from_user_id?: string | null;
          id?: string;
          organization_id: string;
          reason: string;
          to_user_id?: string | null;
        };
        Update: {
          changed_by?: string | null;
          conversation_id?: string;
          created_at?: string;
          from_user_id?: string | null;
          id?: string;
          organization_id?: string;
          reason?: string;
          to_user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "conversation_assignment_events_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversation_assignment_events_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      conversation_drafts: {
        Row: {
          body: string;
          consumed_at: string | null;
          consumed_by_user_id: string | null;
          conversation_id: string;
          created_at: string;
          created_by_api_token_id: string | null;
          expires_at: string;
          id: string;
          organization_id: string;
          source: string;
        };
        ComputedFields: never;
        Insert: {
          body: string;
          consumed_at?: string | null;
          consumed_by_user_id?: string | null;
          conversation_id: string;
          created_at?: string;
          created_by_api_token_id?: string | null;
          expires_at: string;
          id?: string;
          organization_id: string;
          source?: string;
        };
        Update: {
          body?: string;
          consumed_at?: string | null;
          consumed_by_user_id?: string | null;
          conversation_id?: string;
          created_at?: string;
          created_by_api_token_id?: string | null;
          expires_at?: string;
          id?: string;
          organization_id?: string;
          source?: string;
        };
        Relationships: [
          {
            foreignKeyName: "conversation_drafts_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversation_drafts_created_by_api_token_id_fkey";
            columns: ["created_by_api_token_id"];
            isOneToOne: false;
            referencedRelation: "api_tokens";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversation_drafts_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      conversation_notes: {
        Row: {
          body: string;
          conversation_id: string;
          created_at: string;
          created_by_name: string | null;
          created_by_user_id: string | null;
          id: string;
          media_mime: string | null;
          media_size_bytes: number | null;
          media_storage_path: string | null;
          organization_id: string;
        };
        ComputedFields: never;
        Insert: {
          body: string;
          conversation_id: string;
          created_at?: string;
          created_by_name?: string | null;
          created_by_user_id?: string | null;
          id?: string;
          media_mime?: string | null;
          media_size_bytes?: number | null;
          media_storage_path?: string | null;
          organization_id: string;
        };
        Update: {
          body?: string;
          conversation_id?: string;
          created_at?: string;
          created_by_name?: string | null;
          created_by_user_id?: string | null;
          id?: string;
          media_mime?: string | null;
          media_size_bytes?: number | null;
          media_storage_path?: string | null;
          organization_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "conversation_notes_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversation_notes_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      conversation_participants: {
        Row: {
          conversation_id: string;
          id: string;
          invited_by: string | null;
          joined_at: string;
          left_at: string | null;
          organization_id: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          conversation_id: string;
          id?: string;
          invited_by?: string | null;
          joined_at?: string;
          left_at?: string | null;
          organization_id: string;
          user_id: string;
        };
        Update: {
          conversation_id?: string;
          id?: string;
          invited_by?: string | null;
          joined_at?: string;
          left_at?: string | null;
          organization_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "conversation_participants_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversation_participants_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      conversations: {
        Row: {
          active_agent_set_at: string | null;
          active_ai_agent_id: string | null;
          active_intent: string | null;
          assigned_at: string | null;
          assigned_to_user_id: string | null;
          assigned_to_user_name: string | null;
          assignee_kind: string | null;
          awaiting_since: string | null;
          bot_silenced_until: string | null;
          channel: string;
          channel_session_id: string;
          contact_id: string;
          contato_trava_humano: boolean;
          created_at: string;
          current_demanda_id: string | null;
          group_chat_id: string | null;
          id: string;
          is_group: boolean;
          last_handoff_at: string | null;
          last_handoff_reason: string | null;
          last_inbound_at: string | null;
          last_message_at: string | null;
          last_message_preview: string | null;
          last_outbound_at: string | null;
          metadata: NonNullable<Json>;
          organization_id: string;
          provider_conversation_id: string | null;
          rag_review_status: string | null;
          reply_context_revision: number;
          service_closed_at: string | null;
          service_revision: number;
          service_started_at: string | null;
          snooze_until: string | null;
          snoozed_at: string | null;
          snoozed_by_user_id: string | null;
          status: string;
          status_changed_at: string;
          tags: string[];
          unread_count_for_assignee: number;
          updated_at: string;
          usable_for_rag: boolean;
          usable_for_rag_marked_at: string | null;
          usable_for_rag_marked_by: string | null;
          comando_da_conversa: string | null;
          tags_do_contato: string[] | null;
        };
        ComputedFields: "comando_da_conversa" | "tags_do_contato";
        Insert: {
          active_agent_set_at?: string | null;
          active_ai_agent_id?: string | null;
          active_intent?: string | null;
          assigned_at?: string | null;
          assigned_to_user_id?: string | null;
          assigned_to_user_name?: string | null;
          assignee_kind?: string | null;
          awaiting_since?: string | null;
          bot_silenced_until?: string | null;
          channel?: string;
          channel_session_id: string;
          contact_id: string;
          contato_trava_humano?: boolean;
          created_at?: string;
          current_demanda_id?: string | null;
          group_chat_id?: string | null;
          id?: string;
          is_group?: boolean;
          last_handoff_at?: string | null;
          last_handoff_reason?: string | null;
          last_inbound_at?: string | null;
          last_message_at?: string | null;
          last_message_preview?: string | null;
          last_outbound_at?: string | null;
          metadata?: NonNullable<Json>;
          organization_id: string;
          provider_conversation_id?: string | null;
          rag_review_status?: string | null;
          reply_context_revision?: number;
          service_closed_at?: string | null;
          service_revision?: number;
          service_started_at?: string | null;
          snooze_until?: string | null;
          snoozed_at?: string | null;
          snoozed_by_user_id?: string | null;
          status?: string;
          status_changed_at?: string;
          tags?: string[];
          unread_count_for_assignee?: number;
          updated_at?: string;
          usable_for_rag?: boolean;
          usable_for_rag_marked_at?: string | null;
          usable_for_rag_marked_by?: string | null;
        };
        Update: {
          active_agent_set_at?: string | null;
          active_ai_agent_id?: string | null;
          active_intent?: string | null;
          assigned_at?: string | null;
          assigned_to_user_id?: string | null;
          assigned_to_user_name?: string | null;
          assignee_kind?: string | null;
          awaiting_since?: string | null;
          bot_silenced_until?: string | null;
          channel?: string;
          channel_session_id?: string;
          contact_id?: string;
          contato_trava_humano?: boolean;
          created_at?: string;
          current_demanda_id?: string | null;
          group_chat_id?: string | null;
          id?: string;
          is_group?: boolean;
          last_handoff_at?: string | null;
          last_handoff_reason?: string | null;
          last_inbound_at?: string | null;
          last_message_at?: string | null;
          last_message_preview?: string | null;
          last_outbound_at?: string | null;
          metadata?: NonNullable<Json>;
          organization_id?: string;
          provider_conversation_id?: string | null;
          rag_review_status?: string | null;
          reply_context_revision?: number;
          service_closed_at?: string | null;
          service_revision?: number;
          service_started_at?: string | null;
          snooze_until?: string | null;
          snoozed_at?: string | null;
          snoozed_by_user_id?: string | null;
          status?: string;
          status_changed_at?: string;
          tags?: string[];
          unread_count_for_assignee?: number;
          updated_at?: string;
          usable_for_rag?: boolean;
          usable_for_rag_marked_at?: string | null;
          usable_for_rag_marked_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "conversations_active_ai_agent_id_fkey";
            columns: ["active_ai_agent_id"];
            isOneToOne: false;
            referencedRelation: "ai_agents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversations_channel_session_id_fkey";
            columns: ["channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversations_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversations_current_demanda_id_fkey";
            columns: ["current_demanda_id"];
            isOneToOne: false;
            referencedRelation: "demandas";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversations_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      crm_lead_activities: {
        Row: {
          actor_agent_id: string | null;
          actor_kind: string | null;
          contact_id: string | null;
          created_at: string;
          evidence: Json | null;
          id: string;
          lead_id: string;
          metadata: NonNullable<Json>;
          organization_id: string;
          payload: NonNullable<Json>;
          performed_at: string;
          performed_by_user_id: string | null;
          reason: string | null;
          source_id: string | null;
          source_module: string;
          type: string;
        };
        ComputedFields: never;
        Insert: {
          actor_agent_id?: string | null;
          actor_kind?: string | null;
          contact_id?: string | null;
          created_at?: string;
          evidence?: Json | null;
          id?: string;
          lead_id: string;
          metadata?: NonNullable<Json>;
          organization_id: string;
          payload?: NonNullable<Json>;
          performed_at?: string;
          performed_by_user_id?: string | null;
          reason?: string | null;
          source_id?: string | null;
          source_module: string;
          type: string;
        };
        Update: {
          actor_agent_id?: string | null;
          actor_kind?: string | null;
          contact_id?: string | null;
          created_at?: string;
          evidence?: Json | null;
          id?: string;
          lead_id?: string;
          metadata?: NonNullable<Json>;
          organization_id?: string;
          payload?: NonNullable<Json>;
          performed_at?: string;
          performed_by_user_id?: string | null;
          reason?: string | null;
          source_id?: string | null;
          source_module?: string;
          type?: string;
        };
        Relationships: [
          {
            foreignKeyName: "crm_lead_activities_actor_agent_id_fkey";
            columns: ["actor_agent_id"];
            isOneToOne: false;
            referencedRelation: "ai_agents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "crm_lead_activities_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "crm_lead_activities_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "crm_leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "crm_lead_activities_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      crm_lead_attachments: {
        Row: {
          created_at: string;
          created_by: string | null;
          field_key: string;
          file_name: string;
          file_size: number;
          id: string;
          lead_id: string;
          mime_type: string;
          organization_id: string;
          storage_path: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          field_key: string;
          file_name: string;
          file_size?: number;
          id?: string;
          lead_id: string;
          mime_type?: string;
          organization_id: string;
          storage_path: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          field_key?: string;
          file_name?: string;
          file_size?: number;
          id?: string;
          lead_id?: string;
          mime_type?: string;
          organization_id?: string;
          storage_path?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "crm_lead_attachments_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "crm_leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "crm_lead_attachments_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      crm_lead_links: {
        Row: {
          created_at: string;
          created_by_user_id: string | null;
          id: string;
          lead_id: string;
          link_kind: string;
          metadata: NonNullable<Json>;
          organization_id: string;
          target_id: string;
          target_kind: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by_user_id?: string | null;
          id?: string;
          lead_id: string;
          link_kind: string;
          metadata?: NonNullable<Json>;
          organization_id: string;
          target_id: string;
          target_kind: string;
        };
        Update: {
          created_at?: string;
          created_by_user_id?: string | null;
          id?: string;
          lead_id?: string;
          link_kind?: string;
          metadata?: NonNullable<Json>;
          organization_id?: string;
          target_id?: string;
          target_kind?: string;
        };
        Relationships: [
          {
            foreignKeyName: "crm_lead_links_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "crm_leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "crm_lead_links_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      crm_lead_reactivations: {
        Row: {
          decided_at: string | null;
          decided_by_user_id: string | null;
          draft: string | null;
          expires_at: string;
          id: string;
          lead_id: string;
          organization_id: string;
          proposed_at: string;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          decided_at?: string | null;
          decided_by_user_id?: string | null;
          draft?: string | null;
          expires_at: string;
          id?: string;
          lead_id: string;
          organization_id: string;
          proposed_at?: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          decided_at?: string | null;
          decided_by_user_id?: string | null;
          draft?: string | null;
          expires_at?: string;
          id?: string;
          lead_id?: string;
          organization_id?: string;
          proposed_at?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "crm_lead_reactivations_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "crm_leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "crm_lead_reactivations_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      crm_lead_risk_states: {
        Row: {
          bucket: string;
          cold_hours: number;
          detected_at: string;
          lead_id: string;
          organization_id: string;
          since: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          bucket: string;
          cold_hours: number;
          detected_at?: string;
          lead_id: string;
          organization_id: string;
          since: string;
          updated_at?: string;
        };
        Update: {
          bucket?: string;
          cold_hours?: number;
          detected_at?: string;
          lead_id?: string;
          organization_id?: string;
          since?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "crm_lead_risk_states_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: true;
            referencedRelation: "crm_leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "crm_lead_risk_states_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      crm_lead_scores: {
        Row: {
          ai_probability: number | null;
          ai_probability_at: string | null;
          ai_probability_band: string | null;
          ai_probability_band_since: string | null;
          ai_probability_evidence: NonNullable<Json>;
          ai_probability_reason: string | null;
          lead_id: string;
          organization_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          ai_probability?: number | null;
          ai_probability_at?: string | null;
          ai_probability_band?: string | null;
          ai_probability_band_since?: string | null;
          ai_probability_evidence?: NonNullable<Json>;
          ai_probability_reason?: string | null;
          lead_id: string;
          organization_id: string;
          updated_at?: string;
        };
        Update: {
          ai_probability?: number | null;
          ai_probability_at?: string | null;
          ai_probability_band?: string | null;
          ai_probability_band_since?: string | null;
          ai_probability_evidence?: NonNullable<Json>;
          ai_probability_reason?: string | null;
          lead_id?: string;
          organization_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "crm_lead_scores_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: true;
            referencedRelation: "crm_leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "crm_lead_scores_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      crm_leads: {
        Row: {
          assigned_at: string | null;
          closed_at: string | null;
          contact_id: string | null;
          created_at: string;
          created_by_user_id: string | null;
          currency: string | null;
          custom_fields: NonNullable<Json>;
          description: string | null;
          expected_close_date: string | null;
          external_id: string | null;
          id: string;
          last_activity_at: string | null;
          lost_from_stage_id: string | null;
          lost_reason: string | null;
          organization_id: string;
          owner_agent_id: string | null;
          owner_kind: string | null;
          owner_user_id: string | null;
          pipeline_id: string;
          position_in_stage: number;
          recurring_months: number | null;
          recurring_period: "monthly" | null;
          recurring_value_cents: number | null;
          retomado_de_lead_id: string | null;
          source: string;
          source_metadata: NonNullable<Json>;
          stage_changed_at: string | null;
          stage_id: string;
          status: string;
          tags: string[];
          title: string;
          updated_at: string;
          value_cents: number | null;
          webhook_source_id: string | null;
          won_reason: string | null;
        };
        ComputedFields: never;
        Insert: {
          assigned_at?: string | null;
          closed_at?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by_user_id?: string | null;
          currency?: string | null;
          custom_fields?: NonNullable<Json>;
          description?: string | null;
          expected_close_date?: string | null;
          external_id?: string | null;
          id?: string;
          last_activity_at?: string | null;
          lost_from_stage_id?: string | null;
          lost_reason?: string | null;
          organization_id: string;
          owner_agent_id?: string | null;
          owner_kind?: string | null;
          owner_user_id?: string | null;
          pipeline_id: string;
          position_in_stage?: number;
          recurring_months?: number | null;
          recurring_period?: "monthly" | null;
          recurring_value_cents?: number | null;
          retomado_de_lead_id?: string | null;
          source?: string;
          source_metadata?: NonNullable<Json>;
          stage_changed_at?: string | null;
          stage_id: string;
          status?: string;
          tags?: string[];
          title: string;
          updated_at?: string;
          value_cents?: number | null;
          webhook_source_id?: string | null;
          won_reason?: string | null;
        };
        Update: {
          assigned_at?: string | null;
          closed_at?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by_user_id?: string | null;
          currency?: string | null;
          custom_fields?: NonNullable<Json>;
          description?: string | null;
          expected_close_date?: string | null;
          external_id?: string | null;
          id?: string;
          last_activity_at?: string | null;
          lost_from_stage_id?: string | null;
          lost_reason?: string | null;
          organization_id?: string;
          owner_agent_id?: string | null;
          owner_kind?: string | null;
          owner_user_id?: string | null;
          pipeline_id?: string;
          position_in_stage?: number;
          recurring_months?: number | null;
          recurring_period?: "monthly" | null;
          recurring_value_cents?: number | null;
          retomado_de_lead_id?: string | null;
          source?: string;
          source_metadata?: NonNullable<Json>;
          stage_changed_at?: string | null;
          stage_id?: string;
          status?: string;
          tags?: string[];
          title?: string;
          updated_at?: string;
          value_cents?: number | null;
          webhook_source_id?: string | null;
          won_reason?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "crm_leads_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "crm_leads_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "crm_leads_owner_agent_id_fkey";
            columns: ["owner_agent_id"];
            isOneToOne: false;
            referencedRelation: "ai_agents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "crm_leads_pipeline_id_fkey";
            columns: ["pipeline_id"];
            isOneToOne: false;
            referencedRelation: "crm_pipelines";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "crm_leads_stage_id_fkey";
            columns: ["stage_id"];
            isOneToOne: false;
            referencedRelation: "crm_stages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "crm_leads_webhook_source_id_fkey";
            columns: ["webhook_source_id"];
            isOneToOne: false;
            referencedRelation: "webhook_sources";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fk_crm_leads_lost_from_stage";
            columns: ["lost_from_stage_id"];
            isOneToOne: false;
            referencedRelation: "crm_stages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fk_crm_leads_retomado_de_lead";
            columns: ["retomado_de_lead_id"];
            isOneToOne: false;
            referencedRelation: "crm_leads";
            referencedColumns: ["id"];
          },
        ];
      };
      crm_metas: {
        Row: {
          alvo: number;
          created_at: string;
          created_by: string | null;
          id: string;
          indicador: string;
          organization_id: string;
          periodo: string;
          pipeline_id: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          alvo: number;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          indicador?: string;
          organization_id: string;
          periodo: string;
          pipeline_id?: string | null;
          updated_at?: string;
        };
        Update: {
          alvo?: number;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          indicador?: string;
          organization_id?: string;
          periodo?: string;
          pipeline_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "crm_metas_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "crm_metas_pipeline_id_fkey";
            columns: ["pipeline_id"];
            isOneToOne: false;
            referencedRelation: "crm_pipelines";
            referencedColumns: ["id"];
          },
        ];
      };
      crm_pipelines: {
        Row: {
          created_at: string;
          description: string | null;
          id: string;
          is_archived: boolean;
          is_client_pipeline: boolean;
          is_default: boolean;
          name: string;
          organization_id: string;
          position: number;
          settings: NonNullable<Json>;
          slug: string;
          updated_at: string;
          vocabulary: NonNullable<Json>;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          description?: string | null;
          id?: string;
          is_archived?: boolean;
          is_client_pipeline?: boolean;
          is_default?: boolean;
          name: string;
          organization_id: string;
          position?: number;
          settings?: NonNullable<Json>;
          slug: string;
          updated_at?: string;
          vocabulary?: NonNullable<Json>;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          id?: string;
          is_archived?: boolean;
          is_client_pipeline?: boolean;
          is_default?: boolean;
          name?: string;
          organization_id?: string;
          position?: number;
          settings?: NonNullable<Json>;
          slug?: string;
          updated_at?: string;
          vocabulary?: NonNullable<Json>;
        };
        Relationships: [
          {
            foreignKeyName: "crm_pipelines_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      crm_proposal_counters: {
        Row: {
          ano: number;
          organization_id: string;
          ultimo_numero: number;
        };
        ComputedFields: never;
        Insert: {
          ano: number;
          organization_id: string;
          ultimo_numero?: number;
        };
        Update: {
          ano?: number;
          organization_id?: string;
          ultimo_numero?: number;
        };
        Relationships: [
          {
            foreignKeyName: "crm_proposal_counters_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      crm_proposal_items: {
        Row: {
          created_at: string;
          desconto_cents: number;
          descricao: string;
          id: string;
          organization_id: string;
          position: number;
          preco_unitario_cents: number | null;
          product_id: string | null;
          proposal_id: string;
          quantidade: number;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          desconto_cents?: number;
          descricao: string;
          id?: string;
          organization_id: string;
          position: number;
          preco_unitario_cents?: number | null;
          product_id?: string | null;
          proposal_id: string;
          quantidade?: number;
        };
        Update: {
          created_at?: string;
          desconto_cents?: number;
          descricao?: string;
          id?: string;
          organization_id?: string;
          position?: number;
          preco_unitario_cents?: number | null;
          product_id?: string | null;
          proposal_id?: string;
          quantidade?: number;
        };
        Relationships: [
          {
            foreignKeyName: "crm_proposal_items_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "crm_proposal_items_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "catalog_products";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "crm_proposal_items_proposal_id_fkey";
            columns: ["proposal_id"];
            isOneToOne: false;
            referencedRelation: "crm_proposals";
            referencedColumns: ["id"];
          },
        ];
      };
      crm_proposals: {
        Row: {
          ano: number | null;
          briefing_json: Json | null;
          condicoes: string | null;
          contact_id: string | null;
          conversation_id: string | null;
          created_at: string;
          decided_at: string | null;
          decided_by_user_id: string | null;
          decision_reason: string | null;
          destinatario_nome: string | null;
          drafted_by_agent_id: string | null;
          id: string;
          lead_id: string | null;
          message_id: string | null;
          moeda: string;
          numero: number | null;
          organization_id: string;
          pagamento: string | null;
          pdf_path: string | null;
          prazo_dias_uteis: number | null;
          pricing_status: string;
          rendered_snapshot: Json | null;
          resumo_comercial: string | null;
          retorno_id: string | null;
          revision: number;
          secoes_editadas: Json | null;
          sent_at: string | null;
          sent_by_user_id: string | null;
          status: string;
          substitui_id: string | null;
          template_slug: string | null;
          template_slug_sugerido: string | null;
          template_snapshot: Json | null;
          template_version: number | null;
          titulo: string;
          total_cents: number;
          ultima_falha_envio: string | null;
          updated_at: string;
          valid_until: string | null;
          versao: number;
          version_reason: string | null;
        };
        ComputedFields: never;
        Insert: {
          ano?: number | null;
          briefing_json?: Json | null;
          condicoes?: string | null;
          contact_id?: string | null;
          conversation_id?: string | null;
          created_at?: string;
          decided_at?: string | null;
          decided_by_user_id?: string | null;
          decision_reason?: string | null;
          destinatario_nome?: string | null;
          drafted_by_agent_id?: string | null;
          id?: string;
          lead_id?: string | null;
          message_id?: string | null;
          moeda?: string;
          numero?: number | null;
          organization_id: string;
          pagamento?: string | null;
          pdf_path?: string | null;
          prazo_dias_uteis?: number | null;
          pricing_status?: string;
          rendered_snapshot?: Json | null;
          resumo_comercial?: string | null;
          retorno_id?: string | null;
          revision?: number;
          secoes_editadas?: Json | null;
          sent_at?: string | null;
          sent_by_user_id?: string | null;
          status?: string;
          substitui_id?: string | null;
          template_slug?: string | null;
          template_slug_sugerido?: string | null;
          template_snapshot?: Json | null;
          template_version?: number | null;
          titulo: string;
          total_cents?: number;
          ultima_falha_envio?: string | null;
          updated_at?: string;
          valid_until?: string | null;
          versao?: number;
          version_reason?: string | null;
        };
        Update: {
          ano?: number | null;
          briefing_json?: Json | null;
          condicoes?: string | null;
          contact_id?: string | null;
          conversation_id?: string | null;
          created_at?: string;
          decided_at?: string | null;
          decided_by_user_id?: string | null;
          decision_reason?: string | null;
          destinatario_nome?: string | null;
          drafted_by_agent_id?: string | null;
          id?: string;
          lead_id?: string | null;
          message_id?: string | null;
          moeda?: string;
          numero?: number | null;
          organization_id?: string;
          pagamento?: string | null;
          pdf_path?: string | null;
          prazo_dias_uteis?: number | null;
          pricing_status?: string;
          rendered_snapshot?: Json | null;
          resumo_comercial?: string | null;
          retorno_id?: string | null;
          revision?: number;
          secoes_editadas?: Json | null;
          sent_at?: string | null;
          sent_by_user_id?: string | null;
          status?: string;
          substitui_id?: string | null;
          template_slug?: string | null;
          template_slug_sugerido?: string | null;
          template_snapshot?: Json | null;
          template_version?: number | null;
          titulo?: string;
          total_cents?: number;
          ultima_falha_envio?: string | null;
          updated_at?: string;
          valid_until?: string | null;
          versao?: number;
          version_reason?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "crm_proposals_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "crm_proposals_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "crm_proposals_drafted_by_agent_id_fkey";
            columns: ["drafted_by_agent_id"];
            isOneToOne: false;
            referencedRelation: "ai_agents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "crm_proposals_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "crm_leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "crm_proposals_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "crm_proposals_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "crm_proposals_retorno_id_fkey";
            columns: ["retorno_id"];
            isOneToOne: false;
            referencedRelation: "cron_jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "crm_proposals_substitui_id_fkey";
            columns: ["substitui_id"];
            isOneToOne: false;
            referencedRelation: "crm_proposals";
            referencedColumns: ["id"];
          },
        ];
      };
      crm_stages: {
        Row: {
          agent_stage_hint: string | null;
          avisar_na_central: boolean;
          color: string | null;
          created_at: string;
          description: string | null;
          expected_duration_hours: number | null;
          id: string;
          is_archived: boolean;
          is_lost: boolean;
          is_won: boolean;
          last_change_actor_kind: string | null;
          last_change_at: string | null;
          name: string;
          organization_id: string;
          pipeline_id: string;
          position: number;
          requires_human: boolean;
          slug: string;
          updated_at: string;
          win_probability: number | null;
        };
        ComputedFields: never;
        Insert: {
          agent_stage_hint?: string | null;
          avisar_na_central?: boolean;
          color?: string | null;
          created_at?: string;
          description?: string | null;
          expected_duration_hours?: number | null;
          id?: string;
          is_archived?: boolean;
          is_lost?: boolean;
          is_won?: boolean;
          last_change_actor_kind?: string | null;
          last_change_at?: string | null;
          name: string;
          organization_id: string;
          pipeline_id: string;
          position: number;
          requires_human?: boolean;
          slug: string;
          updated_at?: string;
          win_probability?: number | null;
        };
        Update: {
          agent_stage_hint?: string | null;
          avisar_na_central?: boolean;
          color?: string | null;
          created_at?: string;
          description?: string | null;
          expected_duration_hours?: number | null;
          id?: string;
          is_archived?: boolean;
          is_lost?: boolean;
          is_won?: boolean;
          last_change_actor_kind?: string | null;
          last_change_at?: string | null;
          name?: string;
          organization_id?: string;
          pipeline_id?: string;
          position?: number;
          requires_human?: boolean;
          slug?: string;
          updated_at?: string;
          win_probability?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "crm_stages_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "crm_stages_pipeline_id_fkey";
            columns: ["pipeline_id"];
            isOneToOne: false;
            referencedRelation: "crm_pipelines";
            referencedColumns: ["id"];
          },
        ];
      };
      crm_tasks: {
        Row: {
          assigned_to: string | null;
          contact_id: string | null;
          created_at: string;
          created_by: string | null;
          demanda_id: string | null;
          description: string | null;
          due_date: string | null;
          id: string;
          lead_id: string | null;
          organization_id: string;
          priority: string;
          source_kind: string | null;
          status: string;
          title: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          assigned_to?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          demanda_id?: string | null;
          description?: string | null;
          due_date?: string | null;
          id?: string;
          lead_id?: string | null;
          organization_id: string;
          priority?: string;
          source_kind?: string | null;
          status?: string;
          title: string;
          updated_at?: string;
        };
        Update: {
          assigned_to?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          demanda_id?: string | null;
          description?: string | null;
          due_date?: string | null;
          id?: string;
          lead_id?: string | null;
          organization_id?: string;
          priority?: string;
          source_kind?: string | null;
          status?: string;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "crm_tasks_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "crm_tasks_demanda_id_fkey";
            columns: ["demanda_id"];
            isOneToOne: false;
            referencedRelation: "demandas";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "crm_tasks_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "crm_leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "crm_tasks_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      cron_jobs: {
        Row: {
          attempts: number;
          cancel_reason: string | null;
          cancelled_at: string | null;
          contact_id: string;
          created_at: string;
          cron_expr: string | null;
          enabled: boolean;
          id: string;
          interval_ms: number | null;
          job_kind: string;
          kind: string;
          last_error: string | null;
          max_attempts: number;
          next_run_at: string;
          organization_id: string;
          payload: NonNullable<Json>;
          tz: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          attempts?: number;
          cancel_reason?: string | null;
          cancelled_at?: string | null;
          contact_id: string;
          created_at?: string;
          cron_expr?: string | null;
          enabled?: boolean;
          id?: string;
          interval_ms?: number | null;
          job_kind?: string;
          kind: string;
          last_error?: string | null;
          max_attempts?: number;
          next_run_at: string;
          organization_id: string;
          payload?: NonNullable<Json>;
          tz?: string;
          updated_at?: string;
        };
        Update: {
          attempts?: number;
          cancel_reason?: string | null;
          cancelled_at?: string | null;
          contact_id?: string;
          created_at?: string;
          cron_expr?: string | null;
          enabled?: boolean;
          id?: string;
          interval_ms?: number | null;
          job_kind?: string;
          kind?: string;
          last_error?: string | null;
          max_attempts?: number;
          next_run_at?: string;
          organization_id?: string;
          payload?: NonNullable<Json>;
          tz?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "cron_jobs_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "cron_jobs_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      demanda_conversas: {
        Row: {
          conversation_id: string;
          demanda_id: string;
          organization_id: string;
          service_revision: number | null;
          vinculada_em: string;
        };
        ComputedFields: never;
        Insert: {
          conversation_id: string;
          demanda_id: string;
          organization_id: string;
          service_revision?: number | null;
          vinculada_em?: string;
        };
        Update: {
          conversation_id?: string;
          demanda_id?: string;
          organization_id?: string;
          service_revision?: number | null;
          vinculada_em?: string;
        };
        Relationships: [
          {
            foreignKeyName: "demanda_conversas_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "demanda_conversas_demanda_id_fkey";
            columns: ["demanda_id"];
            isOneToOne: false;
            referencedRelation: "demandas";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "demanda_conversas_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      demandas: {
        Row: {
          aberta_em: string;
          agent_case_id: string | null;
          assunto: string | null;
          contact_id: string;
          created_at: string;
          desfecho: string | null;
          dono_kind: string;
          dono_user_id: string | null;
          encerrada_por: string | null;
          estado: string;
          fechada_em: string | null;
          id: string;
          lead_id: string | null;
          organization_id: string;
          origem: string;
          prazo_em: string | null;
          proximo_passo: string | null;
          proximo_passo_em: string | null;
          revision: number;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          aberta_em?: string;
          agent_case_id?: string | null;
          assunto?: string | null;
          contact_id: string;
          created_at?: string;
          desfecho?: string | null;
          dono_kind?: string;
          dono_user_id?: string | null;
          encerrada_por?: string | null;
          estado?: string;
          fechada_em?: string | null;
          id?: string;
          lead_id?: string | null;
          organization_id: string;
          origem?: string;
          prazo_em?: string | null;
          proximo_passo?: string | null;
          proximo_passo_em?: string | null;
          revision?: number;
          updated_at?: string;
        };
        Update: {
          aberta_em?: string;
          agent_case_id?: string | null;
          assunto?: string | null;
          contact_id?: string;
          created_at?: string;
          desfecho?: string | null;
          dono_kind?: string;
          dono_user_id?: string | null;
          encerrada_por?: string | null;
          estado?: string;
          fechada_em?: string | null;
          id?: string;
          lead_id?: string | null;
          organization_id?: string;
          origem?: string;
          prazo_em?: string | null;
          proximo_passo?: string | null;
          proximo_passo_em?: string | null;
          revision?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "demandas_agent_case_id_fkey";
            columns: ["agent_case_id"];
            isOneToOne: false;
            referencedRelation: "agent_cases";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "demandas_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "demandas_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "crm_leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "demandas_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      disclosure_template_pointers: {
        Row: {
          organization_id: string;
          updated_at: string;
          version_id: string;
        };
        ComputedFields: never;
        Insert: {
          organization_id: string;
          updated_at?: string;
          version_id: string;
        };
        Update: {
          organization_id?: string;
          updated_at?: string;
          version_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "disclosure_template_pointers_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "disclosure_template_pointers_version_id_fkey";
            columns: ["version_id"];
            isOneToOne: false;
            referencedRelation: "disclosure_template_versions";
            referencedColumns: ["id"];
          },
        ];
      };
      disclosure_template_versions: {
        Row: {
          body: string;
          created_at: string;
          id: string;
          organization_id: string;
        };
        ComputedFields: never;
        Insert: {
          body: string;
          created_at?: string;
          id?: string;
          organization_id: string;
        };
        Update: {
          body?: string;
          created_at?: string;
          id?: string;
          organization_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "disclosure_template_versions_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      entregas_de_aviso_de_agendamento: {
        Row: {
          appointment_id: string | null;
          channel_session_id: string | null;
          corpo_hash: string | null;
          created_at: string;
          destino: string;
          dia: string | null;
          enviado_em: string | null;
          erro_codigo: string | null;
          event_id: string | null;
          evento: string | null;
          external_id: string | null;
          id: string;
          organization_id: string;
          status: string;
          tentativas: number;
          tipo: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          appointment_id?: string | null;
          channel_session_id?: string | null;
          corpo_hash?: string | null;
          created_at?: string;
          destino: string;
          dia?: string | null;
          enviado_em?: string | null;
          erro_codigo?: string | null;
          event_id?: string | null;
          evento?: string | null;
          external_id?: string | null;
          id?: string;
          organization_id: string;
          status?: string;
          tentativas?: number;
          tipo?: string;
          updated_at?: string;
        };
        Update: {
          appointment_id?: string | null;
          channel_session_id?: string | null;
          corpo_hash?: string | null;
          created_at?: string;
          destino?: string;
          dia?: string | null;
          enviado_em?: string | null;
          erro_codigo?: string | null;
          event_id?: string | null;
          evento?: string | null;
          external_id?: string | null;
          id?: string;
          organization_id?: string;
          status?: string;
          tentativas?: number;
          tipo?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "entregas_de_aviso_de_agendamento_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "calendar_appointments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "entregas_de_aviso_de_agendamento_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "calendar_google_reconcilable_appointments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "entregas_de_aviso_de_agendamento_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "calendar_service_google_candidates";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "entregas_de_aviso_de_agendamento_channel_session_id_fkey";
            columns: ["channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "entregas_de_aviso_de_agendamento_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      entregas_de_aviso_de_caso: {
        Row: {
          case_id: string;
          channel_session_id: string | null;
          corpo_hash: string | null;
          created_at: string;
          destino: string;
          enviado_em: string | null;
          erro_codigo: string | null;
          erro_detalhe: string | null;
          external_id: string | null;
          id: string;
          organization_id: string;
          status: string;
          tentativas: number;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          case_id: string;
          channel_session_id?: string | null;
          corpo_hash?: string | null;
          created_at?: string;
          destino: string;
          enviado_em?: string | null;
          erro_codigo?: string | null;
          erro_detalhe?: string | null;
          external_id?: string | null;
          id?: string;
          organization_id: string;
          status?: string;
          tentativas?: number;
          updated_at?: string;
        };
        Update: {
          case_id?: string;
          channel_session_id?: string | null;
          corpo_hash?: string | null;
          created_at?: string;
          destino?: string;
          enviado_em?: string | null;
          erro_codigo?: string | null;
          erro_detalhe?: string | null;
          external_id?: string | null;
          id?: string;
          organization_id?: string;
          status?: string;
          tentativas?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "entregas_de_aviso_de_caso_case_id_fkey";
            columns: ["case_id"];
            isOneToOne: false;
            referencedRelation: "agent_cases";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "entregas_de_aviso_de_caso_channel_session_id_fkey";
            columns: ["channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "entregas_de_aviso_de_caso_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      event_log: {
        Row: {
          attempts: number;
          consumed_by: string[];
          created_at: string;
          entity_id: string | null;
          entity_kind: string;
          event_type: string;
          id: string;
          last_error: string | null;
          metadata: NonNullable<Json>;
          next_attempt_at: string | null;
          organization_id: string;
          payload: NonNullable<Json>;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          attempts?: number;
          consumed_by?: string[];
          created_at?: string;
          entity_id?: string | null;
          entity_kind: string;
          event_type: string;
          id?: string;
          last_error?: string | null;
          metadata?: NonNullable<Json>;
          next_attempt_at?: string | null;
          organization_id: string;
          payload?: NonNullable<Json>;
          status?: string;
          updated_at?: string;
        };
        Update: {
          attempts?: number;
          consumed_by?: string[];
          created_at?: string;
          entity_id?: string | null;
          entity_kind?: string;
          event_type?: string;
          id?: string;
          last_error?: string | null;
          metadata?: NonNullable<Json>;
          next_attempt_at?: string | null;
          organization_id?: string;
          payload?: NonNullable<Json>;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "event_log_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      event_service_origins: {
        Row: {
          channel_session_id: string;
          event_id: string;
          organization_id: string;
          service_boundary: NonNullable<Json>;
        };
        ComputedFields: never;
        Insert: {
          channel_session_id: string;
          event_id: string;
          organization_id: string;
          service_boundary: NonNullable<Json>;
        };
        Update: {
          channel_session_id?: string;
          event_id?: string;
          organization_id?: string;
          service_boundary?: NonNullable<Json>;
        };
        Relationships: [
          {
            foreignKeyName: "event_service_origins_channel_session_id_fkey";
            columns: ["channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "event_service_origins_event_id_fkey";
            columns: ["event_id"];
            isOneToOne: false;
            referencedRelation: "event_log";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "event_service_origins_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      extension_artifacts: {
        Row: {
          byte_length: number;
          created_at: string;
          document: string;
          id: string;
          manifest: NonNullable<Json>;
          sha256: string;
        };
        ComputedFields: never;
        Insert: {
          byte_length: number;
          created_at?: string;
          document: string;
          id?: string;
          manifest: NonNullable<Json>;
          sha256: string;
        };
        Update: {
          byte_length?: number;
          created_at?: string;
          document?: string;
          id?: string;
          manifest?: NonNullable<Json>;
          sha256?: string;
        };
        Relationships: [];
      };
      extension_catalogs: {
        Row: {
          admitted_at: string;
          admitted_by: string | null;
          digest: string;
          id: string;
          origin: string;
          revision: number;
          snapshot: NonNullable<Json>;
        };
        ComputedFields: never;
        Insert: {
          admitted_at?: string;
          admitted_by?: string | null;
          digest: string;
          id?: string;
          origin: string;
          revision: number;
          snapshot: NonNullable<Json>;
        };
        Update: {
          admitted_at?: string;
          admitted_by?: string | null;
          digest?: string;
          id?: string;
          origin?: string;
          revision?: number;
          snapshot?: NonNullable<Json>;
        };
        Relationships: [];
      };
      extension_installations: {
        Row: {
          artifact_id: string;
          catalog_id: string;
          id: string;
          installed_at: string;
          installed_by: string | null;
          name: string;
          previous_artifact_id: string | null;
          publisher: string;
          removed_at: string | null;
          removed_by: string | null;
          revision: number;
          version: string;
        };
        ComputedFields: never;
        Insert: {
          artifact_id: string;
          catalog_id: string;
          id?: string;
          installed_at?: string;
          installed_by?: string | null;
          name: string;
          previous_artifact_id?: string | null;
          publisher: string;
          removed_at?: string | null;
          removed_by?: string | null;
          revision?: number;
          version: string;
        };
        Update: {
          artifact_id?: string;
          catalog_id?: string;
          id?: string;
          installed_at?: string;
          installed_by?: string | null;
          name?: string;
          previous_artifact_id?: string | null;
          publisher?: string;
          removed_at?: string | null;
          removed_by?: string | null;
          revision?: number;
          version?: string;
        };
        Relationships: [
          {
            foreignKeyName: "extension_installations_artifact_id_fkey";
            columns: ["artifact_id"];
            isOneToOne: false;
            referencedRelation: "extension_artifacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "extension_installations_catalog_id_fkey";
            columns: ["catalog_id"];
            isOneToOne: false;
            referencedRelation: "extension_catalogs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "extension_installations_previous_artifact_id_fkey";
            columns: ["previous_artifact_id"];
            isOneToOne: false;
            referencedRelation: "extension_artifacts";
            referencedColumns: ["id"];
          },
        ];
      };
      extension_operations: {
        Row: {
          actor_id: string | null;
          admission_digest: string | null;
          admission_revision: number | null;
          catalog_id: string | null;
          created_at: string;
          entry: Json | null;
          error_code: string | null;
          id: string;
          installation_id: string | null;
          kind: string;
          name: string | null;
          organization_id: string | null;
          publisher: string | null;
          request: NonNullable<Json>;
          request_fingerprint: string;
          result: Json | null;
          status: string;
          updated_at: string;
          version: string | null;
        };
        ComputedFields: never;
        Insert: {
          actor_id?: string | null;
          admission_digest?: string | null;
          admission_revision?: number | null;
          catalog_id?: string | null;
          created_at?: string;
          entry?: Json | null;
          error_code?: string | null;
          id: string;
          installation_id?: string | null;
          kind: string;
          name?: string | null;
          organization_id?: string | null;
          publisher?: string | null;
          request: NonNullable<Json>;
          request_fingerprint: string;
          result?: Json | null;
          status: string;
          updated_at?: string;
          version?: string | null;
        };
        Update: {
          actor_id?: string | null;
          admission_digest?: string | null;
          admission_revision?: number | null;
          catalog_id?: string | null;
          created_at?: string;
          entry?: Json | null;
          error_code?: string | null;
          id?: string;
          installation_id?: string | null;
          kind?: string;
          name?: string | null;
          organization_id?: string | null;
          publisher?: string | null;
          request?: NonNullable<Json>;
          request_fingerprint?: string;
          result?: Json | null;
          status?: string;
          updated_at?: string;
          version?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "extension_operations_catalog_id_fkey";
            columns: ["catalog_id"];
            isOneToOne: false;
            referencedRelation: "extension_catalogs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "extension_operations_installation_id_fkey";
            columns: ["installation_id"];
            isOneToOne: false;
            referencedRelation: "extension_installations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "extension_operations_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      external_db_connections: {
        Row: {
          created_at: string;
          created_by: string | null;
          customer_key_column: string | null;
          customer_key_kind: string | null;
          database_name: string;
          db_type: string;
          enabled: boolean;
          host: string;
          id: string;
          label: string;
          last_test_aviso: string | null;
          last_test_error: string | null;
          last_test_ok: boolean | null;
          last_tested_at: string | null;
          max_filters: number;
          max_response_bytes: number;
          max_rows: number;
          organization_id: string;
          password_encrypted: string;
          password_iv: string;
          password_tag: string;
          port: number;
          receitas: NonNullable<Json>;
          source_mode: string;
          sources: NonNullable<Json>;
          ssl_mode: string;
          updated_at: string;
          username: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          customer_key_column?: string | null;
          customer_key_kind?: string | null;
          database_name: string;
          db_type?: string;
          enabled?: boolean;
          host: string;
          id?: string;
          label: string;
          last_test_aviso?: string | null;
          last_test_error?: string | null;
          last_test_ok?: boolean | null;
          last_tested_at?: string | null;
          max_filters?: number;
          max_response_bytes?: number;
          max_rows?: number;
          organization_id: string;
          password_encrypted: string;
          password_iv: string;
          password_tag: string;
          port?: number;
          receitas?: NonNullable<Json>;
          source_mode?: string;
          sources?: NonNullable<Json>;
          ssl_mode?: string;
          updated_at?: string;
          username: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          customer_key_column?: string | null;
          customer_key_kind?: string | null;
          database_name?: string;
          db_type?: string;
          enabled?: boolean;
          host?: string;
          id?: string;
          label?: string;
          last_test_aviso?: string | null;
          last_test_error?: string | null;
          last_test_ok?: boolean | null;
          last_tested_at?: string | null;
          max_filters?: number;
          max_response_bytes?: number;
          max_rows?: number;
          organization_id?: string;
          password_encrypted?: string;
          password_iv?: string;
          password_tag?: string;
          port?: number;
          receitas?: NonNullable<Json>;
          source_mode?: string;
          sources?: NonNullable<Json>;
          ssl_mode?: string;
          updated_at?: string;
          username?: string;
        };
        Relationships: [
          {
            foreignKeyName: "external_db_connections_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      financial_accounts: {
        Row: {
          created_at: string;
          currency: string;
          id: string;
          is_active: boolean;
          kind: string;
          name: string;
          opening_balance_cents: number;
          organization_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          currency?: string;
          id?: string;
          is_active?: boolean;
          kind?: string;
          name: string;
          opening_balance_cents?: number;
          organization_id: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          currency?: string;
          id?: string;
          is_active?: boolean;
          kind?: string;
          name?: string;
          opening_balance_cents?: number;
          organization_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "financial_accounts_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      financial_entries: {
        Row: {
          account_id: string;
          account_plan_id: string | null;
          amount_cents: number;
          created_at: string;
          created_by_user_id: string | null;
          currency: string;
          description: string | null;
          direction: string;
          entry_date: string;
          id: string;
          organization_id: string;
          origin: string;
          paid_at: string | null;
          recurring_entry_id: string | null;
          reverses_entry_id: string | null;
          sale_id: string | null;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          account_id: string;
          account_plan_id?: string | null;
          amount_cents: number;
          created_at?: string;
          created_by_user_id?: string | null;
          currency?: string;
          description?: string | null;
          direction: string;
          entry_date?: string;
          id?: string;
          organization_id: string;
          origin?: string;
          paid_at?: string | null;
          recurring_entry_id?: string | null;
          reverses_entry_id?: string | null;
          sale_id?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          account_plan_id?: string | null;
          amount_cents?: number;
          created_at?: string;
          created_by_user_id?: string | null;
          currency?: string;
          description?: string | null;
          direction?: string;
          entry_date?: string;
          id?: string;
          organization_id?: string;
          origin?: string;
          paid_at?: string | null;
          recurring_entry_id?: string | null;
          reverses_entry_id?: string | null;
          sale_id?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "financial_entries_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "financial_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "financial_entries_account_plan_id_fkey";
            columns: ["account_plan_id"];
            isOneToOne: false;
            referencedRelation: "account_plans";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "financial_entries_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "financial_entries_recurring_entry_id_fkey";
            columns: ["recurring_entry_id"];
            isOneToOne: false;
            referencedRelation: "recurring_entries";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "financial_entries_reverses_entry_id_fkey";
            columns: ["reverses_entry_id"];
            isOneToOne: false;
            referencedRelation: "financial_entries";
            referencedColumns: ["id"];
          },
        ];
      };
      flywheel_distiller_proposals: {
        Row: {
          applied_at: string | null;
          applied_by: string | null;
          applied_version_id: string | null;
          content: string;
          dataset: string;
          evidence: NonNullable<Json>;
          id: string;
          organization_id: string;
          proposed_at: string;
          run_id: string;
          target: string;
          type: string;
        };
        ComputedFields: never;
        Insert: {
          applied_at?: string | null;
          applied_by?: string | null;
          applied_version_id?: string | null;
          content: string;
          dataset: string;
          evidence: NonNullable<Json>;
          id?: string;
          organization_id: string;
          proposed_at?: string;
          run_id: string;
          target: string;
          type: string;
        };
        Update: {
          applied_at?: string | null;
          applied_by?: string | null;
          applied_version_id?: string | null;
          content?: string;
          dataset?: string;
          evidence?: NonNullable<Json>;
          id?: string;
          organization_id?: string;
          proposed_at?: string;
          run_id?: string;
          target?: string;
          type?: string;
        };
        Relationships: [
          {
            foreignKeyName: "flywheel_distiller_proposals_applied_version_id_fkey";
            columns: ["applied_version_id"];
            isOneToOne: false;
            referencedRelation: "ai_agent_versions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "flywheel_distiller_proposals_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      flywheel_judge_verdicts: {
        Row: {
          dataset: string;
          dimension: string;
          id: string;
          judge_family: string;
          judged_at: string;
          model: string;
          option_order: string;
          organization_id: string;
          provenance: NonNullable<Json>;
          run_id: string;
          trace_id: string;
          verdict: string;
        };
        ComputedFields: never;
        Insert: {
          dataset: string;
          dimension: string;
          id?: string;
          judge_family: string;
          judged_at?: string;
          model: string;
          option_order: string;
          organization_id: string;
          provenance?: NonNullable<Json>;
          run_id: string;
          trace_id: string;
          verdict: string;
        };
        Update: {
          dataset?: string;
          dimension?: string;
          id?: string;
          judge_family?: string;
          judged_at?: string;
          model?: string;
          option_order?: string;
          organization_id?: string;
          provenance?: NonNullable<Json>;
          run_id?: string;
          trace_id?: string;
          verdict?: string;
        };
        Relationships: [
          {
            foreignKeyName: "flywheel_judge_verdicts_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      followup_enrollment_events: {
        Row: {
          created_at: string;
          enrollment_id: string;
          event_type: string;
          id: string;
          idempotency_key: string | null;
          node_id: string | null;
          organization_id: string;
          payload: NonNullable<Json>;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          enrollment_id: string;
          event_type: string;
          id?: string;
          idempotency_key?: string | null;
          node_id?: string | null;
          organization_id: string;
          payload?: NonNullable<Json>;
        };
        Update: {
          created_at?: string;
          enrollment_id?: string;
          event_type?: string;
          id?: string;
          idempotency_key?: string | null;
          node_id?: string | null;
          organization_id?: string;
          payload?: NonNullable<Json>;
        };
        Relationships: [
          {
            foreignKeyName: "followup_enrollment_events_enrollment_id_fkey";
            columns: ["enrollment_id"];
            isOneToOne: false;
            referencedRelation: "followup_enrollments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "followup_enrollment_events_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      followup_enrollments: {
        Row: {
          agent_id: string | null;
          appointment_id: string | null;
          appointment_revision: number | null;
          attempts: number;
          cancel_reason: string | null;
          claimed_until: string | null;
          completed_at: string | null;
          contact_id: string;
          conversation_id: string | null;
          current_node_id: string;
          id: string;
          last_error: string | null;
          max_attempts: number;
          next_eval_at: string | null;
          organization_id: string;
          outcome: string | null;
          pointer_id: string;
          revision: number;
          service_boundary: Json | null;
          started_at: string;
          status: string;
          steps_taken: number;
          timing_plan: Json | null;
          updated_at: string;
          version_id: string;
        };
        ComputedFields: never;
        Insert: {
          agent_id?: string | null;
          appointment_id?: string | null;
          appointment_revision?: number | null;
          attempts?: number;
          cancel_reason?: string | null;
          claimed_until?: string | null;
          completed_at?: string | null;
          contact_id: string;
          conversation_id?: string | null;
          current_node_id: string;
          id?: string;
          last_error?: string | null;
          max_attempts?: number;
          next_eval_at?: string | null;
          organization_id: string;
          outcome?: string | null;
          pointer_id: string;
          revision?: number;
          service_boundary?: Json | null;
          started_at?: string;
          status?: string;
          steps_taken?: number;
          timing_plan?: Json | null;
          updated_at?: string;
          version_id: string;
        };
        Update: {
          agent_id?: string | null;
          appointment_id?: string | null;
          appointment_revision?: number | null;
          attempts?: number;
          cancel_reason?: string | null;
          claimed_until?: string | null;
          completed_at?: string | null;
          contact_id?: string;
          conversation_id?: string | null;
          current_node_id?: string;
          id?: string;
          last_error?: string | null;
          max_attempts?: number;
          next_eval_at?: string | null;
          organization_id?: string;
          outcome?: string | null;
          pointer_id?: string;
          revision?: number;
          service_boundary?: Json | null;
          started_at?: string;
          status?: string;
          steps_taken?: number;
          timing_plan?: Json | null;
          updated_at?: string;
          version_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "followup_enrollments_agent_id_fkey";
            columns: ["agent_id"];
            isOneToOne: false;
            referencedRelation: "ai_agents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "followup_enrollments_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "calendar_appointments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "followup_enrollments_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "calendar_google_reconcilable_appointments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "followup_enrollments_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "calendar_service_google_candidates";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "followup_enrollments_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "followup_enrollments_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "followup_enrollments_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "followup_enrollments_pointer_id_fkey";
            columns: ["pointer_id"];
            isOneToOne: false;
            referencedRelation: "followup_flow_pointers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "followup_enrollments_version_id_fkey";
            columns: ["version_id"];
            isOneToOne: false;
            referencedRelation: "followup_flow_versions";
            referencedColumns: ["id"];
          },
        ];
      };
      followup_flow_pointers: {
        Row: {
          active_version_id: string | null;
          created_at: string;
          draft_graph: Json | null;
          handoff_policy: string;
          id: string;
          name: string;
          organization_id: string;
          status: string;
          surface: string;
          trigger_config: NonNullable<Json>;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          active_version_id?: string | null;
          created_at?: string;
          draft_graph?: Json | null;
          handoff_policy?: string;
          id?: string;
          name: string;
          organization_id: string;
          status?: string;
          surface?: string;
          trigger_config?: NonNullable<Json>;
          updated_at?: string;
        };
        Update: {
          active_version_id?: string | null;
          created_at?: string;
          draft_graph?: Json | null;
          handoff_policy?: string;
          id?: string;
          name?: string;
          organization_id?: string;
          status?: string;
          surface?: string;
          trigger_config?: NonNullable<Json>;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "followup_flow_pointers_active_version_id_fkey";
            columns: ["active_version_id"];
            isOneToOne: false;
            referencedRelation: "followup_flow_versions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "followup_flow_pointers_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      followup_flow_versions: {
        Row: {
          created_at: string;
          created_by: string | null;
          graph: NonNullable<Json>;
          id: string;
          organization_id: string;
          pointer_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          graph: NonNullable<Json>;
          id?: string;
          organization_id: string;
          pointer_id?: string | null;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          graph?: NonNullable<Json>;
          id?: string;
          organization_id?: string;
          pointer_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "followup_flow_versions_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "followup_flow_versions_pointer_id_fkey";
            columns: ["pointer_id"];
            isOneToOne: false;
            referencedRelation: "followup_flow_pointers";
            referencedColumns: ["id"];
          },
        ];
      };
      golden_candidates: {
        Row: {
          created_at: string;
          estagio_confirmado: string | null;
          estagio_sugerido: string | null;
          fonte: string;
          id: string;
          job_id: string;
          lead_id: string | null;
          motivo: string | null;
          organization_id: string;
          skill: string | null;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          estagio_confirmado?: string | null;
          estagio_sugerido?: string | null;
          fonte: string;
          id?: string;
          job_id: string;
          lead_id?: string | null;
          motivo?: string | null;
          organization_id: string;
          skill?: string | null;
        };
        Update: {
          created_at?: string;
          estagio_confirmado?: string | null;
          estagio_sugerido?: string | null;
          fonte?: string;
          id?: string;
          job_id?: string;
          lead_id?: string | null;
          motivo?: string | null;
          organization_id?: string;
          skill?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "golden_candidates_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      google_ads_click_refs: {
        Row: {
          contact_id: string | null;
          created_at: string;
          gbraid: string | null;
          gclid: string | null;
          id: string;
          matched_at: string | null;
          organization_id: string;
          query_raw: NonNullable<Json>;
          token: string;
          tracking_link_id: string | null;
          wbraid: string | null;
        };
        ComputedFields: never;
        Insert: {
          contact_id?: string | null;
          created_at?: string;
          gbraid?: string | null;
          gclid?: string | null;
          id?: string;
          matched_at?: string | null;
          organization_id: string;
          query_raw?: NonNullable<Json>;
          token: string;
          tracking_link_id?: string | null;
          wbraid?: string | null;
        };
        Update: {
          contact_id?: string | null;
          created_at?: string;
          gbraid?: string | null;
          gclid?: string | null;
          id?: string;
          matched_at?: string | null;
          organization_id?: string;
          query_raw?: NonNullable<Json>;
          token?: string;
          tracking_link_id?: string | null;
          wbraid?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "google_ads_click_refs_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "google_ads_click_refs_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "google_click_tracking_link_org_fk";
            columns: ["organization_id", "tracking_link_id"];
            isOneToOne: false;
            referencedRelation: "ad_tracking_links";
            referencedColumns: ["organization_id", "id"];
          },
        ];
      };
      google_ads_conversion_rules: {
        Row: {
          category: string;
          channel: string;
          configured_at: string;
          created_at: string;
          enabled: boolean;
          event_name: string;
          google_action_id: string;
          id: string;
          included_in_conversions: boolean;
          label: string;
          organization_id: string;
          stage_id: string;
          updated_at: string;
          updated_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          category?: string;
          channel?: string;
          configured_at?: string;
          created_at?: string;
          enabled?: boolean;
          event_name: string;
          google_action_id: string;
          id?: string;
          included_in_conversions?: boolean;
          label: string;
          organization_id: string;
          stage_id: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          category?: string;
          channel?: string;
          configured_at?: string;
          created_at?: string;
          enabled?: boolean;
          event_name?: string;
          google_action_id?: string;
          id?: string;
          included_in_conversions?: boolean;
          label?: string;
          organization_id?: string;
          stage_id?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "google_ads_conversion_rules_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "google_ads_conversion_rules_stage_org_fk";
            columns: ["organization_id", "stage_id"];
            isOneToOne: false;
            referencedRelation: "crm_stages";
            referencedColumns: ["organization_id", "id"];
          },
        ];
      };
      google_ads_landing_pages: {
        Row: {
          created_at: string;
          enabled: boolean;
          message_template: string;
          organization_id: string;
          updated_at: string;
          updated_by: string | null;
          whatsapp_e164: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          enabled?: boolean;
          message_template?: string;
          organization_id: string;
          updated_at?: string;
          updated_by?: string | null;
          whatsapp_e164: string;
        };
        Update: {
          created_at?: string;
          enabled?: boolean;
          message_template?: string;
          organization_id?: string;
          updated_at?: string;
          updated_by?: string | null;
          whatsapp_e164?: string;
        };
        Relationships: [
          {
            foreignKeyName: "google_ads_landing_pages_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: true;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      idempotency_keys: {
        Row: {
          created_at: string;
          endpoint: string;
          expires_at: string;
          id: string;
          key: string;
          organization_id: string;
          request_hash: string;
          response_body: Json | null;
          status_code: number | null;
          tenant_creation_trusted: boolean;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          endpoint: string;
          expires_at?: string;
          id?: string;
          key: string;
          organization_id: string;
          request_hash: string;
          response_body?: Json | null;
          status_code?: number | null;
          tenant_creation_trusted?: boolean;
        };
        Update: {
          created_at?: string;
          endpoint?: string;
          expires_at?: string;
          id?: string;
          key?: string;
          organization_id?: string;
          request_hash?: string;
          response_body?: Json | null;
          status_code?: number | null;
          tenant_creation_trusted?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "idempotency_keys_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      import_batches: {
        Row: {
          column_mapping: NonNullable<Json>;
          completed_at: string | null;
          conflict_rows: number;
          created_at: string;
          created_by: string | null;
          failed_rows: number;
          filename: string;
          id: string;
          kind: string;
          organization_id: string;
          processed_rows: number;
          status: string;
          successful_rows: number;
          total_rows: number;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          column_mapping?: NonNullable<Json>;
          completed_at?: string | null;
          conflict_rows?: number;
          created_at?: string;
          created_by?: string | null;
          failed_rows?: number;
          filename: string;
          id?: string;
          kind?: string;
          organization_id: string;
          processed_rows?: number;
          status?: string;
          successful_rows?: number;
          total_rows?: number;
          updated_at?: string;
        };
        Update: {
          column_mapping?: NonNullable<Json>;
          completed_at?: string | null;
          conflict_rows?: number;
          created_at?: string;
          created_by?: string | null;
          failed_rows?: number;
          filename?: string;
          id?: string;
          kind?: string;
          organization_id?: string;
          processed_rows?: number;
          status?: string;
          successful_rows?: number;
          total_rows?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "import_batches_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      import_rows: {
        Row: {
          batch_id: string;
          company_id: string | null;
          contact_id: string | null;
          created_at: string;
          error: string | null;
          id: string;
          normalized_data: NonNullable<Json>;
          organization_id: string;
          person_id: string | null;
          raw_data: NonNullable<Json>;
          row_number: number;
          status: string;
        };
        ComputedFields: never;
        Insert: {
          batch_id: string;
          company_id?: string | null;
          contact_id?: string | null;
          created_at?: string;
          error?: string | null;
          id?: string;
          normalized_data?: NonNullable<Json>;
          organization_id: string;
          person_id?: string | null;
          raw_data?: NonNullable<Json>;
          row_number: number;
          status?: string;
        };
        Update: {
          batch_id?: string;
          company_id?: string | null;
          contact_id?: string | null;
          created_at?: string;
          error?: string | null;
          id?: string;
          normalized_data?: NonNullable<Json>;
          organization_id?: string;
          person_id?: string | null;
          raw_data?: NonNullable<Json>;
          row_number?: number;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "import_rows_batch_id_fkey";
            columns: ["batch_id"];
            isOneToOne: false;
            referencedRelation: "import_batches";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "import_rows_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "import_rows_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "import_rows_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "import_rows_person_id_fkey";
            columns: ["person_id"];
            isOneToOne: false;
            referencedRelation: "people";
            referencedColumns: ["id"];
          },
        ];
      };
      importacoes_de_historico: {
        Row: {
          channel_session_id: string;
          conversas_feitas: number;
          created_at: string;
          criada_por: string | null;
          cursor: NonNullable<Json>;
          dias: number;
          erro: string | null;
          id: string;
          mensagens_existentes: number;
          mensagens_gravadas: number;
          mensagens_ignoradas: number;
          midias_baixadas: number;
          midias_indisponiveis: number;
          organization_id: string;
          previa: Json | null;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          channel_session_id: string;
          conversas_feitas?: number;
          created_at?: string;
          criada_por?: string | null;
          cursor?: NonNullable<Json>;
          dias: number;
          erro?: string | null;
          id?: string;
          mensagens_existentes?: number;
          mensagens_gravadas?: number;
          mensagens_ignoradas?: number;
          midias_baixadas?: number;
          midias_indisponiveis?: number;
          organization_id: string;
          previa?: Json | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          channel_session_id?: string;
          conversas_feitas?: number;
          created_at?: string;
          criada_por?: string | null;
          cursor?: NonNullable<Json>;
          dias?: number;
          erro?: string | null;
          id?: string;
          mensagens_existentes?: number;
          mensagens_gravadas?: number;
          mensagens_ignoradas?: number;
          midias_baixadas?: number;
          midias_indisponiveis?: number;
          organization_id?: string;
          previa?: Json | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "importacoes_de_historico_channel_session_id_fkey";
            columns: ["channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "importacoes_de_historico_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      incidents: {
        Row: {
          acknowledged_at: string | null;
          acknowledged_by: string | null;
          created_at: string;
          id: string;
          organization_id: string | null;
          payload: NonNullable<Json>;
          resolution_note: string | null;
          resolved_at: string | null;
          resolved_by: string | null;
          severity: string;
          status: string;
          type: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          acknowledged_at?: string | null;
          acknowledged_by?: string | null;
          created_at?: string;
          id?: string;
          organization_id?: string | null;
          payload?: NonNullable<Json>;
          resolution_note?: string | null;
          resolved_at?: string | null;
          resolved_by?: string | null;
          severity: string;
          status?: string;
          type: string;
          updated_at?: string;
        };
        Update: {
          acknowledged_at?: string | null;
          acknowledged_by?: string | null;
          created_at?: string;
          id?: string;
          organization_id?: string | null;
          payload?: NonNullable<Json>;
          resolution_note?: string | null;
          resolved_at?: string | null;
          resolved_by?: string | null;
          severity?: string;
          status?: string;
          type?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "incidents_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      jev_observacoes: {
        Row: {
          concordou: boolean | null;
          confianca_jev: number | null;
          conversation_id: string | null;
          created_at: string;
          estado: string;
          id: string;
          intencao_atual: string | null;
          intencao_jev: string | null;
          job_id: string | null;
          latencia_ms: number | null;
          message_id: string | null;
          modelo: string | null;
          organization_id: string;
          probabilidade_jev: number | null;
          rotulo_atual: string | null;
          rotulo_jev: string | null;
          tarefa: string;
        };
        ComputedFields: never;
        Insert: {
          concordou?: never;
          confianca_jev?: number | null;
          conversation_id?: string | null;
          created_at?: string;
          estado: string;
          id?: string;
          intencao_atual?: string | null;
          intencao_jev?: string | null;
          job_id?: string | null;
          latencia_ms?: number | null;
          message_id?: string | null;
          modelo?: string | null;
          organization_id: string;
          probabilidade_jev?: number | null;
          rotulo_atual?: string | null;
          rotulo_jev?: string | null;
          tarefa: string;
        };
        Update: {
          concordou?: never;
          confianca_jev?: number | null;
          conversation_id?: string | null;
          created_at?: string;
          estado?: string;
          id?: string;
          intencao_atual?: string | null;
          intencao_jev?: string | null;
          job_id?: string | null;
          latencia_ms?: number | null;
          message_id?: string | null;
          modelo?: string | null;
          organization_id?: string;
          probabilidade_jev?: number | null;
          rotulo_atual?: string | null;
          rotulo_jev?: string | null;
          tarefa?: string;
        };
        Relationships: [
          {
            foreignKeyName: "jev_observacoes_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      jev_router_decisions: {
        Row: {
          agent_id_esperado: string | null;
          agent_id_final: string | null;
          confianca_final: number | null;
          context_message_count: number;
          conversation_id: string | null;
          created_at: string;
          custo_incompleto: boolean;
          custo_jev_cents: number | null;
          custo_tradicional_cents: number | null;
          id: string;
          intent_final: string | null;
          intent_jev: string | null;
          intent_tradicional: string | null;
          job_id: string | null;
          message_id: string | null;
          modelo_jev: string | null;
          modo: string;
          motivo_reserva: string | null;
          organization_id: string;
          origem: string;
          revisado_em: string | null;
          revisado_por: string | null;
          revisao: string | null;
          router_id: string;
          tempo_total_ms: number;
        };
        ComputedFields: never;
        Insert: {
          agent_id_esperado?: string | null;
          agent_id_final?: string | null;
          confianca_final?: number | null;
          context_message_count: number;
          conversation_id?: string | null;
          created_at?: string;
          custo_incompleto?: boolean;
          custo_jev_cents?: number | null;
          custo_tradicional_cents?: number | null;
          id?: string;
          intent_final?: string | null;
          intent_jev?: string | null;
          intent_tradicional?: string | null;
          job_id?: string | null;
          message_id?: string | null;
          modelo_jev?: string | null;
          modo: string;
          motivo_reserva?: string | null;
          organization_id: string;
          origem: string;
          revisado_em?: string | null;
          revisado_por?: string | null;
          revisao?: string | null;
          router_id: string;
          tempo_total_ms: number;
        };
        Update: {
          agent_id_esperado?: string | null;
          agent_id_final?: string | null;
          confianca_final?: number | null;
          context_message_count?: number;
          conversation_id?: string | null;
          created_at?: string;
          custo_incompleto?: boolean;
          custo_jev_cents?: number | null;
          custo_tradicional_cents?: number | null;
          id?: string;
          intent_final?: string | null;
          intent_jev?: string | null;
          intent_tradicional?: string | null;
          job_id?: string | null;
          message_id?: string | null;
          modelo_jev?: string | null;
          modo?: string;
          motivo_reserva?: string | null;
          organization_id?: string;
          origem?: string;
          revisado_em?: string | null;
          revisado_por?: string | null;
          revisao?: string | null;
          router_id?: string;
          tempo_total_ms?: number;
        };
        Relationships: [
          {
            foreignKeyName: "jev_router_decisions_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      job_queue: {
        Row: {
          attempts: number;
          catalog_presentation_snapshot: Json | null;
          contact_id: string | null;
          created_at: string;
          id: string;
          kind: string;
          last_error: string | null;
          locked_at: string | null;
          locked_by: string | null;
          max_attempts: number;
          organization_id: string;
          payload: NonNullable<Json>;
          priority: number;
          run_after: string;
          source_event_id: string | null;
          status: string;
        };
        ComputedFields: never;
        Insert: {
          attempts?: number;
          catalog_presentation_snapshot?: Json | null;
          contact_id?: string | null;
          created_at?: string;
          id?: string;
          kind: string;
          last_error?: string | null;
          locked_at?: string | null;
          locked_by?: string | null;
          max_attempts?: number;
          organization_id: string;
          payload?: NonNullable<Json>;
          priority?: number;
          run_after?: string;
          source_event_id?: string | null;
          status?: string;
        };
        Update: {
          attempts?: number;
          catalog_presentation_snapshot?: Json | null;
          contact_id?: string | null;
          created_at?: string;
          id?: string;
          kind?: string;
          last_error?: string | null;
          locked_at?: string | null;
          locked_by?: string | null;
          max_attempts?: number;
          organization_id?: string;
          payload?: NonNullable<Json>;
          priority?: number;
          run_after?: string;
          source_event_id?: string | null;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "job_queue_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_queue_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      judge_alignment_pool: {
        Row: {
          added_at: string;
          dataset: string;
          dimension: string;
          id: string;
          organization_id: string;
          trace_id: string;
        };
        ComputedFields: never;
        Insert: {
          added_at?: string;
          dataset: string;
          dimension: string;
          id?: string;
          organization_id: string;
          trace_id: string;
        };
        Update: {
          added_at?: string;
          dataset?: string;
          dimension?: string;
          id?: string;
          organization_id?: string;
          trace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "judge_alignment_pool_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      knowledge_searches: {
        Row: {
          agent_id: string | null;
          author_kind: string;
          author_user_id: string | null;
          created_at: string;
          hits: number;
          id: string;
          job_id: string | null;
          kb_version_id: string | null;
          knowledge_source_ids: string[];
          organization_id: string;
          threshold: number;
          top_score: number | null;
        };
        ComputedFields: never;
        Insert: {
          agent_id?: string | null;
          author_kind?: string;
          author_user_id?: string | null;
          created_at?: string;
          hits?: number;
          id?: string;
          job_id?: string | null;
          kb_version_id?: string | null;
          knowledge_source_ids?: string[];
          organization_id: string;
          threshold: number;
          top_score?: number | null;
        };
        Update: {
          agent_id?: string | null;
          author_kind?: string;
          author_user_id?: string | null;
          created_at?: string;
          hits?: number;
          id?: string;
          job_id?: string | null;
          kb_version_id?: string | null;
          knowledge_source_ids?: string[];
          organization_id?: string;
          threshold?: number;
          top_score?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "knowledge_searches_agent_id_fkey";
            columns: ["agent_id"];
            isOneToOne: false;
            referencedRelation: "ai_agents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "knowledge_searches_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      lead_checkpoints: {
        Row: {
          commitments: NonNullable<Json>;
          contact_id: string;
          conversation_id: string | null;
          created_at: string;
          declaracao: Json | null;
          demanda_id: string | null;
          demanda_revision: number | null;
          id: string;
          job_id: string | null;
          next_action: string | null;
          objections: NonNullable<Json>;
          organization_id: string;
          rolling_summary: string;
          seq: number;
          service_revision: number | null;
        };
        ComputedFields: never;
        Insert: {
          commitments?: NonNullable<Json>;
          contact_id: string;
          conversation_id?: string | null;
          created_at?: string;
          declaracao?: Json | null;
          demanda_id?: string | null;
          demanda_revision?: number | null;
          id?: string;
          job_id?: string | null;
          next_action?: string | null;
          objections?: NonNullable<Json>;
          organization_id: string;
          rolling_summary?: string;
          seq?: never;
          service_revision?: number | null;
        };
        Update: {
          commitments?: NonNullable<Json>;
          contact_id?: string;
          conversation_id?: string | null;
          created_at?: string;
          declaracao?: Json | null;
          demanda_id?: string | null;
          demanda_revision?: number | null;
          id?: string;
          job_id?: string | null;
          next_action?: string | null;
          objections?: NonNullable<Json>;
          organization_id?: string;
          rolling_summary?: string;
          seq?: never;
          service_revision?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "lead_checkpoints_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lead_checkpoints_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lead_checkpoints_demanda_id_fkey";
            columns: ["demanda_id"];
            isOneToOne: false;
            referencedRelation: "demandas";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lead_checkpoints_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "job_queue";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lead_checkpoints_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      lead_field_proposals: {
        Row: {
          attachment_id: string | null;
          campo: string;
          conversation_id: string | null;
          decided_at: string | null;
          decided_by_user_id: string | null;
          expires_at: string;
          id: string;
          lead_id: string;
          motivo_recusa: string | null;
          organization_id: string;
          proposed_at: string;
          proposed_by_agent_id: string | null;
          status: string;
          trecho: string | null;
          updated_at: string;
          valor_anterior: Json | null;
          valor_proposto: Json | null;
        };
        ComputedFields: never;
        Insert: {
          attachment_id?: string | null;
          campo: string;
          conversation_id?: string | null;
          decided_at?: string | null;
          decided_by_user_id?: string | null;
          expires_at: string;
          id?: string;
          lead_id: string;
          motivo_recusa?: string | null;
          organization_id: string;
          proposed_at?: string;
          proposed_by_agent_id?: string | null;
          status?: string;
          trecho?: string | null;
          updated_at?: string;
          valor_anterior?: Json | null;
          valor_proposto?: Json | null;
        };
        Update: {
          attachment_id?: string | null;
          campo?: string;
          conversation_id?: string | null;
          decided_at?: string | null;
          decided_by_user_id?: string | null;
          expires_at?: string;
          id?: string;
          lead_id?: string;
          motivo_recusa?: string | null;
          organization_id?: string;
          proposed_at?: string;
          proposed_by_agent_id?: string | null;
          status?: string;
          trecho?: string | null;
          updated_at?: string;
          valor_anterior?: Json | null;
          valor_proposto?: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: "lead_field_proposals_attachment_id_fkey";
            columns: ["attachment_id"];
            isOneToOne: false;
            referencedRelation: "crm_lead_attachments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lead_field_proposals_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lead_field_proposals_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "crm_leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lead_field_proposals_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lead_field_proposals_proposed_by_agent_id_fkey";
            columns: ["proposed_by_agent_id"];
            isOneToOne: false;
            referencedRelation: "ai_agents";
            referencedColumns: ["id"];
          },
        ];
      };
      lead_notes: {
        Row: {
          body: string;
          contact_id: string;
          created_at: string;
          embedding: Json | null;
          headline: string;
          id: string;
          organization_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          body: string;
          contact_id: string;
          created_at?: string;
          embedding?: Json | null;
          headline: string;
          id?: string;
          organization_id: string;
          updated_at?: string;
        };
        Update: {
          body?: string;
          contact_id?: string;
          created_at?: string;
          embedding?: Json | null;
          headline?: string;
          id?: string;
          organization_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "lead_notes_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lead_notes_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      lead_state: {
        Row: {
          contact_id: string;
          id: string;
          next_action: string | null;
          next_action_seq: number;
          organization_id: string;
          qualification: NonNullable<Json>;
          stage: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          contact_id: string;
          id?: string;
          next_action?: string | null;
          next_action_seq?: number;
          organization_id: string;
          qualification?: NonNullable<Json>;
          stage?: string;
          updated_at?: string;
        };
        Update: {
          contact_id?: string;
          id?: string;
          next_action?: string | null;
          next_action_seq?: number;
          organization_id?: string;
          qualification?: NonNullable<Json>;
          stage?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "lead_state_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lead_state_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      lead_state_transitions: {
        Row: {
          contact_id: string;
          created_at: string;
          from_stage: string;
          id: string;
          job_id: string | null;
          organization_id: string;
          reason: string | null;
          seq: number;
          to_stage: string;
        };
        ComputedFields: never;
        Insert: {
          contact_id: string;
          created_at?: string;
          from_stage: string;
          id?: string;
          job_id?: string | null;
          organization_id: string;
          reason?: string | null;
          seq?: never;
          to_stage: string;
        };
        Update: {
          contact_id?: string;
          created_at?: string;
          from_stage?: string;
          id?: string;
          job_id?: string | null;
          organization_id?: string;
          reason?: string | null;
          seq?: never;
          to_stage?: string;
        };
        Relationships: [
          {
            foreignKeyName: "lead_state_transitions_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lead_state_transitions_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "job_queue";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lead_state_transitions_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      lgpd_marcas_de_apagamento: {
        Row: {
          created_at: string;
          id: string;
          marca_lid: string | null;
          marca_telefone: string | null;
          organization_id: string;
          sal: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          id?: string;
          marca_lid?: string | null;
          marca_telefone?: string | null;
          organization_id: string;
          sal: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          marca_lid?: string | null;
          marca_telefone?: string | null;
          organization_id?: string;
          sal?: string;
        };
        Relationships: [
          {
            foreignKeyName: "lgpd_marcas_de_apagamento_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      lgpd_requests: {
        Row: {
          attempts: number;
          cascaded_to: Json | null;
          completed_at: string | null;
          contact_id: string | null;
          created_at: string;
          due_at: string;
          emergency: boolean;
          error_message: string | null;
          export_claimed_at: string | null;
          external_customer_id: string | null;
          id: string;
          organization_id: string;
          received_at: string;
          request_payload: NonNullable<Json>;
          request_type: string;
          result: Json | null;
          scope: string;
          source: string;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          attempts?: number;
          cascaded_to?: Json | null;
          completed_at?: string | null;
          contact_id?: string | null;
          created_at?: string;
          due_at: string;
          emergency?: boolean;
          error_message?: string | null;
          export_claimed_at?: string | null;
          external_customer_id?: string | null;
          id?: string;
          organization_id: string;
          received_at?: string;
          request_payload?: NonNullable<Json>;
          request_type: string;
          result?: Json | null;
          scope?: string;
          source: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          attempts?: number;
          cascaded_to?: Json | null;
          completed_at?: string | null;
          contact_id?: string | null;
          created_at?: string;
          due_at?: string;
          emergency?: boolean;
          error_message?: string | null;
          export_claimed_at?: string | null;
          external_customer_id?: string | null;
          id?: string;
          organization_id?: string;
          received_at?: string;
          request_payload?: NonNullable<Json>;
          request_type?: string;
          result?: Json | null;
          scope?: string;
          source?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "lgpd_requests_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lgpd_requests_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      llm_calls: {
        Row: {
          agent_id: string | null;
          cache_read_tokens: number;
          cache_write_tokens: number;
          contact_id: string | null;
          cost_cents: number | null;
          created_at: string;
          error_code: string | null;
          error_message: string | null;
          http_status: number | null;
          id: string;
          input_tokens: number;
          job_id: string | null;
          latency_ms: number | null;
          legacy_invocation_id: string | null;
          model: string;
          organization_id: string;
          origem_da_escolha: string | null;
          output_tokens: number;
          provider: string;
          purpose: string;
          status: string;
          variant_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          agent_id?: string | null;
          cache_read_tokens?: number;
          cache_write_tokens?: number;
          contact_id?: string | null;
          cost_cents?: number | null;
          created_at?: string;
          error_code?: string | null;
          error_message?: string | null;
          http_status?: number | null;
          id?: string;
          input_tokens?: number;
          job_id?: string | null;
          latency_ms?: number | null;
          legacy_invocation_id?: string | null;
          model: string;
          organization_id: string;
          origem_da_escolha?: string | null;
          output_tokens?: number;
          provider: string;
          purpose?: string;
          status?: string;
          variant_id?: string | null;
        };
        Update: {
          agent_id?: string | null;
          cache_read_tokens?: number;
          cache_write_tokens?: number;
          contact_id?: string | null;
          cost_cents?: number | null;
          created_at?: string;
          error_code?: string | null;
          error_message?: string | null;
          http_status?: number | null;
          id?: string;
          input_tokens?: number;
          job_id?: string | null;
          latency_ms?: number | null;
          legacy_invocation_id?: string | null;
          model?: string;
          organization_id?: string;
          origem_da_escolha?: string | null;
          output_tokens?: number;
          provider?: string;
          purpose?: string;
          status?: string;
          variant_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "llm_calls_agent_id_fkey";
            columns: ["agent_id"];
            isOneToOne: false;
            referencedRelation: "ai_agents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "llm_calls_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "llm_calls_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "job_queue";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "llm_calls_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      map_provider_credentials: {
        Row: {
          api_key_encrypted: string;
          api_key_last4: string;
          created_at: string;
          id: string;
          organization_id: string;
          provider: string;
          updated_at: string;
          updated_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          api_key_encrypted: string;
          api_key_last4: string;
          created_at?: string;
          id?: string;
          organization_id: string;
          provider?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          api_key_encrypted?: string;
          api_key_last4?: string;
          created_at?: string;
          id?: string;
          organization_id?: string;
          provider?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "map_provider_credentials_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      merge_queue: {
        Row: {
          candidates: string[];
          created_at: string;
          id: string;
          organization_id: string;
          reason: string;
          resolution: Json | null;
          resolved_at: string | null;
          resolved_by_user_id: string | null;
          status: string;
          trigger_payload: NonNullable<Json>;
        };
        ComputedFields: never;
        Insert: {
          candidates: string[];
          created_at?: string;
          id?: string;
          organization_id: string;
          reason: string;
          resolution?: Json | null;
          resolved_at?: string | null;
          resolved_by_user_id?: string | null;
          status?: string;
          trigger_payload?: NonNullable<Json>;
        };
        Update: {
          candidates?: string[];
          created_at?: string;
          id?: string;
          organization_id?: string;
          reason?: string;
          resolution?: Json | null;
          resolved_at?: string | null;
          resolved_by_user_id?: string | null;
          status?: string;
          trigger_payload?: NonNullable<Json>;
        };
        Relationships: [
          {
            foreignKeyName: "merge_queue_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      message_templates: {
        Row: {
          body: string;
          created_at: string;
          created_by_user_id: string | null;
          id: string;
          midias: NonNullable<Json>;
          mostrar_na_barra: boolean;
          ordem: number;
          organization_id: string;
          owner_user_id: string | null;
          shortcut: string | null;
          title: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          body: string;
          created_at?: string;
          created_by_user_id?: string | null;
          id?: string;
          midias?: NonNullable<Json>;
          mostrar_na_barra?: boolean;
          ordem?: number;
          organization_id: string;
          owner_user_id?: string | null;
          shortcut?: string | null;
          title: string;
          updated_at?: string;
        };
        Update: {
          body?: string;
          created_at?: string;
          created_by_user_id?: string | null;
          id?: string;
          midias?: NonNullable<Json>;
          mostrar_na_barra?: boolean;
          ordem?: number;
          organization_id?: string;
          owner_user_id?: string | null;
          shortcut?: string | null;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "message_templates_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      messages: {
        Row: {
          ack: number | null;
          activity_id: string | null;
          body: string | null;
          channel_session_id: string;
          contact_id: string;
          conversation_id: string;
          created_at: string;
          delivered_at: string | null;
          demanda_id: string | null;
          demanda_revision: number | null;
          direction: string;
          edited_at: string | null;
          error_code: string | null;
          error_message: string | null;
          external_id: string | null;
          id: string;
          media_derived_status: string | null;
          media_derived_text: string | null;
          media_mime: string | null;
          media_size_bytes: number | null;
          media_storage_path: string | null;
          media_url: string | null;
          metadata: NonNullable<Json>;
          organization_id: string;
          read_at: string | null;
          reply_to_message_id: string | null;
          revoked_at: string | null;
          sent_at: string;
          sent_by_user_id: string | null;
          sent_on_behalf_of_user_id: string | null;
          sent_via: string;
          service_revision: number | null;
          status: string;
          template_language: string | null;
          template_name: string | null;
          type: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          ack?: number | null;
          activity_id?: string | null;
          body?: string | null;
          channel_session_id: string;
          contact_id: string;
          conversation_id: string;
          created_at?: string;
          delivered_at?: string | null;
          demanda_id?: string | null;
          demanda_revision?: number | null;
          direction: string;
          edited_at?: string | null;
          error_code?: string | null;
          error_message?: string | null;
          external_id?: string | null;
          id?: string;
          media_derived_status?: string | null;
          media_derived_text?: string | null;
          media_mime?: string | null;
          media_size_bytes?: number | null;
          media_storage_path?: string | null;
          media_url?: string | null;
          metadata?: NonNullable<Json>;
          organization_id: string;
          read_at?: string | null;
          reply_to_message_id?: string | null;
          revoked_at?: string | null;
          sent_at?: string;
          sent_by_user_id?: string | null;
          sent_on_behalf_of_user_id?: string | null;
          sent_via?: string;
          service_revision?: number | null;
          status?: string;
          template_language?: string | null;
          template_name?: string | null;
          type: string;
          updated_at?: string;
        };
        Update: {
          ack?: number | null;
          activity_id?: string | null;
          body?: string | null;
          channel_session_id?: string;
          contact_id?: string;
          conversation_id?: string;
          created_at?: string;
          delivered_at?: string | null;
          demanda_id?: string | null;
          demanda_revision?: number | null;
          direction?: string;
          edited_at?: string | null;
          error_code?: string | null;
          error_message?: string | null;
          external_id?: string | null;
          id?: string;
          media_derived_status?: string | null;
          media_derived_text?: string | null;
          media_mime?: string | null;
          media_size_bytes?: number | null;
          media_storage_path?: string | null;
          media_url?: string | null;
          metadata?: NonNullable<Json>;
          organization_id?: string;
          read_at?: string | null;
          reply_to_message_id?: string | null;
          revoked_at?: string | null;
          sent_at?: string;
          sent_by_user_id?: string | null;
          sent_on_behalf_of_user_id?: string | null;
          sent_via?: string;
          service_revision?: number | null;
          status?: string;
          template_language?: string | null;
          template_name?: string | null;
          type?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "messages_activity_id_fkey";
            columns: ["activity_id"];
            isOneToOne: false;
            referencedRelation: "crm_lead_activities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_channel_session_id_fkey";
            columns: ["channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_demanda_id_fkey";
            columns: ["demanda_id"];
            isOneToOne: false;
            referencedRelation: "demandas";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_reply_to_message_id_fkey";
            columns: ["reply_to_message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
        ];
      };
      meta_ads_click_refs: {
        Row: {
          contact_id: string | null;
          created_at: string;
          id: string;
          matched_at: string | null;
          organization_id: string;
          query_raw: NonNullable<Json>;
          token: string;
          tracking_link_id: string | null;
          utm: NonNullable<Json>;
        };
        ComputedFields: never;
        Insert: {
          contact_id?: string | null;
          created_at?: string;
          id?: string;
          matched_at?: string | null;
          organization_id: string;
          query_raw?: NonNullable<Json>;
          token: string;
          tracking_link_id?: string | null;
          utm: NonNullable<Json>;
        };
        Update: {
          contact_id?: string | null;
          created_at?: string;
          id?: string;
          matched_at?: string | null;
          organization_id?: string;
          query_raw?: NonNullable<Json>;
          token?: string;
          tracking_link_id?: string | null;
          utm?: NonNullable<Json>;
        };
        Relationships: [
          {
            foreignKeyName: "meta_ads_click_refs_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "meta_ads_click_refs_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "meta_click_tracking_link_org_fk";
            columns: ["organization_id", "tracking_link_id"];
            isOneToOne: false;
            referencedRelation: "ad_tracking_links";
            referencedColumns: ["organization_id", "id"];
          },
        ];
      };
      meta_ads_conversion_rules: {
        Row: {
          configured_at: string;
          created_at: string;
          enabled: boolean;
          event_name: string;
          id: string;
          meta_event: string;
          organization_id: string;
          stage_id: string;
          updated_at: string;
          updated_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          configured_at?: string;
          created_at?: string;
          enabled?: boolean;
          event_name: string;
          id?: string;
          meta_event: string;
          organization_id: string;
          stage_id: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          configured_at?: string;
          created_at?: string;
          enabled?: boolean;
          event_name?: string;
          id?: string;
          meta_event?: string;
          organization_id?: string;
          stage_id?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "meta_ads_conversion_rules_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "meta_ads_conversion_rules_stage_org_fk";
            columns: ["organization_id", "stage_id"];
            isOneToOne: false;
            referencedRelation: "crm_stages";
            referencedColumns: ["organization_id", "id"];
          },
        ];
      };
      meta_ads_landing_pages: {
        Row: {
          created_at: string;
          enabled: boolean;
          message_template: string;
          organization_id: string;
          updated_at: string;
          updated_by: string | null;
          whatsapp_e164: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          enabled?: boolean;
          message_template?: string;
          organization_id: string;
          updated_at?: string;
          updated_by?: string | null;
          whatsapp_e164: string;
        };
        Update: {
          created_at?: string;
          enabled?: boolean;
          message_template?: string;
          organization_id?: string;
          updated_at?: string;
          updated_by?: string | null;
          whatsapp_e164?: string;
        };
        Relationships: [
          {
            foreignKeyName: "meta_ads_landing_pages_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: true;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      meta_ctwa_click_dispatches: {
        Row: {
          activation_at_capture: string | null;
          attempted_at: string | null;
          captured_at: string;
          claim_token: string | null;
          claimed_until: string | null;
          contact_id: string;
          created_at: string;
          ctwa_clid: string;
          detail: string | null;
          event_id: string;
          first_message_id: string;
          id: string;
          organization_id: string;
          reason: string | null;
          status: string;
        };
        ComputedFields: never;
        Insert: {
          activation_at_capture?: string | null;
          attempted_at?: string | null;
          captured_at: string;
          claim_token?: string | null;
          claimed_until?: string | null;
          contact_id: string;
          created_at?: string;
          ctwa_clid: string;
          detail?: string | null;
          event_id: string;
          first_message_id: string;
          id?: string;
          organization_id: string;
          reason?: string | null;
          status?: string;
        };
        Update: {
          activation_at_capture?: string | null;
          attempted_at?: string | null;
          captured_at?: string;
          claim_token?: string | null;
          claimed_until?: string | null;
          contact_id?: string;
          created_at?: string;
          ctwa_clid?: string;
          detail?: string | null;
          event_id?: string;
          first_message_id?: string;
          id?: string;
          organization_id?: string;
          reason?: string | null;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "meta_ctwa_click_dispatches_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "meta_ctwa_click_dispatches_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      meta_templates: {
        Row: {
          category: string | null;
          channel_session_id: string | null;
          components: NonNullable<Json>;
          contract_hash: string;
          created_at: string;
          id: string;
          language: string;
          name: string;
          organization_id: string;
          parameter_format: string;
          quality_score: string | null;
          rejected_reason: string | null;
          saved_values: NonNullable<Json>;
          status: string;
          synced_at: string;
          updated_at: string;
          waba_id: string;
        };
        ComputedFields: never;
        Insert: {
          category?: string | null;
          channel_session_id?: string | null;
          components: NonNullable<Json>;
          contract_hash: string;
          created_at?: string;
          id?: string;
          language: string;
          name: string;
          organization_id: string;
          parameter_format?: string;
          quality_score?: string | null;
          rejected_reason?: string | null;
          saved_values?: NonNullable<Json>;
          status: string;
          synced_at?: string;
          updated_at?: string;
          waba_id: string;
        };
        Update: {
          category?: string | null;
          channel_session_id?: string | null;
          components?: NonNullable<Json>;
          contract_hash?: string;
          created_at?: string;
          id?: string;
          language?: string;
          name?: string;
          organization_id?: string;
          parameter_format?: string;
          quality_score?: string | null;
          rejected_reason?: string | null;
          saved_values?: NonNullable<Json>;
          status?: string;
          synced_at?: string;
          updated_at?: string;
          waba_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "meta_templates_channel_session_id_fkey";
            columns: ["channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "meta_templates_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      metrics: {
        Row: {
          created_at: string;
          id: string;
          labels: NonNullable<Json>;
          name: string;
          organization_id: string | null;
          value: number;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          id?: string;
          labels?: NonNullable<Json>;
          name: string;
          organization_id?: string | null;
          value: number;
        };
        Update: {
          created_at?: string;
          id?: string;
          labels?: NonNullable<Json>;
          name?: string;
          organization_id?: string | null;
          value?: number;
        };
        Relationships: [
          {
            foreignKeyName: "metrics_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      mfa_trusted_devices: {
        Row: {
          created_at: string;
          expires_at: string;
          factor_id: string;
          id: string;
          last_used_at: string | null;
          session_id: string | null;
          token_hash: string;
          user_agent: string | null;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          expires_at: string;
          factor_id: string;
          id?: string;
          last_used_at?: string | null;
          session_id?: string | null;
          token_hash: string;
          user_agent?: string | null;
          user_id: string;
        };
        Update: {
          created_at?: string;
          expires_at?: string;
          factor_id?: string;
          id?: string;
          last_used_at?: string | null;
          session_id?: string | null;
          token_hash?: string;
          user_agent?: string | null;
          user_id?: string;
        };
        Relationships: [];
      };
      modulo_secoes_lgpd: {
        Row: {
          colunas: string[];
          colunas_agora: string[];
          colunas_redigidas: string[];
          colunas_rotulo: string[];
          ligacao: string;
          modulo: string;
          tabela: string;
        };
        ComputedFields: never;
        Insert: {
          colunas?: string[];
          colunas_agora?: string[];
          colunas_redigidas?: string[];
          colunas_rotulo?: string[];
          ligacao: string;
          modulo: string;
          tabela: string;
        };
        Update: {
          colunas?: string[];
          colunas_agora?: string[];
          colunas_redigidas?: string[];
          colunas_rotulo?: string[];
          ligacao?: string;
          modulo?: string;
          tabela?: string;
        };
        Relationships: [];
      };
      modulos_instalados: {
        Row: {
          estado: string;
          instalado_em: string;
          instalado_por: string | null;
          modulo: string;
          motivo_suspensao: string | null;
          reaplicado_em: string | null;
        };
        ComputedFields: never;
        Insert: {
          estado?: string;
          instalado_em?: string;
          instalado_por?: string | null;
          modulo: string;
          motivo_suspensao?: string | null;
          reaplicado_em?: string | null;
        };
        Update: {
          estado?: string;
          instalado_em?: string;
          instalado_por?: string | null;
          modulo?: string;
          motivo_suspensao?: string | null;
          reaplicado_em?: string | null;
        };
        Relationships: [];
      };
      nuvemshop_products: {
        Row: {
          available_qty: number;
          created_at: string;
          description: string | null;
          external_id: string;
          id: string;
          image_url: string | null;
          last_updated_at: string;
          organization_id: string;
          payload: NonNullable<Json>;
          price_cents: number;
          rag_chunk_count: number;
          rag_indexed_at: string | null;
          title: string;
          updated_at: string;
          url: string | null;
        };
        ComputedFields: never;
        Insert: {
          available_qty?: number;
          created_at?: string;
          description?: string | null;
          external_id: string;
          id?: string;
          image_url?: string | null;
          last_updated_at: string;
          organization_id: string;
          payload?: NonNullable<Json>;
          price_cents: number;
          rag_chunk_count?: number;
          rag_indexed_at?: string | null;
          title: string;
          updated_at?: string;
          url?: string | null;
        };
        Update: {
          available_qty?: number;
          created_at?: string;
          description?: string | null;
          external_id?: string;
          id?: string;
          image_url?: string | null;
          last_updated_at?: string;
          organization_id?: string;
          payload?: NonNullable<Json>;
          price_cents?: number;
          rag_chunk_count?: number;
          rag_indexed_at?: string | null;
          title?: string;
          updated_at?: string;
          url?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "nuvemshop_products_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      orders: {
        Row: {
          contact_id: string | null;
          created_at: string;
          currency: string;
          customer_external_id: string | null;
          external_id: string;
          external_provider: string;
          fulfillment_status: string | null;
          id: string;
          is_anonymized: boolean;
          ordered_at: string;
          organization_id: string;
          payload: NonNullable<Json>;
          payment_method: string | null;
          status: string;
          total_cents: number;
          tracking_code: string | null;
          updated_at: string;
          updated_at_remote: string | null;
        };
        ComputedFields: never;
        Insert: {
          contact_id?: string | null;
          created_at?: string;
          currency?: string;
          customer_external_id?: string | null;
          external_id: string;
          external_provider: string;
          fulfillment_status?: string | null;
          id?: string;
          is_anonymized?: boolean;
          ordered_at: string;
          organization_id: string;
          payload?: NonNullable<Json>;
          payment_method?: string | null;
          status: string;
          total_cents: number;
          tracking_code?: string | null;
          updated_at?: string;
          updated_at_remote?: string | null;
        };
        Update: {
          contact_id?: string | null;
          created_at?: string;
          currency?: string;
          customer_external_id?: string | null;
          external_id?: string;
          external_provider?: string;
          fulfillment_status?: string | null;
          id?: string;
          is_anonymized?: boolean;
          ordered_at?: string;
          organization_id?: string;
          payload?: NonNullable<Json>;
          payment_method?: string | null;
          status?: string;
          total_cents?: number;
          tracking_code?: string | null;
          updated_at?: string;
          updated_at_remote?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "orders_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "orders_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      org_guardrail_layers: {
        Row: {
          enabled: boolean;
          layer: string;
          organization_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          enabled: boolean;
          layer: string;
          organization_id: string;
          updated_at?: string;
        };
        Update: {
          enabled?: boolean;
          layer?: string;
          organization_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "org_guardrail_layers_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      org_memory_entries: {
        Row: {
          body: string;
          created_at: string;
          created_by: string | null;
          id: string;
          organization_id: string;
          proposal_id: string | null;
          source: string;
          status: string;
          title: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          body: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          organization_id: string;
          proposal_id?: string | null;
          source: string;
          status?: string;
          title: string;
          updated_at?: string;
        };
        Update: {
          body?: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          organization_id?: string;
          proposal_id?: string | null;
          source?: string;
          status?: string;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "org_memory_entries_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "org_memory_entries_proposal_id_fkey";
            columns: ["proposal_id"];
            isOneToOne: false;
            referencedRelation: "flywheel_distiller_proposals";
            referencedColumns: ["id"];
          },
        ];
      };
      org_memory_pointers: {
        Row: {
          organization_id: string;
          updated_at: string;
          version_id: string;
        };
        ComputedFields: never;
        Insert: {
          organization_id: string;
          updated_at?: string;
          version_id: string;
        };
        Update: {
          organization_id?: string;
          updated_at?: string;
          version_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "org_memory_pointers_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: true;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "org_memory_pointers_version_id_fkey";
            columns: ["version_id"];
            isOneToOne: false;
            referencedRelation: "org_memory_versions";
            referencedColumns: ["id"];
          },
        ];
      };
      org_memory_versions: {
        Row: {
          content: string;
          created_at: string;
          created_by: string | null;
          id: string;
          organization_id: string;
          version_number: number;
        };
        ComputedFields: never;
        Insert: {
          content: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          organization_id: string;
          version_number: number;
        };
        Update: {
          content?: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          organization_id?: string;
          version_number?: number;
        };
        Relationships: [
          {
            foreignKeyName: "org_memory_versions_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      org_voice_calls: {
        Row: {
          enabled: boolean;
          organization_id: string;
          risco_aceito_em: string | null;
          risco_aceito_por: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          enabled?: boolean;
          organization_id: string;
          risco_aceito_em?: string | null;
          risco_aceito_por?: string | null;
          updated_at?: string;
        };
        Update: {
          enabled?: boolean;
          organization_id?: string;
          risco_aceito_em?: string | null;
          risco_aceito_por?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "org_voice_calls_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: true;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      organization_extensions: {
        Row: {
          configuration: NonNullable<Json>;
          deactivated_by_removal_at: string | null;
          enabled: boolean;
          installation_id: string;
          organization_id: string;
          revision: number;
          updated_at: string;
          updated_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          configuration: NonNullable<Json>;
          deactivated_by_removal_at?: string | null;
          enabled: boolean;
          installation_id: string;
          organization_id: string;
          revision: number;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          configuration?: NonNullable<Json>;
          deactivated_by_removal_at?: string | null;
          enabled?: boolean;
          installation_id?: string;
          organization_id?: string;
          revision?: number;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "organization_extensions_installation_id_fkey";
            columns: ["installation_id"];
            isOneToOne: false;
            referencedRelation: "extension_installations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "organization_extensions_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      organizations: {
        Row: {
          cnpj: string | null;
          country: string | null;
          created_at: string;
          created_by: string | null;
          currency: string;
          display_name: string;
          dpo_email: string | null;
          id: string;
          interface_settings: NonNullable<Json>;
          legal_name: string;
          lembrete_caso_intervalo_horas: number;
          lembrete_caso_ligado: boolean;
          lembrete_caso_teto: number;
          locale: string;
          mcp_externo_chave_encrypted: string | null;
          mcp_externo_chave_iv: string | null;
          mcp_externo_chave_last4: string | null;
          mcp_externo_chave_tag: string | null;
          media_retention_days: number;
          media_retention_enforced: boolean;
          meta_lead_birth_enabled_at: string | null;
          onboarded_at: string | null;
          onboarding_state: NonNullable<Json>;
          privacy_policy_url: string | null;
          redacted_at: string | null;
          settings: NonNullable<Json>;
          slug: string;
          status: string;
          suspended_at: string | null;
          suspended_by: string | null;
          suspended_kind: string | null;
          suspended_reason: string | null;
          timezone: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          cnpj?: string | null;
          country?: string | null;
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          display_name: string;
          dpo_email?: string | null;
          id?: string;
          interface_settings?: NonNullable<Json>;
          legal_name: string;
          lembrete_caso_intervalo_horas?: number;
          lembrete_caso_ligado?: boolean;
          lembrete_caso_teto?: number;
          locale?: string;
          mcp_externo_chave_encrypted?: string | null;
          mcp_externo_chave_iv?: string | null;
          mcp_externo_chave_last4?: string | null;
          mcp_externo_chave_tag?: string | null;
          media_retention_days?: number;
          media_retention_enforced?: boolean;
          meta_lead_birth_enabled_at?: string | null;
          onboarded_at?: string | null;
          onboarding_state?: NonNullable<Json>;
          privacy_policy_url?: string | null;
          redacted_at?: string | null;
          settings?: NonNullable<Json>;
          slug: string;
          status?: string;
          suspended_at?: string | null;
          suspended_by?: string | null;
          suspended_kind?: string | null;
          suspended_reason?: string | null;
          timezone?: string;
          updated_at?: string;
        };
        Update: {
          cnpj?: string | null;
          country?: string | null;
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          display_name?: string;
          dpo_email?: string | null;
          id?: string;
          interface_settings?: NonNullable<Json>;
          legal_name?: string;
          lembrete_caso_intervalo_horas?: number;
          lembrete_caso_ligado?: boolean;
          lembrete_caso_teto?: number;
          locale?: string;
          mcp_externo_chave_encrypted?: string | null;
          mcp_externo_chave_iv?: string | null;
          mcp_externo_chave_last4?: string | null;
          mcp_externo_chave_tag?: string | null;
          media_retention_days?: number;
          media_retention_enforced?: boolean;
          meta_lead_birth_enabled_at?: string | null;
          onboarded_at?: string | null;
          onboarding_state?: NonNullable<Json>;
          privacy_policy_url?: string | null;
          redacted_at?: string | null;
          settings?: NonNullable<Json>;
          slug?: string;
          status?: string;
          suspended_at?: string | null;
          suspended_by?: string | null;
          suspended_kind?: string | null;
          suspended_reason?: string | null;
          timezone?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      outbound_copies: {
        Row: {
          channel_session_id: string;
          id: string;
          normalized_hash: string;
          normalized_text: string;
          organization_id: string;
          sent_at: string;
        };
        ComputedFields: never;
        Insert: {
          channel_session_id: string;
          id?: string;
          normalized_hash: string;
          normalized_text: string;
          organization_id: string;
          sent_at?: string;
        };
        Update: {
          channel_session_id?: string;
          id?: string;
          normalized_hash?: string;
          normalized_text?: string;
          organization_id?: string;
          sent_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "outbound_copies_channel_session_id_fkey";
            columns: ["channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "outbound_copies_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      pacing_ledger: {
        Row: {
          channel_session_id: string;
          id: string;
          organization_id: string;
          sent_at: string;
        };
        ComputedFields: never;
        Insert: {
          channel_session_id: string;
          id?: string;
          organization_id: string;
          sent_at?: string;
        };
        Update: {
          channel_session_id?: string;
          id?: string;
          organization_id?: string;
          sent_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "pacing_ledger_channel_session_id_fkey";
            columns: ["channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "pacing_ledger_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      passagens_de_atendimento: {
        Row: {
          aviso_motivo_codigo: string | null;
          body: string;
          caso_id: string | null;
          cliente_avisado: boolean | null;
          cobrancas: number;
          contact_id: string;
          content: string | null;
          conversation_id: string;
          criado_em: string;
          id: string;
          motivo_codigo: string;
          motor: string;
          notes: string | null;
          organization_id: string;
          origem: string;
          reconhecido_em: string | null;
          reconhecido_por: string | null;
          tentativas: NonNullable<Json>;
          title: string | null;
        };
        ComputedFields: never;
        Insert: {
          aviso_motivo_codigo?: string | null;
          body: string;
          caso_id?: string | null;
          cliente_avisado?: boolean | null;
          cobrancas?: number;
          contact_id: string;
          content?: string | null;
          conversation_id: string;
          criado_em?: string;
          id?: string;
          motivo_codigo: string;
          motor: string;
          notes?: string | null;
          organization_id: string;
          origem: string;
          reconhecido_em?: string | null;
          reconhecido_por?: string | null;
          tentativas?: NonNullable<Json>;
          title?: string | null;
        };
        Update: {
          aviso_motivo_codigo?: string | null;
          body?: string;
          caso_id?: string | null;
          cliente_avisado?: boolean | null;
          cobrancas?: number;
          contact_id?: string;
          content?: string | null;
          conversation_id?: string;
          criado_em?: string;
          id?: string;
          motivo_codigo?: string;
          motor?: string;
          notes?: string | null;
          organization_id?: string;
          origem?: string;
          reconhecido_em?: string | null;
          reconhecido_por?: string | null;
          tentativas?: NonNullable<Json>;
          title?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "passagens_de_atendimento_caso_id_fkey";
            columns: ["caso_id"];
            isOneToOne: false;
            referencedRelation: "agent_cases";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "passagens_de_atendimento_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "passagens_de_atendimento_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "passagens_de_atendimento_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      payment_methods: {
        Row: {
          account_id: string | null;
          created_at: string;
          id: string;
          is_active: boolean;
          name: string;
          organization_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          account_id?: string | null;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          name: string;
          organization_id: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string | null;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          name?: string;
          organization_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "payment_methods_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "financial_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "payment_methods_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      people: {
        Row: {
          created_at: string;
          created_by: string | null;
          email: string | null;
          full_name: string;
          id: string;
          normalized_name: string | null;
          notes: string | null;
          organization_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          email?: string | null;
          full_name: string;
          id?: string;
          normalized_name?: string | null;
          notes?: string | null;
          organization_id: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          email?: string | null;
          full_name?: string;
          id?: string;
          normalized_name?: string | null;
          notes?: string | null;
          organization_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "people_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      phone_numbers: {
        Row: {
          created_at: string;
          default_ai_agent_id: string | null;
          fallback_user_id: string | null;
          id: string;
          is_active: boolean;
          label: string | null;
          number: string;
          organization_id: string;
          routing_mode: string;
          trunk_endpoint: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          default_ai_agent_id?: string | null;
          fallback_user_id?: string | null;
          id?: string;
          is_active?: boolean;
          label?: string | null;
          number: string;
          organization_id: string;
          routing_mode?: string;
          trunk_endpoint: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          default_ai_agent_id?: string | null;
          fallback_user_id?: string | null;
          id?: string;
          is_active?: boolean;
          label?: string | null;
          number?: string;
          organization_id?: string;
          routing_mode?: string;
          trunk_endpoint?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "phone_numbers_default_ai_agent_id_fkey";
            columns: ["default_ai_agent_id"];
            isOneToOne: false;
            referencedRelation: "ai_agents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "phone_numbers_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      platform_admins: {
        Row: {
          granted_at: string;
          granted_by: string;
          mfa_required: boolean;
          reason: string;
          revoke_reason: string | null;
          revoked_at: string | null;
          revoked_by: string | null;
          scope: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          granted_at?: string;
          granted_by: string;
          mfa_required?: boolean;
          reason: string;
          revoke_reason?: string | null;
          revoked_at?: string | null;
          revoked_by?: string | null;
          scope?: string;
          user_id: string;
        };
        Update: {
          granted_at?: string;
          granted_by?: string;
          mfa_required?: boolean;
          reason?: string;
          revoke_reason?: string | null;
          revoked_at?: string | null;
          revoked_by?: string | null;
          scope?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      platform_branding: {
        Row: {
          accent_dark_hex: string | null;
          accent_hex: string | null;
          app_name: string | null;
          fallback_at: string | null;
          fallback_reason: string | null;
          favicon_path: string | null;
          id: number;
          logo_dark_path: string | null;
          logo_path: string | null;
          logo_url: string | null;
          seeded_from_env: boolean;
          show_powered_by: boolean;
          updated_at: string;
          updated_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          accent_dark_hex?: string | null;
          accent_hex?: string | null;
          app_name?: string | null;
          fallback_at?: string | null;
          fallback_reason?: string | null;
          favicon_path?: string | null;
          id?: number;
          logo_dark_path?: string | null;
          logo_path?: string | null;
          logo_url?: string | null;
          seeded_from_env?: boolean;
          show_powered_by?: boolean;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          accent_dark_hex?: string | null;
          accent_hex?: string | null;
          app_name?: string | null;
          fallback_at?: string | null;
          fallback_reason?: string | null;
          favicon_path?: string | null;
          id?: number;
          logo_dark_path?: string | null;
          logo_path?: string | null;
          logo_url?: string | null;
          seeded_from_env?: boolean;
          show_powered_by?: boolean;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };
      platform_config: {
        Row: {
          chave: string;
          ciphertext: string | null;
          eh_segredo: boolean;
          iv: string | null;
          last4: string | null;
          semeado_do_env: boolean;
          tag: string | null;
          updated_at: string;
          updated_by: string | null;
          valor: string | null;
        };
        ComputedFields: never;
        Insert: {
          chave: string;
          ciphertext?: string | null;
          eh_segredo?: boolean;
          iv?: string | null;
          last4?: string | null;
          semeado_do_env?: boolean;
          tag?: string | null;
          updated_at?: string;
          updated_by?: string | null;
          valor?: string | null;
        };
        Update: {
          chave?: string;
          ciphertext?: string | null;
          eh_segredo?: boolean;
          iv?: string | null;
          last4?: string | null;
          semeado_do_env?: boolean;
          tag?: string | null;
          updated_at?: string;
          updated_by?: string | null;
          valor?: string | null;
        };
        Relationships: [];
      };
      platform_google_oauth: {
        Row: {
          client_id: string | null;
          client_secret_encrypted: string | null;
          id: number;
          updated_at: string;
          updated_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          client_id?: string | null;
          client_secret_encrypted?: string | null;
          id?: number;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          client_id?: string | null;
          client_secret_encrypted?: string | null;
          id?: number;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };
      platform_meta_app: {
        Row: {
          app_secret_encrypted: string | null;
          id: number;
          updated_at: string;
          updated_by: string | null;
          verify_token_created_at: string | null;
          verify_token_encrypted: string | null;
        };
        ComputedFields: never;
        Insert: {
          app_secret_encrypted?: string | null;
          id?: number;
          updated_at?: string;
          updated_by?: string | null;
          verify_token_created_at?: string | null;
          verify_token_encrypted?: string | null;
        };
        Update: {
          app_secret_encrypted?: string | null;
          id?: number;
          updated_at?: string;
          updated_by?: string | null;
          verify_token_created_at?: string | null;
          verify_token_encrypted?: string | null;
        };
        Relationships: [];
      };
      platform_settings: {
        Row: {
          divulgacao_de_pagamento: string | null;
          exigir_assinatura_no_webhook: boolean | null;
          id: number;
          internal_destinations: string[] | null;
          orcamento_de_ia: string | null;
          promessa_semantica: boolean | null;
          signup_mode: string;
          updated_at: string;
          updated_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          divulgacao_de_pagamento?: string | null;
          exigir_assinatura_no_webhook?: boolean | null;
          id?: number;
          internal_destinations?: string[] | null;
          orcamento_de_ia?: string | null;
          promessa_semantica?: boolean | null;
          signup_mode?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          divulgacao_de_pagamento?: string | null;
          exigir_assinatura_no_webhook?: boolean | null;
          id?: number;
          internal_destinations?: string[] | null;
          orcamento_de_ia?: string | null;
          promessa_semantica?: boolean | null;
          signup_mode?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };
      platform_smtp_settings: {
        Row: {
          from_email: string | null;
          from_name: string | null;
          id: number;
          smtp_host: string | null;
          smtp_password_encrypted: string | null;
          smtp_port: number;
          smtp_security: string;
          smtp_username: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          from_email?: string | null;
          from_name?: string | null;
          id?: number;
          smtp_host?: string | null;
          smtp_password_encrypted?: string | null;
          smtp_port?: number;
          smtp_security?: string;
          smtp_username?: string | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          from_email?: string | null;
          from_name?: string | null;
          id?: number;
          smtp_host?: string | null;
          smtp_password_encrypted?: string | null;
          smtp_port?: number;
          smtp_security?: string;
          smtp_username?: string | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };
      platform_support_sessions: {
        Row: {
          access_mode: string;
          actor_user_id: string;
          auth_session_id: string;
          created_at: string;
          ended_at: string | null;
          expires_at: string;
          id: string;
          organization_id: string;
          previous_organization_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          access_mode: string;
          actor_user_id: string;
          auth_session_id: string;
          created_at?: string;
          ended_at?: string | null;
          expires_at: string;
          id?: string;
          organization_id: string;
          previous_organization_id?: string | null;
        };
        Update: {
          access_mode?: string;
          actor_user_id?: string;
          auth_session_id?: string;
          created_at?: string;
          ended_at?: string | null;
          expires_at?: string;
          id?: string;
          organization_id?: string;
          previous_organization_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "platform_support_sessions_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "platform_support_sessions_previous_organization_id_fkey";
            columns: ["previous_organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      playbook_pointers: {
        Row: {
          layer: string;
          organization_id: string | null;
          updated_at: string;
          version_id: string;
        };
        ComputedFields: never;
        Insert: {
          layer: string;
          organization_id?: string | null;
          updated_at?: string;
          version_id: string;
        };
        Update: {
          layer?: string;
          organization_id?: string | null;
          updated_at?: string;
          version_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "playbook_pointers_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "playbook_pointers_version_id_fkey";
            columns: ["version_id"];
            isOneToOne: false;
            referencedRelation: "playbook_versions";
            referencedColumns: ["id"];
          },
        ];
      };
      playbook_versions: {
        Row: {
          content: string;
          created_at: string;
          id: string;
          layer: string;
          organization_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          content: string;
          created_at?: string;
          id?: string;
          layer: string;
          organization_id?: string | null;
        };
        Update: {
          content?: string;
          created_at?: string;
          id?: string;
          layer?: string;
          organization_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "playbook_versions_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      promise_table_pointers: {
        Row: {
          organization_id: string;
          updated_at: string;
          version_id: string;
        };
        ComputedFields: never;
        Insert: {
          organization_id: string;
          updated_at?: string;
          version_id: string;
        };
        Update: {
          organization_id?: string;
          updated_at?: string;
          version_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "promise_table_pointers_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "promise_table_pointers_version_id_fkey";
            columns: ["version_id"];
            isOneToOne: false;
            referencedRelation: "promise_table_versions";
            referencedColumns: ["id"];
          },
        ];
      };
      promise_table_versions: {
        Row: {
          created_at: string;
          id: string;
          organization_id: string;
          values: NonNullable<Json>;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          id?: string;
          organization_id: string;
          values: NonNullable<Json>;
        };
        Update: {
          created_at?: string;
          id?: string;
          organization_id?: string;
          values?: NonNullable<Json>;
        };
        Relationships: [
          {
            foreignKeyName: "promise_table_versions_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      proposal_templates: {
        Row: {
          base_slug: string | null;
          base_version: number | null;
          created_at: string;
          descricao: string | null;
          id: string;
          is_active: boolean;
          nome: string | null;
          organization_id: string;
          section_order: string[];
          sections: NonNullable<Json>;
          slug: string;
          updated_at: string;
          version: number;
        };
        ComputedFields: never;
        Insert: {
          base_slug?: string | null;
          base_version?: number | null;
          created_at?: string;
          descricao?: string | null;
          id?: string;
          is_active?: boolean;
          nome?: string | null;
          organization_id: string;
          section_order?: string[];
          sections?: NonNullable<Json>;
          slug: string;
          updated_at?: string;
          version?: number;
        };
        Update: {
          base_slug?: string | null;
          base_version?: number | null;
          created_at?: string;
          descricao?: string | null;
          id?: string;
          is_active?: boolean;
          nome?: string | null;
          organization_id?: string;
          section_order?: string[];
          sections?: NonNullable<Json>;
          slug?: string;
          updated_at?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "proposal_templates_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      prospecting_campaigns: {
        Row: {
          agent_setup: NonNullable<Json>;
          agent_setup_revision: number;
          channel_down_since: string | null;
          config: Json | null;
          cost_usd: number | null;
          created_at: string;
          dataset_id: string | null;
          error: string | null;
          id: string;
          name: string;
          next_send_at: string;
          organization_id: string;
          request_id: string;
          result_count: number;
          run_id: string | null;
          search: NonNullable<Json>;
          search_status: string;
          skipped_count: number;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          agent_setup?: NonNullable<Json>;
          agent_setup_revision?: number;
          channel_down_since?: string | null;
          config?: Json | null;
          cost_usd?: number | null;
          created_at?: string;
          dataset_id?: string | null;
          error?: string | null;
          id?: string;
          name: string;
          next_send_at?: string;
          organization_id: string;
          request_id: string;
          result_count?: number;
          run_id?: string | null;
          search: NonNullable<Json>;
          search_status?: string;
          skipped_count?: number;
          status?: string;
          updated_at?: string;
        };
        Update: {
          agent_setup?: NonNullable<Json>;
          agent_setup_revision?: number;
          channel_down_since?: string | null;
          config?: Json | null;
          cost_usd?: number | null;
          created_at?: string;
          dataset_id?: string | null;
          error?: string | null;
          id?: string;
          name?: string;
          next_send_at?: string;
          organization_id?: string;
          request_id?: string;
          result_count?: number;
          run_id?: string | null;
          search?: NonNullable<Json>;
          search_status?: string;
          skipped_count?: number;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "prospecting_campaigns_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      prospecting_candidates: {
        Row: {
          attempted_at: string | null;
          automatic_sends: number;
          campaign_id: string;
          contact_id: string | null;
          conversation_id: string | null;
          created_at: string;
          data: NonNullable<Json>;
          error: string | null;
          exit_offer_message_id: string | null;
          exit_offered_at: string | null;
          id: string;
          lead_id: string | null;
          message_id: string;
          organization_id: string;
          phone: string | null;
          place_id: string;
          selected: boolean;
          service_boundary: Json | null;
          status: string;
          suppression_phone: string | null;
          suppression_place: string | null;
          suppression_salt: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          attempted_at?: string | null;
          automatic_sends?: number;
          campaign_id: string;
          contact_id?: string | null;
          conversation_id?: string | null;
          created_at?: string;
          data: NonNullable<Json>;
          error?: string | null;
          exit_offer_message_id?: string | null;
          exit_offered_at?: string | null;
          id?: string;
          lead_id?: string | null;
          message_id?: string;
          organization_id: string;
          phone?: string | null;
          place_id: string;
          selected?: boolean;
          service_boundary?: Json | null;
          status?: string;
          suppression_phone?: string | null;
          suppression_place?: string | null;
          suppression_salt?: string | null;
          updated_at?: string;
        };
        Update: {
          attempted_at?: string | null;
          automatic_sends?: number;
          campaign_id?: string;
          contact_id?: string | null;
          conversation_id?: string | null;
          created_at?: string;
          data?: NonNullable<Json>;
          error?: string | null;
          exit_offer_message_id?: string | null;
          exit_offered_at?: string | null;
          id?: string;
          lead_id?: string | null;
          message_id?: string;
          organization_id?: string;
          phone?: string | null;
          place_id?: string;
          selected?: boolean;
          service_boundary?: Json | null;
          status?: string;
          suppression_phone?: string | null;
          suppression_place?: string | null;
          suppression_salt?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "prospecting_candidates_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "prospecting_candidates_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "prospecting_candidates_exit_offer_message_id_fkey";
            columns: ["exit_offer_message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "prospecting_candidates_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "crm_leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "prospecting_candidates_organization_id_campaign_id_fkey";
            columns: ["organization_id", "campaign_id"];
            isOneToOne: false;
            referencedRelation: "prospecting_campaigns";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "prospecting_candidates_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      prospecting_settings: {
        Row: {
          credential_encrypted: string;
          organization_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          credential_encrypted: string;
          organization_id: string;
          updated_at?: string;
        };
        Update: {
          credential_encrypted?: string;
          organization_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "prospecting_settings_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: true;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      push_subscriptions: {
        Row: {
          auth: string;
          created_at: string;
          endpoint: string;
          id: string;
          organization_id: string;
          p256dh: string;
          updated_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          auth: string;
          created_at?: string;
          endpoint: string;
          id?: string;
          organization_id: string;
          p256dh: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          auth?: string;
          created_at?: string;
          endpoint?: string;
          id?: string;
          organization_id?: string;
          p256dh?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "push_subscriptions_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      recurring_entries: {
        Row: {
          account_id: string;
          account_plan_id: string | null;
          amount_cents: number;
          created_at: string;
          created_by_user_id: string | null;
          currency: string;
          day_of_month: number;
          direction: string;
          id: string;
          is_active: boolean;
          name: string;
          organization_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          account_id: string;
          account_plan_id?: string | null;
          amount_cents: number;
          created_at?: string;
          created_by_user_id?: string | null;
          currency?: string;
          day_of_month: number;
          direction: string;
          id?: string;
          is_active?: boolean;
          name: string;
          organization_id: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          account_plan_id?: string | null;
          amount_cents?: number;
          created_at?: string;
          created_by_user_id?: string | null;
          currency?: string;
          day_of_month?: number;
          direction?: string;
          id?: string;
          is_active?: boolean;
          name?: string;
          organization_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "recurring_entries_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "financial_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "recurring_entries_account_plan_id_fkey";
            columns: ["account_plan_id"];
            isOneToOne: false;
            referencedRelation: "account_plans";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "recurring_entries_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      reentry_knob_pointers: {
        Row: {
          organization_id: string;
          updated_at: string;
          version_id: string;
        };
        ComputedFields: never;
        Insert: {
          organization_id: string;
          updated_at?: string;
          version_id: string;
        };
        Update: {
          organization_id?: string;
          updated_at?: string;
          version_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "reentry_knob_pointers_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: true;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "reentry_knob_pointers_version_id_fkey";
            columns: ["version_id"];
            isOneToOne: false;
            referencedRelation: "reentry_knob_versions";
            referencedColumns: ["id"];
          },
        ];
      };
      reentry_knob_versions: {
        Row: {
          created_at: string;
          id: string;
          knobs: NonNullable<Json>;
          organization_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          id?: string;
          knobs: NonNullable<Json>;
          organization_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          knobs?: NonNullable<Json>;
          organization_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "reentry_knob_versions_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      reentry_template_pointers: {
        Row: {
          organization_id: string;
          updated_at: string;
          version_id: string;
        };
        ComputedFields: never;
        Insert: {
          organization_id: string;
          updated_at?: string;
          version_id: string;
        };
        Update: {
          organization_id?: string;
          updated_at?: string;
          version_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "reentry_template_pointers_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: true;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "reentry_template_pointers_version_id_fkey";
            columns: ["version_id"];
            isOneToOne: false;
            referencedRelation: "reentry_template_versions";
            referencedColumns: ["id"];
          },
        ];
      };
      reentry_template_versions: {
        Row: {
          created_at: string;
          id: string;
          organization_id: string;
          variants: string[];
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          id?: string;
          organization_id: string;
          variants: string[];
        };
        Update: {
          created_at?: string;
          id?: string;
          organization_id?: string;
          variants?: string[];
        };
        Relationships: [
          {
            foreignKeyName: "reentry_template_versions_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      registration_requests: {
        Row: {
          created_at: string;
          decided_at: string | null;
          decided_by: string | null;
          id: string;
          requested_organization_name: string;
          status: string;
          updated_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          decided_at?: string | null;
          decided_by?: string | null;
          id?: string;
          requested_organization_name: string;
          status?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          decided_at?: string | null;
          decided_by?: string | null;
          id?: string;
          requested_organization_name?: string;
          status?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      send_ledger: {
        Row: {
          body_hash: string;
          contact_id: string | null;
          created_at: string;
          crm_message_id: string | null;
          id: string;
          job_id: string;
          last_error: string | null;
          organization_id: string;
          seq: number;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          body_hash: string;
          contact_id?: string | null;
          created_at?: string;
          crm_message_id?: string | null;
          id?: string;
          job_id: string;
          last_error?: string | null;
          organization_id: string;
          seq: number;
          status?: string;
          updated_at?: string;
        };
        Update: {
          body_hash?: string;
          contact_id?: string | null;
          created_at?: string;
          crm_message_id?: string | null;
          id?: string;
          job_id?: string;
          last_error?: string | null;
          organization_id?: string;
          seq?: number;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "send_ledger_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "send_ledger_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "job_queue";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "send_ledger_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      skill_activations: {
        Row: {
          created_at: string;
          id: string;
          job_id: string | null;
          organization_id: string;
          skill_name: string;
          skill_version_id: string | null;
          trigger: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          id?: string;
          job_id?: string | null;
          organization_id: string;
          skill_name: string;
          skill_version_id?: string | null;
          trigger: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          job_id?: string | null;
          organization_id?: string;
          skill_name?: string;
          skill_version_id?: string | null;
          trigger?: string;
        };
        Relationships: [
          {
            foreignKeyName: "skill_activations_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "skill_activations_skill_version_id_fkey";
            columns: ["skill_version_id"];
            isOneToOne: false;
            referencedRelation: "skill_versions";
            referencedColumns: ["id"];
          },
        ];
      };
      skill_pointers: {
        Row: {
          name: string;
          organization_id: string | null;
          updated_at: string;
          version_id: string;
        };
        ComputedFields: never;
        Insert: {
          name: string;
          organization_id?: string | null;
          updated_at?: string;
          version_id: string;
        };
        Update: {
          name?: string;
          organization_id?: string | null;
          updated_at?: string;
          version_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "skill_pointers_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "skill_pointers_version_id_fkey";
            columns: ["version_id"];
            isOneToOne: false;
            referencedRelation: "skill_versions";
            referencedColumns: ["id"];
          },
        ];
      };
      skill_versions: {
        Row: {
          body: string;
          created_at: string;
          description: string;
          forked_from_version_id: string | null;
          id: string;
          manifest: NonNullable<Json>;
          matcher: NonNullable<Json>;
          name: string;
          organization_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          body: string;
          created_at?: string;
          description: string;
          forked_from_version_id?: string | null;
          id?: string;
          manifest?: NonNullable<Json>;
          matcher?: NonNullable<Json>;
          name: string;
          organization_id?: string | null;
        };
        Update: {
          body?: string;
          created_at?: string;
          description?: string;
          forked_from_version_id?: string | null;
          id?: string;
          manifest?: NonNullable<Json>;
          matcher?: NonNullable<Json>;
          name?: string;
          organization_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "skill_versions_forked_from_version_id_fkey";
            columns: ["forked_from_version_id"];
            isOneToOne: false;
            referencedRelation: "skill_versions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "skill_versions_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      storage_redaction_queue: {
        Row: {
          attempts: number;
          bucket: string;
          enqueued_at: string;
          error_message: string | null;
          id: string;
          object_path: string;
          organization_id: string;
          processed_at: string | null;
          request_id: string | null;
          status: string;
        };
        ComputedFields: never;
        Insert: {
          attempts?: number;
          bucket: string;
          enqueued_at?: string;
          error_message?: string | null;
          id?: string;
          object_path: string;
          organization_id: string;
          processed_at?: string | null;
          request_id?: string | null;
          status?: string;
        };
        Update: {
          attempts?: number;
          bucket?: string;
          enqueued_at?: string;
          error_message?: string | null;
          id?: string;
          object_path?: string;
          organization_id?: string;
          processed_at?: string | null;
          request_id?: string | null;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "storage_redaction_queue_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "storage_redaction_queue_request_id_fkey";
            columns: ["request_id"];
            isOneToOne: false;
            referencedRelation: "lgpd_requests";
            referencedColumns: ["id"];
          },
        ];
      };
      system_update_runs: {
        Row: {
          dispatched_at: string;
          disputa_de_banco: boolean | null;
          finished_at: string | null;
          force_requested: boolean;
          from_version: string;
          id: string;
          last_step: string | null;
          log_tail: string;
          passada_do_banco: number | null;
          requested_by: string | null;
          retentativas_do_banco: number | null;
          status: string;
          to_version: string;
        };
        ComputedFields: never;
        Insert: {
          dispatched_at?: string;
          disputa_de_banco?: boolean | null;
          finished_at?: string | null;
          force_requested?: boolean;
          from_version?: string;
          id?: string;
          last_step?: string | null;
          log_tail?: string;
          passada_do_banco?: number | null;
          requested_by?: string | null;
          retentativas_do_banco?: number | null;
          status?: string;
          to_version?: string;
        };
        Update: {
          dispatched_at?: string;
          disputa_de_banco?: boolean | null;
          finished_at?: string | null;
          force_requested?: boolean;
          from_version?: string;
          id?: string;
          last_step?: string | null;
          log_tail?: string;
          passada_do_banco?: number | null;
          requested_by?: string | null;
          retentativas_do_banco?: number | null;
          status?: string;
          to_version?: string;
        };
        Relationships: [];
      };
      system_version: {
        Row: {
          agent_last_seen_at: string | null;
          changelog_raw: string;
          compare_failed: boolean;
          current_sha: string;
          current_version: string;
          has_known_release: boolean;
          id: number;
          latest_version: string;
          off_release: boolean;
          runtime_confirmation: Json | null;
          update_requested_at: string | null;
          update_requested_by: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          agent_last_seen_at?: string | null;
          changelog_raw?: string;
          compare_failed?: boolean;
          current_sha?: string;
          current_version?: string;
          has_known_release?: boolean;
          id?: number;
          latest_version?: string;
          off_release?: boolean;
          runtime_confirmation?: Json | null;
          update_requested_at?: string | null;
          update_requested_by?: string | null;
          updated_at?: string;
        };
        Update: {
          agent_last_seen_at?: string | null;
          changelog_raw?: string;
          compare_failed?: boolean;
          current_sha?: string;
          current_version?: string;
          has_known_release?: boolean;
          id?: number;
          latest_version?: string;
          off_release?: boolean;
          runtime_confirmation?: Json | null;
          update_requested_at?: string | null;
          update_requested_by?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      team_invites: {
        Row: {
          accepted_at: string | null;
          accepted_by: string | null;
          created_at: string;
          email: string;
          email_dispatched: boolean;
          expires_at: string;
          id: string;
          interface_settings: NonNullable<Json>;
          invited_by: string | null;
          inviter_name: string | null;
          last_sent_at: string;
          organization_id: string;
          resend_count: number;
          revoked_at: string | null;
          revoked_by: string | null;
          role: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          accepted_at?: string | null;
          accepted_by?: string | null;
          created_at?: string;
          email: string;
          email_dispatched?: boolean;
          expires_at: string;
          id?: string;
          interface_settings?: NonNullable<Json>;
          invited_by?: string | null;
          inviter_name?: string | null;
          last_sent_at?: string;
          organization_id: string;
          resend_count?: number;
          revoked_at?: string | null;
          revoked_by?: string | null;
          role: string;
          updated_at?: string;
        };
        Update: {
          accepted_at?: string | null;
          accepted_by?: string | null;
          created_at?: string;
          email?: string;
          email_dispatched?: boolean;
          expires_at?: string;
          id?: string;
          interface_settings?: NonNullable<Json>;
          invited_by?: string | null;
          inviter_name?: string | null;
          last_sent_at?: string;
          organization_id?: string;
          resend_count?: number;
          revoked_at?: string | null;
          revoked_by?: string | null;
          role?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "team_invites_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      tenant_integrations: {
        Row: {
          created_at: string;
          expires_at: string | null;
          id: string;
          last_health_check_at: string | null;
          last_sync_at: string | null;
          oauth_access_token_encrypted: string;
          oauth_refresh_token_encrypted: string | null;
          organization_id: string;
          provider: string;
          scopes: string[];
          status: string;
          status_reason: string | null;
          store_metadata: NonNullable<Json>;
          updated_at: string;
          webhook_path_token: string;
          webhook_secret_encrypted: string;
          webhook_subscriptions: NonNullable<Json>;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          expires_at?: string | null;
          id?: string;
          last_health_check_at?: string | null;
          last_sync_at?: string | null;
          oauth_access_token_encrypted: string;
          oauth_refresh_token_encrypted?: string | null;
          organization_id: string;
          provider: string;
          scopes?: string[];
          status?: string;
          status_reason?: string | null;
          store_metadata?: NonNullable<Json>;
          updated_at?: string;
          webhook_path_token?: string;
          webhook_secret_encrypted: string;
          webhook_subscriptions?: NonNullable<Json>;
        };
        Update: {
          created_at?: string;
          expires_at?: string | null;
          id?: string;
          last_health_check_at?: string | null;
          last_sync_at?: string | null;
          oauth_access_token_encrypted?: string;
          oauth_refresh_token_encrypted?: string | null;
          organization_id?: string;
          provider?: string;
          scopes?: string[];
          status?: string;
          status_reason?: string | null;
          store_metadata?: NonNullable<Json>;
          updated_at?: string;
          webhook_path_token?: string;
          webhook_secret_encrypted?: string;
          webhook_subscriptions?: NonNullable<Json>;
        };
        Relationships: [
          {
            foreignKeyName: "tenant_integrations_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      user_organizations: {
        Row: {
          accepted_at: string | null;
          calendar_trilha: number | null;
          created_at: string;
          id: string;
          interface_settings: NonNullable<Json>;
          invited_at: string | null;
          invited_by: string | null;
          organization_id: string;
          provisional_until_handover: boolean;
          revoked_at: string | null;
          role: string;
          updated_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          accepted_at?: string | null;
          calendar_trilha?: number | null;
          created_at?: string;
          id?: string;
          interface_settings?: NonNullable<Json>;
          invited_at?: string | null;
          invited_by?: string | null;
          organization_id: string;
          provisional_until_handover?: boolean;
          revoked_at?: string | null;
          role: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          accepted_at?: string | null;
          calendar_trilha?: number | null;
          created_at?: string;
          id?: string;
          interface_settings?: NonNullable<Json>;
          invited_at?: string | null;
          invited_by?: string | null;
          organization_id?: string;
          provisional_until_handover?: boolean;
          revoked_at?: string | null;
          role?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_organizations_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      user_recovery_codes: {
        Row: {
          code_hash: string;
          created_at: string;
          id: string;
          used_at: string | null;
          used_ip: unknown;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          code_hash: string;
          created_at?: string;
          id?: string;
          used_at?: string | null;
          used_ip?: unknown;
          user_id: string;
        };
        Update: {
          code_hash?: string;
          created_at?: string;
          id?: string;
          used_at?: string | null;
          used_ip?: unknown;
          user_id?: string;
        };
        Relationships: [];
      };
      voice_calls: {
        Row: {
          ai_agent_id: string | null;
          answered_at: string | null;
          asterisk_channel_id: string | null;
          channel_session_id: string | null;
          contact_id: string | null;
          created_at: string;
          created_by: string | null;
          direction: string;
          duration_ms: number | null;
          end_reason: string | null;
          ended_at: string | null;
          handled_by: string | null;
          id: string;
          lead_id: string | null;
          metadata: NonNullable<Json>;
          organization_id: string;
          owner_user_id: string | null;
          peer_phone: string;
          provider: string;
          started_at: string;
          status: string;
          transcript: Json | null;
          updated_at: string;
          wacalls_call_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          ai_agent_id?: string | null;
          answered_at?: string | null;
          asterisk_channel_id?: string | null;
          channel_session_id?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          direction: string;
          duration_ms?: number | null;
          end_reason?: string | null;
          ended_at?: string | null;
          handled_by?: string | null;
          id?: string;
          lead_id?: string | null;
          metadata?: NonNullable<Json>;
          organization_id: string;
          owner_user_id?: string | null;
          peer_phone: string;
          provider?: string;
          started_at?: string;
          status: string;
          transcript?: Json | null;
          updated_at?: string;
          wacalls_call_id?: string | null;
        };
        Update: {
          ai_agent_id?: string | null;
          answered_at?: string | null;
          asterisk_channel_id?: string | null;
          channel_session_id?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          direction?: string;
          duration_ms?: number | null;
          end_reason?: string | null;
          ended_at?: string | null;
          handled_by?: string | null;
          id?: string;
          lead_id?: string | null;
          metadata?: NonNullable<Json>;
          organization_id?: string;
          owner_user_id?: string | null;
          peer_phone?: string;
          provider?: string;
          started_at?: string;
          status?: string;
          transcript?: Json | null;
          updated_at?: string;
          wacalls_call_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "voice_calls_ai_agent_id_fkey";
            columns: ["ai_agent_id"];
            isOneToOne: false;
            referencedRelation: "ai_agents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "voice_calls_channel_session_id_fkey";
            columns: ["channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "voice_calls_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "voice_calls_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "crm_leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "voice_calls_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      voip_trunk_settings: {
        Row: {
          created_at: string;
          endpoint_name: string;
          from_domain: string | null;
          host: string;
          is_active: boolean;
          organization_id: string;
          password_encrypted: string;
          password_iv: string;
          password_last4: string;
          password_tag: string;
          port: number;
          updated_at: string;
          updated_by: string | null;
          username: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          endpoint_name: string;
          from_domain?: string | null;
          host: string;
          is_active?: boolean;
          organization_id: string;
          password_encrypted: string;
          password_iv: string;
          password_last4: string;
          password_tag: string;
          port?: number;
          updated_at?: string;
          updated_by?: string | null;
          username: string;
        };
        Update: {
          created_at?: string;
          endpoint_name?: string;
          from_domain?: string | null;
          host?: string;
          is_active?: boolean;
          organization_id?: string;
          password_encrypted?: string;
          password_iv?: string;
          password_last4?: string;
          password_tag?: string;
          port?: number;
          updated_at?: string;
          updated_by?: string | null;
          username?: string;
        };
        Relationships: [
          {
            foreignKeyName: "voip_trunk_settings_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: true;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      watchdog_cursors: {
        Row: {
          consumer: string;
          last_created_at: string;
          last_event_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          consumer: string;
          last_created_at?: string;
          last_event_id?: string;
          updated_at?: string;
        };
        Update: {
          consumer?: string;
          last_created_at?: string;
          last_event_id?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      webhook_events_log: {
        Row: {
          archived_at: string | null;
          attempts: number;
          channel_session_id: string | null;
          error_message: string | null;
          event_type: string | null;
          external_id: string | null;
          headers: Json | null;
          http_method: string;
          id: string;
          organization_id: string | null;
          payload_parsed: Json | null;
          processed_at: string | null;
          provider: string;
          raw_body: string | null;
          received_at: string;
          signature_header: string | null;
          status: string;
          valid_signature: boolean | null;
          webhook_path_token: string | null;
        };
        ComputedFields: never;
        Insert: {
          archived_at?: string | null;
          attempts?: number;
          channel_session_id?: string | null;
          error_message?: string | null;
          event_type?: string | null;
          external_id?: string | null;
          headers?: Json | null;
          http_method?: string;
          id?: string;
          organization_id?: string | null;
          payload_parsed?: Json | null;
          processed_at?: string | null;
          provider?: string;
          raw_body?: string | null;
          received_at?: string;
          signature_header?: string | null;
          status?: string;
          valid_signature?: boolean | null;
          webhook_path_token?: string | null;
        };
        Update: {
          archived_at?: string | null;
          attempts?: number;
          channel_session_id?: string | null;
          error_message?: string | null;
          event_type?: string | null;
          external_id?: string | null;
          headers?: Json | null;
          http_method?: string;
          id?: string;
          organization_id?: string | null;
          payload_parsed?: Json | null;
          processed_at?: string | null;
          provider?: string;
          raw_body?: string | null;
          received_at?: string;
          signature_header?: string | null;
          status?: string;
          valid_signature?: boolean | null;
          webhook_path_token?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "webhook_events_log_channel_session_id_fkey";
            columns: ["channel_session_id"];
            isOneToOne: false;
            referencedRelation: "channel_sessions";
            referencedColumns: ["id"];
          },
        ];
      };
      webhook_lead_captures: {
        Row: {
          captured_email: string | null;
          captured_name: string | null;
          captured_phone: string | null;
          contact_id: string | null;
          fields: NonNullable<Json>;
          id: string;
          lead_id: string | null;
          organization_id: string;
          origin: string | null;
          outcome: string;
          received_at: string;
          reject_reason: string | null;
          remote_ip: unknown;
          request_id: string | null;
          source_name: string;
          user_agent: string | null;
          utm: NonNullable<Json>;
          webhook_source_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          captured_email?: string | null;
          captured_name?: string | null;
          captured_phone?: string | null;
          contact_id?: string | null;
          fields?: NonNullable<Json>;
          id?: string;
          lead_id?: string | null;
          organization_id: string;
          origin?: string | null;
          outcome: string;
          received_at?: string;
          reject_reason?: string | null;
          remote_ip?: unknown;
          request_id?: string | null;
          source_name: string;
          user_agent?: string | null;
          utm?: NonNullable<Json>;
          webhook_source_id?: string | null;
        };
        Update: {
          captured_email?: string | null;
          captured_name?: string | null;
          captured_phone?: string | null;
          contact_id?: string | null;
          fields?: NonNullable<Json>;
          id?: string;
          lead_id?: string | null;
          organization_id?: string;
          origin?: string | null;
          outcome?: string;
          received_at?: string;
          reject_reason?: string | null;
          remote_ip?: unknown;
          request_id?: string | null;
          source_name?: string;
          user_agent?: string | null;
          utm?: NonNullable<Json>;
          webhook_source_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "webhook_lead_captures_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "webhook_lead_captures_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "crm_leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "webhook_lead_captures_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "webhook_lead_captures_webhook_source_id_fkey";
            columns: ["webhook_source_id"];
            isOneToOne: false;
            referencedRelation: "webhook_sources";
            referencedColumns: ["id"];
          },
        ];
      };
      webhook_sources: {
        Row: {
          authorize_ai_on_capture: boolean;
          created_at: string;
          created_by_user_id: string | null;
          default_pipeline_id: string;
          default_stage_id: string;
          field_map: NonNullable<Json>;
          form_fields: NonNullable<Json>;
          id: string;
          is_active: boolean;
          kind: string;
          last_change_actor_kind: string | null;
          last_change_at: string | null;
          last_received_at: string | null;
          name: string;
          organization_id: string;
          path_token: string;
          redirect_to: string | null;
          reuse_open_lead_on_capture: boolean;
          secret_encrypted: string | null;
          update_existing_lead_on_capture: boolean;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          authorize_ai_on_capture?: boolean;
          created_at?: string;
          created_by_user_id?: string | null;
          default_pipeline_id: string;
          default_stage_id: string;
          field_map?: NonNullable<Json>;
          form_fields?: NonNullable<Json>;
          id?: string;
          is_active?: boolean;
          kind?: string;
          last_change_actor_kind?: string | null;
          last_change_at?: string | null;
          last_received_at?: string | null;
          name: string;
          organization_id: string;
          path_token: string;
          redirect_to?: string | null;
          reuse_open_lead_on_capture?: boolean;
          secret_encrypted?: string | null;
          update_existing_lead_on_capture?: boolean;
          updated_at?: string;
        };
        Update: {
          authorize_ai_on_capture?: boolean;
          created_at?: string;
          created_by_user_id?: string | null;
          default_pipeline_id?: string;
          default_stage_id?: string;
          field_map?: NonNullable<Json>;
          form_fields?: NonNullable<Json>;
          id?: string;
          is_active?: boolean;
          kind?: string;
          last_change_actor_kind?: string | null;
          last_change_at?: string | null;
          last_received_at?: string | null;
          name?: string;
          organization_id?: string;
          path_token?: string;
          redirect_to?: string | null;
          reuse_open_lead_on_capture?: boolean;
          secret_encrypted?: string | null;
          update_existing_lead_on_capture?: boolean;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "webhook_sources_default_pipeline_id_fkey";
            columns: ["default_pipeline_id"];
            isOneToOne: false;
            referencedRelation: "crm_pipelines";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "webhook_sources_default_stage_id_fkey";
            columns: ["default_stage_id"];
            isOneToOne: false;
            referencedRelation: "crm_stages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "webhook_sources_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      ai_provider_credentials_safe: {
        Row: {
          api_key_last4: string;
          base_url: string | null;
          created_at: string;
          created_by: string | null;
          id: string;
          is_active: boolean;
          label: string;
          models_available: string[] | null;
          organization_id: string;
          provider: string;
          updated_at: string;
          validated_at: string | null;
          validation_error: string | null;
        };
        ComputedFields: never;
        Insert: {
          api_key_last4?: string | null;
          base_url?: string | null;
          created_at?: string | null;
          created_by?: string | null;
          id?: string | null;
          is_active?: boolean | null;
          label?: string | null;
          models_available?: string[] | null;
          organization_id?: string | null;
          provider?: string | null;
          updated_at?: string | null;
          validated_at?: string | null;
          validation_error?: string | null;
        };
        Update: {
          api_key_last4?: string | null;
          base_url?: string | null;
          created_at?: string | null;
          created_by?: string | null;
          id?: string | null;
          is_active?: boolean | null;
          label?: string | null;
          models_available?: string[] | null;
          organization_id?: string | null;
          provider?: string | null;
          updated_at?: string | null;
          validated_at?: string | null;
          validation_error?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "ai_provider_credentials_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      calendar_google_reconcilable_appointments: {
        Row: {
          cancellation_reason: string | null;
          cancelled_at: string | null;
          confirmation_next_at: string | null;
          contact_id: string | null;
          conversation_id: string | null;
          created_at: string;
          created_by_agent_id: string | null;
          created_by_kind: string;
          created_by_user_id: string | null;
          description: string | null;
          ends_at: string;
          event_type_id: string | null;
          google_base_projection: Json | null;
          google_calendar_id: string | null;
          google_claim_epoch: number;
          google_claim_token: string | null;
          google_claim_until: string | null;
          google_conflict: Json | null;
          google_connection_id: string | null;
          google_etag: string | null;
          google_event_id: string | null;
          google_ical_uid: string | null;
          google_local_revision: number;
          google_next_attempt_at: string;
          google_pending_write: Json | null;
          google_sequence: number;
          google_sync_error: string | null;
          google_synced_at: string | null;
          google_synced_local_revision: number;
          guest_email: string | null;
          id: string;
          location_details: string | null;
          location_kind: string;
          meeting_attempts: number;
          meeting_delivery: NonNullable<Json>;
          meeting_delivery_job_id: string | null;
          meeting_last_error: string | null;
          meeting_next_attempt_at: string | null;
          meeting_ready_at: string | null;
          meeting_received_at: string | null;
          meeting_request_id: string | null;
          meeting_requested_at: string | null;
          meeting_state: string;
          meeting_url: string | null;
          needs_google_push: boolean | null;
          notes: string | null;
          organization_id: string;
          outcome_message_id: string | null;
          outcome_recorded_at: string | null;
          outcome_source_kind: string | null;
          outcome_user_id: string | null;
          owner_user_id: string | null;
          participant_key: string | null;
          participant_name: string | null;
          reminder_sent_at: string | null;
          reminder_sent_offsets_minutes: number[];
          rescheduled_from_id: string | null;
          revision: number;
          revision_started_at: string;
          service_block: boolean;
          service_booking_mode: string | null;
          service_capacity_limit: number | null;
          service_capacity_rule: string | null;
          service_confirmed_at: string | null;
          service_confirmed_by_user_id: string | null;
          service_destination_calendar_id: string | null;
          service_occurrence_id: string | null;
          service_operation_key: string | null;
          service_operation_request: Json | null;
          service_publication_mode: string | null;
          service_requires_confirmation: boolean | null;
          service_rule_revision: number | null;
          source: string;
          starts_at: string;
          starts_at_marked_at: string | null;
          status: string;
          time_zone: string;
          title: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          cancellation_reason?: string | null;
          cancelled_at?: string | null;
          confirmation_next_at?: string | null;
          contact_id?: string | null;
          conversation_id?: string | null;
          created_at?: string | null;
          created_by_agent_id?: string | null;
          created_by_kind?: string | null;
          created_by_user_id?: string | null;
          description?: string | null;
          ends_at?: string | null;
          event_type_id?: string | null;
          google_base_projection?: Json | null;
          google_calendar_id?: string | null;
          google_claim_epoch?: number | null;
          google_claim_token?: string | null;
          google_claim_until?: string | null;
          google_conflict?: Json | null;
          google_connection_id?: string | null;
          google_etag?: string | null;
          google_event_id?: string | null;
          google_ical_uid?: string | null;
          google_local_revision?: number | null;
          google_next_attempt_at?: string | null;
          google_pending_write?: Json | null;
          google_sequence?: number | null;
          google_sync_error?: string | null;
          google_synced_at?: string | null;
          google_synced_local_revision?: number | null;
          guest_email?: string | null;
          id?: string | null;
          location_details?: string | null;
          location_kind?: string | null;
          meeting_attempts?: number | null;
          meeting_delivery?: Json | null;
          meeting_delivery_job_id?: string | null;
          meeting_last_error?: string | null;
          meeting_next_attempt_at?: string | null;
          meeting_ready_at?: string | null;
          meeting_received_at?: string | null;
          meeting_request_id?: string | null;
          meeting_requested_at?: string | null;
          meeting_state?: string | null;
          meeting_url?: string | null;
          needs_google_push?: boolean | null;
          notes?: string | null;
          organization_id?: string | null;
          outcome_message_id?: string | null;
          outcome_recorded_at?: string | null;
          outcome_source_kind?: string | null;
          outcome_user_id?: string | null;
          owner_user_id?: string | null;
          participant_key?: string | null;
          participant_name?: string | null;
          reminder_sent_at?: string | null;
          reminder_sent_offsets_minutes?: number[] | null;
          rescheduled_from_id?: string | null;
          revision?: number | null;
          revision_started_at?: string | null;
          service_block?: boolean | null;
          service_booking_mode?: string | null;
          service_capacity_limit?: number | null;
          service_capacity_rule?: string | null;
          service_confirmed_at?: string | null;
          service_confirmed_by_user_id?: string | null;
          service_destination_calendar_id?: string | null;
          service_occurrence_id?: string | null;
          service_operation_key?: string | null;
          service_operation_request?: Json | null;
          service_publication_mode?: string | null;
          service_requires_confirmation?: boolean | null;
          service_rule_revision?: number | null;
          source?: string | null;
          starts_at?: string | null;
          starts_at_marked_at?: string | null;
          status?: string | null;
          time_zone?: string | null;
          title?: string | null;
          updated_at?: string | null;
        };
        Update: {
          cancellation_reason?: string | null;
          cancelled_at?: string | null;
          confirmation_next_at?: string | null;
          contact_id?: string | null;
          conversation_id?: string | null;
          created_at?: string | null;
          created_by_agent_id?: string | null;
          created_by_kind?: string | null;
          created_by_user_id?: string | null;
          description?: string | null;
          ends_at?: string | null;
          event_type_id?: string | null;
          google_base_projection?: Json | null;
          google_calendar_id?: string | null;
          google_claim_epoch?: number | null;
          google_claim_token?: string | null;
          google_claim_until?: string | null;
          google_conflict?: Json | null;
          google_connection_id?: string | null;
          google_etag?: string | null;
          google_event_id?: string | null;
          google_ical_uid?: string | null;
          google_local_revision?: number | null;
          google_next_attempt_at?: string | null;
          google_pending_write?: Json | null;
          google_sequence?: number | null;
          google_sync_error?: string | null;
          google_synced_at?: string | null;
          google_synced_local_revision?: number | null;
          guest_email?: string | null;
          id?: string | null;
          location_details?: string | null;
          location_kind?: string | null;
          meeting_attempts?: number | null;
          meeting_delivery?: Json | null;
          meeting_delivery_job_id?: string | null;
          meeting_last_error?: string | null;
          meeting_next_attempt_at?: string | null;
          meeting_ready_at?: string | null;
          meeting_received_at?: string | null;
          meeting_request_id?: string | null;
          meeting_requested_at?: string | null;
          meeting_state?: string | null;
          meeting_url?: string | null;
          needs_google_push?: boolean | null;
          notes?: string | null;
          organization_id?: string | null;
          outcome_message_id?: string | null;
          outcome_recorded_at?: string | null;
          outcome_source_kind?: string | null;
          outcome_user_id?: string | null;
          owner_user_id?: string | null;
          participant_key?: string | null;
          participant_name?: string | null;
          reminder_sent_at?: string | null;
          reminder_sent_offsets_minutes?: number[] | null;
          rescheduled_from_id?: string | null;
          revision?: number | null;
          revision_started_at?: string | null;
          service_block?: boolean | null;
          service_booking_mode?: string | null;
          service_capacity_limit?: number | null;
          service_capacity_rule?: string | null;
          service_confirmed_at?: string | null;
          service_confirmed_by_user_id?: string | null;
          service_destination_calendar_id?: string | null;
          service_occurrence_id?: string | null;
          service_operation_key?: string | null;
          service_operation_request?: Json | null;
          service_publication_mode?: string | null;
          service_requires_confirmation?: boolean | null;
          service_rule_revision?: number | null;
          source?: string | null;
          starts_at?: string | null;
          starts_at_marked_at?: string | null;
          status?: string | null;
          time_zone?: string | null;
          title?: string | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "calendar_appointments_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_appointments_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_appointments_created_by_agent_id_fkey";
            columns: ["created_by_agent_id"];
            isOneToOne: false;
            referencedRelation: "ai_agents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_appointments_event_type_id_fkey";
            columns: ["event_type_id"];
            isOneToOne: false;
            referencedRelation: "calendar_event_types";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_appointments_google_connection_id_fkey";
            columns: ["google_connection_id"];
            isOneToOne: false;
            referencedRelation: "calendar_connections";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_appointments_meeting_delivery_job_id_fkey";
            columns: ["meeting_delivery_job_id"];
            isOneToOne: false;
            referencedRelation: "job_queue";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_appointments_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_appointments_outcome_message_id_fkey";
            columns: ["outcome_message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_appointments_rescheduled_from_id_fkey";
            columns: ["rescheduled_from_id"];
            isOneToOne: false;
            referencedRelation: "calendar_appointments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_appointments_rescheduled_from_id_fkey";
            columns: ["rescheduled_from_id"];
            isOneToOne: false;
            referencedRelation: "calendar_google_reconcilable_appointments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_appointments_rescheduled_from_id_fkey";
            columns: ["rescheduled_from_id"];
            isOneToOne: false;
            referencedRelation: "calendar_service_google_candidates";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_service_appointment_destination_fk";
            columns: ["organization_id", "service_destination_calendar_id"];
            isOneToOne: false;
            referencedRelation: "calendar_connection_calendars";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "calendar_service_occurrence_fk";
            columns: ["organization_id", "service_occurrence_id"];
            isOneToOne: false;
            referencedRelation: "calendar_service_occurrences";
            referencedColumns: ["organization_id", "id"];
          },
        ];
      };
      calendar_selected_external_events: {
        Row: {
          connection_id: string;
          created_at: string;
          ends_at: string | null;
          external_calendar_id: string;
          external_event_id: string;
          external_updated_at: string | null;
          ical_uid: string | null;
          id: string;
          is_all_day: boolean;
          organization_id: string;
          original_start_time: Json | null;
          recurring_event_id: string | null;
          seen_generation: string | null;
          starts_at: string | null;
          status: string;
          transparency: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          connection_id?: string | null;
          created_at?: string | null;
          ends_at?: string | null;
          external_calendar_id?: string | null;
          external_event_id?: string | null;
          external_updated_at?: string | null;
          ical_uid?: string | null;
          id?: string | null;
          is_all_day?: boolean | null;
          organization_id?: string | null;
          original_start_time?: Json | null;
          recurring_event_id?: string | null;
          seen_generation?: string | null;
          starts_at?: string | null;
          status?: string | null;
          transparency?: string | null;
          updated_at?: string | null;
        };
        Update: {
          connection_id?: string | null;
          created_at?: string | null;
          ends_at?: string | null;
          external_calendar_id?: string | null;
          external_event_id?: string | null;
          external_updated_at?: string | null;
          ical_uid?: string | null;
          id?: string | null;
          is_all_day?: boolean | null;
          organization_id?: string | null;
          original_start_time?: Json | null;
          recurring_event_id?: string | null;
          seen_generation?: string | null;
          starts_at?: string | null;
          status?: string | null;
          transparency?: string | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "calendar_external_events_connection_id_fkey";
            columns: ["connection_id"];
            isOneToOne: false;
            referencedRelation: "calendar_connections";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_external_events_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      calendar_service_google_candidates: {
        Row: {
          google_conflict: Json | null;
          google_event_id: string | null;
          google_next_attempt_at: string;
          id: string;
          needs_google_push: boolean | null;
          organization_id: string;
          owner_user_id: string | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "calendar_appointments_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      external_db_connections_safe: {
        Row: {
          created_at: string;
          created_by: string | null;
          customer_key_column: string | null;
          customer_key_kind: string | null;
          database_name: string;
          db_type: string;
          enabled: boolean;
          host: string;
          id: string;
          label: string;
          last_test_aviso: string | null;
          last_test_error: string | null;
          last_test_ok: boolean | null;
          last_tested_at: string | null;
          max_filters: number;
          max_response_bytes: number;
          max_rows: number;
          organization_id: string;
          port: number;
          receitas_count: number | null;
          source_mode: string;
          sources_count: number | null;
          ssl_mode: string;
          updated_at: string;
          username: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string | null;
          created_by?: string | null;
          customer_key_column?: string | null;
          customer_key_kind?: string | null;
          database_name?: string | null;
          db_type?: string | null;
          enabled?: boolean | null;
          host?: string | null;
          id?: string | null;
          label?: string | null;
          last_test_aviso?: string | null;
          last_test_error?: string | null;
          last_test_ok?: boolean | null;
          last_tested_at?: string | null;
          max_filters?: number | null;
          max_response_bytes?: number | null;
          max_rows?: number | null;
          organization_id?: string | null;
          port?: number | null;
          receitas_count?: never;
          source_mode?: string | null;
          sources_count?: never;
          ssl_mode?: string | null;
          updated_at?: string | null;
          username?: string | null;
        };
        Update: {
          created_at?: string | null;
          created_by?: string | null;
          customer_key_column?: string | null;
          customer_key_kind?: string | null;
          database_name?: string | null;
          db_type?: string | null;
          enabled?: boolean | null;
          host?: string | null;
          id?: string | null;
          label?: string | null;
          last_test_aviso?: string | null;
          last_test_error?: string | null;
          last_test_ok?: boolean | null;
          last_tested_at?: string | null;
          max_filters?: number | null;
          max_response_bytes?: number | null;
          max_rows?: number | null;
          organization_id?: string | null;
          port?: number | null;
          receitas_count?: never;
          source_mode?: string | null;
          sources_count?: never;
          ssl_mode?: string | null;
          updated_at?: string | null;
          username?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "external_db_connections_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      voip_trunk_settings_safe: {
        Row: {
          created_at: string;
          endpoint_name: string;
          from_domain: string | null;
          host: string;
          is_active: boolean;
          organization_id: string;
          password_last4: string;
          port: number;
          updated_at: string;
          updated_by: string | null;
          username: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string | null;
          endpoint_name?: string | null;
          from_domain?: string | null;
          host?: string | null;
          is_active?: boolean | null;
          organization_id?: string | null;
          password_last4?: string | null;
          port?: number | null;
          updated_at?: string | null;
          updated_by?: string | null;
          username?: string | null;
        };
        Update: {
          created_at?: string | null;
          endpoint_name?: string | null;
          from_domain?: string | null;
          host?: string | null;
          is_active?: boolean | null;
          organization_id?: string | null;
          password_last4?: string | null;
          port?: number | null;
          updated_at?: string | null;
          updated_by?: string | null;
          username?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "voip_trunk_settings_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: true;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Functions: {
      activate_kb_version: {
        Args: { p_agent_id: string; p_version_id: string };
        Returns: undefined;
      };
      comando_da_conversa: {
        Args: { "": Database["public"]["Tables"]["conversations"]["Row"] };
        Returns: {
          error: true;
        } & "the function public.comando_da_conversa with parameter or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache";
      };
      decrypt_cpf: { Args: { p_contact_id: string }; Returns: string };
      emit_event: {
        Args: {
          p_entity_id: string;
          p_entity_kind: string;
          p_event_type: string;
          p_metadata?: Json;
          p_organization_id?: string;
          p_payload?: Json;
        };
        Returns: string;
      };
      encrypt_cpf: { Args: { p_plaintext: string }; Returns: string };
      fn_accept_team_invite:
        | {
            Args: {
              p_invited_at: string;
              p_invited_by: string;
              p_issued_at: string;
              p_org: string;
              p_role: string;
              p_user: string;
            };
            Returns: Json;
          }
        | {
            Args: {
              p_interface_settings: Json;
              p_invited_at: string;
              p_invited_by: string;
              p_issued_at: string;
              p_org: string;
              p_role: string;
              p_user: string;
            };
            Returns: Json;
          };
      fn_activity_report: {
        Args: { p_from: string; p_limit?: number; p_org: string; p_to: string; p_tz?: string };
        Returns: Json;
      };
      fn_agenda_conexoes_google_do_dono: {
        Args: { p_org: string; p_owner: string };
        Returns: {
          last_sync_at: string;
          status: string;
        }[];
      };
      fn_agenda_minutes: {
        Args: { p_default: number; p_key: string; p_settings: Json };
        Returns: number;
      };
      fn_agenda_ocupacao_google_do_dono: {
        Args: { p_ate: string; p_de: string; p_org: string; p_owner: string };
        Returns: {
          connection_status: string;
          ends_at: string;
          starts_at: string;
          status: string;
          transparency: string;
        }[];
      };
      fn_agenda_settings: { Args: { p_config: Json; p_org: string }; Returns: Json };
      fn_agent_legacy_notice: {
        Args: { p_agent: string; p_body: string; p_code: string; p_org: string; p_title: string };
        Returns: boolean;
      };
      fn_agent_tool_usage: {
        Args: { p_agent_id: string; p_organization_id: string; p_since: string };
        Returns: {
          em_teste: number;
          falhas: number;
          tool_name: string;
          total: number;
          ultima_vez: string;
        }[];
      };
      fn_agent_tool_usage_por_termo: {
        Args: { p_agent_id: string; p_organization_id: string; p_since: string };
        Returns: {
          falhas: number;
          termo: string;
          tool_name: string;
          total: number;
          ultima_vez: string;
        }[];
      };
      fn_agora: { Args: Record<PropertyKey, never>; Returns: string };
      fn_apagar_contato_com_historico: {
        Args: { p_contact_id: string; p_organization_id: string };
        Returns: boolean;
      };
      fn_aplicar_quadro_do_onboarding: {
        Args: {
          p_etapas: Json;
          p_nome: string;
          p_organization_id: string;
          p_pipeline_id: string;
          p_slug: string;
        };
        Returns: Json;
      };
      fn_aplicar_travas_de_suporte: { Args: Record<PropertyKey, never>; Returns: undefined };
      fn_appointment_change: {
        Args: { p_id: string; p_org: string; p_patch: Json; p_revision: number };
        Returns: Json;
      };
      fn_appointment_change_core: {
        Args: {
          p_base: Json;
          p_id: string;
          p_org: string;
          p_patch: Json;
          p_remote: boolean;
          p_revision: number;
        };
        Returns: Json;
      };
      fn_appointment_confirmation_sweep: {
        Args: { p_limit?: number; p_now?: string };
        Returns: number;
      };
      fn_appointment_enrollment_current: {
        Args: { p_id: string; p_node?: string; p_org: string };
        Returns: boolean;
      };
      fn_appointment_recover: { Args: { p_event: string; p_org: string }; Returns: Json };
      fn_arquivos_da_organizacao: {
        Args: { p_apos_bucket?: string; p_apos_nome?: string; p_limite?: number; p_org: string };
        Returns: {
          bucket_id: string;
          name: string;
        }[];
      };
      fn_atrito_jaccard: { Args: { a: string; b: string }; Returns: number };
      fn_atrito_metrics: {
        Args: {
          p_abandono_horas?: number;
          p_espera_horas?: number;
          p_from: string;
          p_org: string;
          p_repeticao_min?: number;
          p_to: string;
        };
        Returns: Json;
      };
      fn_attendant_metrics: {
        Args: {
          p_excluir_etiqueta?: string;
          p_from: string;
          p_org: string;
          p_owner?: string;
          p_to: string;
        };
        Returns: Json;
      };
      fn_authorize_ai_form_capture: {
        Args: {
          p_contact_id: string;
          p_lead_id: string;
          p_organization_id: string;
          p_request_id: string;
          p_source_id: string;
          p_ttl_ms: number;
        };
        Returns: boolean;
      };
      fn_automation_rodizio_atribuir: {
        Args: { p_event?: string; p_lead: string; p_org: string; p_rule: string };
        Returns: Json;
      };
      fn_autonomous_turn_revoked: { Args: { p_job: string; p_org: string }; Returns: boolean };
      fn_buscar_trechos_das_fontes: {
        Args: {
          p_embedding: string;
          p_embedding_model?: string;
          p_k?: number;
          p_organization_id: string;
          p_source_ids: string[];
          p_threshold?: number;
        };
        Returns: {
          chunk_id: string;
          content: string;
          knowledge_source_id: string;
          metadata: Json;
          similarity: number;
          source_name: string;
        }[];
      };
      fn_calendar_service_assert_actor: {
        Args: { p_actor: Json; p_org: string; p_role: string };
        Returns: undefined;
      };
      fn_calendar_service_block: {
        Args: { p_actor: Json; p_input: Json; p_org: string };
        Returns: Json;
      };
      fn_calendar_service_book: {
        Args: { p_actor: Json; p_execution?: Json; p_input: Json; p_org: string };
        Returns: Json;
      };
      fn_calendar_service_book_group: {
        Args: { p_actor: Json; p_execution?: Json; p_input: Json; p_org: string };
        Returns: Json;
      };
      fn_calendar_service_can_resolve: { Args: { p_id: string; p_org: string }; Returns: boolean };
      fn_calendar_service_catalog: { Args: { p_org: string }; Returns: Json };
      fn_calendar_service_check: {
        Args: {
          p_ignore?: string;
          p_now?: string;
          p_org: string;
          p_owner?: string;
          p_start: string;
          p_type: string;
        };
        Returns: Json;
      };
      fn_calendar_service_configure: {
        Args: { p_actor: Json; p_config: Json; p_org: string };
        Returns: Json;
      };
      fn_calendar_service_create_authenticated: {
        Args: { p_org: string; p_patch: Json; p_revision: number };
        Returns: Json;
      };
      fn_calendar_service_execution_current: {
        Args: { p_contact: string; p_execution: Json; p_org: string };
        Returns: boolean;
      };
      fn_calendar_service_google_state: {
        Args: { p_end: string; p_org: string; p_owner: string; p_start: string; p_type: string };
        Returns: Json;
      };
      fn_calendar_service_lock: { Args: { p_org: string }; Returns: undefined };
      fn_calendar_service_occurrence: {
        Args: { p_check: Json; p_org: string; p_type: string };
        Returns: string;
      };
      fn_calendar_service_person_available: {
        Args: {
          p_end: string;
          p_ignore?: string;
          p_org: string;
          p_owner: string;
          p_start: string;
          p_type?: string;
        };
        Returns: boolean;
      };
      fn_calendar_service_preview: {
        Args: { p_now?: string; p_org: string; p_owner?: string; p_starts: Json; p_type: string };
        Returns: Json;
      };
      fn_calendar_service_read: { Args: { p_org: string; p_type: string }; Returns: Json };
      fn_calendar_service_resource: {
        Args: { p_actor: Json; p_config: Json; p_org: string };
        Returns: Json;
      };
      fn_calendar_service_sources_to_refresh: {
        Args: { p_org: string; p_owner?: string; p_type: string };
        Returns: Json;
      };
      fn_can_view_appointment: {
        Args: { p_org: string; p_owner_user_id: string };
        Returns: boolean;
      };
      fn_can_view_conversation: {
        Args: { p_assigned_to_user_id: string; p_org: string };
        Returns: boolean;
      };
      fn_can_view_lead: { Args: { p_org: string; p_owner_user_id: string }; Returns: boolean };
      fn_can_view_task: {
        Args: { p_assigned_to: string; p_created_by: string; p_org: string };
        Returns: boolean;
      };
      fn_casos_parados_para_lembrar: {
        Args: { p_limite?: number };
        Returns: {
          cobrancas_na_espera: number;
          followup_attempts: number;
          id: string;
          opened_at: string;
          organization_id: string;
          teto: number;
          title: string;
        }[];
      };
      fn_channel_metrics: {
        Args: { p_from: string; p_org: string; p_owner?: string; p_to: string };
        Returns: Json;
      };
      fn_channel_routing_claim: {
        Args: {
          p_channel: string;
          p_conversation: string;
          p_org: string;
          p_reason?: string;
          p_schedule?: Json;
          p_user: string;
        };
        Returns: string;
      };
      fn_claim_due_followup_enrollments: {
        Args: { p_lease_seconds: number; p_limit: number };
        Returns: {
          agent_id: string | null;
          appointment_id: string | null;
          appointment_revision: number | null;
          attempts: number;
          cancel_reason: string | null;
          claimed_until: string | null;
          completed_at: string | null;
          contact_id: string;
          conversation_id: string | null;
          current_node_id: string;
          id: string;
          last_error: string | null;
          max_attempts: number;
          next_eval_at: string | null;
          organization_id: string;
          outcome: string | null;
          pointer_id: string;
          revision: number;
          service_boundary: Json | null;
          started_at: string;
          status: string;
          steps_taken: number;
          timing_plan: Json | null;
          updated_at: string;
          version_id: string;
        }[];
        SetofOptions: {
          from: "*";
          to: "followup_enrollments";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      fn_claim_meta_ctwa_click: { Args: { p_click: string; p_org: string }; Returns: Json };
      fn_claim_meta_lead_submitted: { Args: { p_lead: string; p_org: string }; Returns: Json };
      fn_cobranca_avisar_teto_de_ia: {
        Args: { p_corpo: string; p_org: string; p_titulo: string };
        Returns: boolean;
      };
      fn_cobranca_liberar_suspensoes: { Args: { p_ator: string }; Returns: number };
      fn_cobranca_ligada: { Args: Record<PropertyKey, never>; Returns: boolean };
      fn_cobranca_reconciliaveis: {
        Args: Record<PropertyKey, never>;
        Returns: {
          organization_id: string;
          precisa_reler: boolean;
          relida_em: string;
        }[];
      };
      fn_cobranca_registrar_aviso: {
        Args: {
          p_aviso: string;
          p_corpo: string;
          p_desde: string;
          p_org: string;
          p_severidade: string;
          p_titulo: string;
        };
        Returns: boolean;
      };
      fn_cobranca_suspender_se_devendo: {
        Args: { p_motivo: string; p_org: string };
        Returns: Json;
      };
      fn_colegas_podem_mexer_na_agenda: { Args: { p_org: string }; Returns: boolean };
      fn_comando_da_conversa: {
        Args: {
          p_agora: string;
          p_assigned_to_user_id: string;
          p_bot_silenced_until: string;
          p_force_human: boolean;
          p_is_blocked: boolean;
          p_is_group?: boolean;
          p_status: string;
        };
        Returns: string;
      };
      fn_conferir_modulos_instalados: { Args: Record<PropertyKey, never>; Returns: undefined };
      fn_configurar_pre_go_live_canal: {
        Args: { p_canal: string; p_modo: string; p_numeros: string[]; p_org: string };
        Returns: number;
      };
      fn_contar_mensagem_ignorada: { Args: { p_org: string }; Returns: undefined };
      fn_contato_adicionar_etiquetas: {
        Args: { p_contato: string; p_etiquetas: string[]; p_org: string };
        Returns: Json;
      };
      fn_contato_pessoal_remove_trechos_do_rag: {
        Args: { p_contact: string; p_org: string };
        Returns: number;
      };
      fn_conversa_remove_trechos_do_rag: {
        Args: { p_conversation: string; p_org: string };
        Returns: number;
      };
      fn_conversation_assign: {
        Args: {
          p_conversation_id: string;
          p_enforce_expected?: boolean;
          p_expected_assignee?: string;
          p_organization_id: string;
          p_reason: string;
          p_to_user_id: string;
        };
        Returns: {
          active_agent_set_at: string | null;
          active_ai_agent_id: string | null;
          active_intent: string | null;
          assigned_at: string | null;
          assigned_to_user_id: string | null;
          assigned_to_user_name: string | null;
          assignee_kind: string | null;
          awaiting_since: string | null;
          bot_silenced_until: string | null;
          channel: string;
          channel_session_id: string;
          contact_id: string;
          contato_trava_humano: boolean;
          created_at: string;
          current_demanda_id: string | null;
          group_chat_id: string | null;
          id: string;
          is_group: boolean;
          last_handoff_at: string | null;
          last_handoff_reason: string | null;
          last_inbound_at: string | null;
          last_message_at: string | null;
          last_message_preview: string | null;
          last_outbound_at: string | null;
          metadata: NonNullable<Json>;
          organization_id: string;
          provider_conversation_id: string | null;
          rag_review_status: string | null;
          reply_context_revision: number;
          service_closed_at: string | null;
          service_revision: number;
          service_started_at: string | null;
          snooze_until: string | null;
          snoozed_at: string | null;
          snoozed_by_user_id: string | null;
          status: string;
          status_changed_at: string;
          tags: string[];
          unread_count_for_assignee: number;
          updated_at: string;
          usable_for_rag: boolean;
          usable_for_rag_marked_at: string | null;
          usable_for_rag_marked_by: string | null;
        }[];
        SetofOptions: {
          from: "*";
          to: "conversations";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      fn_conversation_scope: {
        Args: Record<PropertyKey, never>;
        Returns: {
          org_wide_read: boolean;
          organization_id: string;
          sees_unassigned: boolean;
        }[];
      };
      fn_corpos_de_lembrete_validos: { Args: { p_corpos: Json }; Returns: boolean };
      fn_create_tenant_with_owner: {
        Args: { p_actor: string; p_hash: string; p_key: string; p_request: Json };
        Returns: Json;
      };
      fn_decrypt_oauth: { Args: { ciphertext: string }; Returns: string };
      fn_definir_aviso_de_agendamento: {
        Args: {
          p_channel: string;
          p_confirma_contato?: boolean;
          p_ligado: boolean;
          p_org: string;
          p_telefone: string;
          p_usa_numero_do_aviso_de_caso: boolean;
        };
        Returns: Json;
      };
      fn_definir_aviso_de_caso: {
        Args: {
          p_channel: string;
          p_confirma_contato?: boolean;
          p_ligado: boolean;
          p_org: string;
          p_resposta_whatsapp_habilitada?: boolean;
          p_rotulo: string;
          p_telefone: string;
        };
        Returns: Json;
      };
      fn_definir_canal_desativado: {
        Args: { p_canal: string; p_desativado: boolean; p_org: string };
        Returns: number;
      };
      fn_definir_carteira_do_cliente: {
        Args: {
          p_actor: string;
          p_contact: string;
          p_dono: string;
          p_org: string;
          p_origem?: string;
        };
        Returns: string;
      };
      fn_definir_cliente_pela_agenda: { Args: { p_ligado: boolean; p_org: string }; Returns: Json };
      fn_definir_colegas_podem_mexer_na_agenda: {
        Args: { p_ligado: boolean; p_org: string };
        Returns: Json;
      };
      fn_definir_google_meet_acesso_aberto: {
        Args: { p_ligado: boolean; p_org: string };
        Returns: Json;
      };
      fn_definir_logo_da_organizacao: {
        Args: { p_actor: string; p_org: string; p_path: string };
        Returns: number;
      };
      fn_definir_logo_por_tema_da_organizacao: {
        Args: { p_actor: string; p_org: string; p_path: string; p_tema: string };
        Returns: number;
      };
      fn_definir_marca_da_organizacao: {
        Args: { p_actor: string; p_marca: Json; p_org: string };
        Returns: number;
      };
      fn_definir_meta_lead_birth: { Args: { p_enabled: boolean; p_org: string }; Returns: string };
      fn_definir_pausa_de_canal: {
        Args: {
          p_agenda: string;
          p_canal: string;
          p_desativado: boolean;
          p_org: string;
          p_origem: string;
        };
        Returns: number;
      };
      fn_degraus_de_lembrete_validos: { Args: { p_degraus: number[] }; Returns: boolean };
      fn_demanda_encerrar: {
        Args: {
          p_actor: string;
          p_demanda: string;
          p_desfecho: string;
          p_expected: number;
          p_org: string;
        };
        Returns: {
          aberta_em: string;
          agent_case_id: string | null;
          assunto: string | null;
          contact_id: string;
          created_at: string;
          desfecho: string | null;
          dono_kind: string;
          dono_user_id: string | null;
          encerrada_por: string | null;
          estado: string;
          fechada_em: string | null;
          id: string;
          lead_id: string | null;
          organization_id: string;
          origem: string;
          prazo_em: string | null;
          proximo_passo: string | null;
          proximo_passo_em: string | null;
          revision: number;
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "demandas";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      fn_encerrar_roteiros_vencidos: { Args: { p_limite?: number }; Returns: number };
      fn_encrypt_oauth: { Args: { plaintext: string }; Returns: string };
      fn_end_support: { Args: { p_actor: string; p_session: string }; Returns: Json };
      fn_enfileirar_midia_vencida: { Args: { p_limite?: number }; Returns: Json };
      fn_estampar_atribuicao_de_anuncio: {
        Args: { p_contact: string; p_metadata: Json; p_org: string; p_platform: string };
        Returns: undefined;
      };
      fn_estornar_comanda: {
        Args: { p_motivo: string; p_org: string; p_sale: string };
        Returns: Json;
      };
      fn_event_log_e_registro: { Args: { p_event_type: string }; Returns: boolean };
      fn_evento_visivel_ao_atendente: {
        Args: { p_entity_id: string; p_entity_kind: string; p_org: string; p_payload: Json };
        Returns: boolean;
      };
      fn_excluir_organizacao: {
        Args: {
          p_actor: string;
          p_confirmacao: string;
          p_motivo: string;
          p_org: string;
          p_request_id?: string;
        };
        Returns: Json;
      };
      fn_expurgar_auditoria_vencida: {
        Args: { p_limite?: number; p_retencao_dias?: number };
        Returns: number;
      };
      fn_expurgar_avisos_de_agendamento_vencidos: {
        Args: { p_limite?: number; p_retencao_dias?: number };
        Returns: number;
      };
      fn_expurgar_avisos_de_caso_vencidos: {
        Args: { p_limite?: number; p_retencao_dias?: number };
        Returns: number;
      };
      fn_expurgar_candidatos_do_golden: {
        Args: { p_limite?: number; p_retencao_dias?: number };
        Returns: number;
      };
      fn_expurgar_checkpoints_superados: {
        Args: { p_limite?: number; p_retencao_dias?: number };
        Returns: number;
      };
      fn_expurgar_conversa_do_caso_vencida: {
        Args: { p_limite?: number; p_retencao_dias?: number };
        Returns: number;
      };
      fn_expurgar_copias_enviadas_vencidas: {
        Args: { p_limite?: number; p_retencao_dias?: number };
        Returns: number;
      };
      fn_expurgar_espelho_da_agenda: {
        Args: { p_limite?: number; p_retencao_dias?: number };
        Returns: number;
      };
      fn_expurgar_nonces_de_oauth: {
        Args: { p_limite?: number; p_retencao_dias?: number };
        Returns: number;
      };
      fn_expurgar_observacoes_do_jev: {
        Args: { p_limite?: number; p_retencao_dias?: number };
        Returns: number;
      };
      fn_expurgar_passagens_vencidas: {
        Args: { p_limite?: number; p_retencao_dias?: number };
        Returns: number;
      };
      fn_expurgar_prospeccao_vencida: {
        Args: { p_limite?: number; p_retencao_dias?: number };
        Returns: number;
      };
      fn_expurgar_ritmo_de_envio_vencido: {
        Args: { p_limite?: number; p_retencao_dias?: number };
        Returns: number;
      };
      fn_expurgar_telemetria_de_ia_vencida: {
        Args: { p_limite?: number; p_retencao_dias?: number };
        Returns: number;
      };
      fn_expurgar_traco_do_turno_vencido: {
        Args: { p_limite?: number; p_retencao_dias?: number };
        Returns: number;
      };
      fn_extensions_admit_catalog: {
        Args: { p_actor: string; p_digest: string; p_operation: string; p_snapshot: Json };
        Returns: Json;
      };
      fn_extensions_assert_actor: {
        Args: { p_actor: string; p_organization?: string };
        Returns: undefined;
      };
      fn_extensions_cancel_install: {
        Args: { p_actor: string; p_operation: string };
        Returns: Json;
      };
      fn_extensions_configure: {
        Args: {
          p_actor: string;
          p_configuration: Json;
          p_enabled: boolean;
          p_expected_revision: number;
          p_installation: string;
          p_operation: string;
          p_organization: string;
        };
        Returns: Json;
      };
      fn_extensions_core_update_in_progress: { Args: Record<PropertyKey, never>; Returns: boolean };
      fn_extensions_fail_install: {
        Args: { p_actor: string; p_error_code: string; p_operation: string };
        Returns: Json;
      };
      fn_extensions_fingerprint: { Args: { p_request: Json }; Returns: string };
      fn_extensions_finish_install: {
        Args: {
          p_actor: string;
          p_byte_length: number;
          p_document: string;
          p_manifest: Json;
          p_operation: string;
          p_sha256: string;
        };
        Returns: Json;
      };
      fn_extensions_installation_counts: {
        Args: { p_actor: string };
        Returns: {
          active_organizations: number;
          awaiting_reactivation: number;
          installation_id: string;
        }[];
      };
      fn_extensions_permissoes_validas: { Args: { p_permissions: Json }; Returns: boolean };
      fn_extensions_prepare_install: {
        Args: {
          p_actor: string;
          p_catalog: string;
          p_expected_installation_revision: number;
          p_name: string;
          p_operation: string;
          p_publisher: string;
          p_version: string;
        };
        Returns: Json;
      };
      fn_extensions_remove_installation: {
        Args: {
          p_actor: string;
          p_expected_installation_revision: number;
          p_installation: string;
          p_operation: string;
        };
        Returns: Json;
      };
      fn_extensions_revert_install: {
        Args: {
          p_actor: string;
          p_expected_installation_revision: number;
          p_installation: string;
          p_operation: string;
        };
        Returns: Json;
      };
      fn_finalizar_comanda: {
        Args: {
          p_loyalty_points?: number;
          p_org: string;
          p_payment_method: string;
          p_sale: string;
        };
        Returns: Json;
      };
      fn_financeiro_declarar_secoes_lgpd: { Args: Record<PropertyKey, never>; Returns: undefined };
      fn_financeiro_ligar_caixa_a_comanda: { Args: Record<PropertyKey, never>; Returns: undefined };
      fn_financeiro_provisionar: { Args: Record<PropertyKey, never>; Returns: undefined };
      fn_finish_channel_connection: {
        Args: {
          p_created?: boolean;
          p_lease: string;
          p_org: string;
          p_reason?: string;
          p_receipt: string;
          p_status: string;
        };
        Returns: Json;
      };
      fn_followup_apply_step: {
        Args: { p_event: Json; p_id: string; p_org: string; p_patch: Json; p_revision: number };
        Returns: number;
      };
      fn_followup_claim_current: {
        Args: { p_acquired_at: string; p_job: string; p_org: string; p_worker: string };
        Returns: boolean;
      };
      fn_followup_inline_settle: {
        Args: {
          p_acquired_at?: string;
          p_done: boolean;
          p_error?: string;
          p_hold?: boolean;
          p_id: string;
          p_org: string;
          p_retry_at?: string;
          p_worker: string;
        };
        Returns: boolean;
      };
      fn_followup_job_current: {
        Args: { p_enrollment: string; p_job: string; p_node: string; p_org: string };
        Returns: boolean;
      };
      fn_followup_patch: {
        Args: { p_id: string; p_org: string; p_patch: Json; p_revision: number };
        Returns: number;
      };
      fn_followup_turno_descartado: { Args: { p_job: string; p_org: string }; Returns: boolean };
      fn_gasto_de_ia_do_mes: { Args: { p_org: string }; Returns: number };
      fn_go_live_solta_numero_formado: { Args: Record<PropertyKey, never>; Returns: number };
      fn_google_appointment: {
        Args: { p_action: string; p_args?: Json; p_id: string; p_org: string };
        Returns: Json;
      };
      fn_google_calendar: {
        Args: { p_action: string; p_args?: Json; p_id: string; p_org: string };
        Returns: Json;
      };
      fn_google_calendar_fence: {
        Args: { p_claim: Json; p_cursor?: Json; p_id: string; p_org: string };
        Returns: undefined;
      };
      fn_google_calendar_page_batch: {
        Args: { p_args: Json; p_id: string; p_org: string };
        Returns: Json;
      };
      fn_google_catalog: {
        Args: { p_connection: string; p_items: Json; p_org: string; p_revision: string };
        Returns: undefined;
      };
      fn_google_counts_for_conflicts: {
        Args: { p_calendar: string; p_connection: string; p_org: string };
        Returns: boolean;
      };
      fn_google_coverage: {
        Args: { p_end: string; p_org: string; p_owner: string; p_start: string };
        Returns: boolean;
      };
      fn_google_resolve: {
        Args: {
          p_choice: string;
          p_etag: string;
          p_id: string;
          p_local_revision: string;
          p_org: string;
          p_revision: string;
        };
        Returns: undefined;
      };
      fn_google_selection: {
        Args: { p_destination: string; p_org: string; p_revisions: Json; p_sources: string[] };
        Returns: undefined;
      };
      fn_honorarios_parcela_pagar: {
        Args: {
          p_account_id: string;
          p_account_plan_id?: string;
          p_org: string;
          p_parcela: string;
        };
        Returns: Json;
      };
      fn_honorarios_provisionar: { Args: Record<PropertyKey, never>; Returns: undefined };
      fn_is_platform_admin: { Args: Record<PropertyKey, never>; Returns: boolean };
      fn_is_platform_admin_full: { Args: Record<PropertyKey, never>; Returns: boolean };
      fn_lead_adicionar_etiquetas: {
        Args: { p_etiquetas: string[]; p_lead: string; p_org: string };
        Returns: Json;
      };
      fn_lead_anotar_campos: {
        Args: { p_campos: Json; p_lead: string; p_org: string };
        Returns: Json;
      };
      fn_lgpd_anonymize_contact: {
        Args: { p_contact_id: string; p_organization_id: string };
        Returns: Json;
      };
      fn_lgpd_cascade_redact_contact: {
        Args: { p_contact_id: string; p_organization_id: string; p_request_id: string };
        Returns: Json;
      };
      fn_lgpd_redigir_tool_calls: { Args: { p_tool_calls: Json }; Returns: Json };
      fn_lgpd_rotulo_anonimizado: { Args: { p_contact_id: string }; Returns: string };
      fn_limite_do_plano: { Args: { p_org: string; p_recurso: string }; Returns: number };
      fn_log_event: {
        Args: { p_event_type: string; p_organization_id: string; p_payload?: Json };
        Returns: string;
      };
      fn_logins_sem_vinculo: { Args: { p_users: string[] }; Returns: string[] };
      fn_mark_conversation_message: {
        Args: { p_at: string; p_conv: string; p_direction: string; p_preview: string };
        Returns: undefined;
      };
      fn_meet_action: {
        Args: {
          p_action: string;
          p_conversation?: string;
          p_id: string;
          p_org: string;
          p_request: string;
          p_revision: string;
        };
        Returns: boolean;
      };
      fn_meet_boundary_current: { Args: { b: Json }; Returns: boolean };
      fn_meet_delivery_current: {
        Args: { p_acquired_at: string; p_job: string; p_org: string; p_worker: string };
        Returns: boolean;
      };
      fn_meet_delivery_policy: {
        Args: { p_acquired_at: string; p_job: string; p_org: string; p_worker: string };
        Returns: Json;
      };
      fn_meet_delivery_settle: {
        Args: {
          p_acquired_at: string;
          p_job: string;
          p_org: string;
          p_retry_at?: string;
          p_state: string;
          p_worker: string;
        };
        Returns: boolean;
      };
      fn_meet_notice: {
        Args: { p_id: string; p_org: string; p_reason: string };
        Returns: undefined;
      };
      fn_meet_observe: { Args: { p_args: Json; p_id: string; p_org: string }; Returns: undefined };
      fn_member_role_in_org: { Args: { p_org: string; p_user: string }; Returns: string };
      fn_mesclar_contatos: {
        Args: {
          p_contato_principal: string;
          p_contatos_secundarios: string[];
          p_organization_id: string;
        };
        Returns: Json;
      };
      fn_meta_ctwa_click_enviado_legado: {
        Args: { p_clid: string; p_org: string };
        Returns: boolean;
      };
      fn_metricas_links_rastreaveis: {
        Args: { p_org: string };
        Returns: {
          clicks: number;
          contacts: number;
          leads: number;
          link_id: string;
        }[];
      };
      fn_modulo_dados_compilar: { Args: { p_artifact_id: string }; Returns: Json };
      fn_modulo_instalar: {
        Args: { p_actor: string; p_modulo: string; p_operation: string };
        Returns: Json;
      };
      fn_mover_leads_em_lote: {
        Args: {
          p_lead_ids: string[];
          p_lost_reason?: string;
          p_organization_id: string;
          p_stage_id: string;
        };
        Returns: {
          from_stage_id: string;
          lead_id: string;
          pipeline_id: string;
        }[];
      };
      fn_nascer_lead_da_conversa: {
        Args: {
          p_contact: string;
          p_org: string;
          p_pipeline: string;
          p_source: string;
          p_source_metadata?: Json;
          p_stage: string;
          p_tags?: string[];
          p_title: string;
        };
        Returns: string;
      };
      fn_nascer_lead_da_mensagem: {
        Args: {
          p_contact: string;
          p_conversation: string;
          p_message: string;
          p_org: string;
          p_pipeline: string;
          p_source: string;
          p_source_metadata: Json;
          p_stage: string;
          p_tags: string[];
          p_title: string;
        };
        Returns: string;
      };
      fn_org_operante: { Args: { p_org: string }; Returns: boolean };
      fn_org_parada_descarta_fila: { Args: { p_org: string }; Returns: undefined };
      fn_passagem_devolvida: {
        Args: { p_conversation_id: string; p_organization_id: string };
        Returns: number;
      };
      fn_pgrst_recusar_replay_do_gateway: { Args: Record<PropertyKey, never>; Returns: undefined };
      fn_podar_fila_de_jobs: {
        Args: { p_limite?: number; p_retencao_dias?: number };
        Returns: number;
      };
      fn_proposta_aloca_numero: { Args: { p_ano: number; p_org: string }; Returns: number };
      fn_proteger_modulo_provisionado: { Args: Record<PropertyKey, never>; Returns: undefined };
      fn_proteger_tabelas_de_organizacao: { Args: Record<PropertyKey, never>; Returns: undefined };
      fn_proximo_numero_de_comanda: { Args: { p_org: string }; Returns: number };
      fn_publish_ai_agent_version:
        | {
            Args: { p_agent_id: string; p_org_id: string; p_version_id: string };
            Returns: {
              agent_id: string;
              previous_version_id: string;
              published_at: string;
              version_id: string;
            }[];
          }
        | {
            Args: {
              p_agent_id: string;
              p_org_id: string;
              p_platform_credential_verified: boolean;
              p_version_id: string;
            };
            Returns: {
              agent_id: string;
              previous_version_id: string;
              published_at: string;
              version_id: string;
            }[];
          }
        | {
            Args: {
              p_agent_id: string;
              p_expected_provenance: string;
              p_org_id: string;
              p_platform_credential_verified: boolean;
              p_version_id: string;
            };
            Returns: {
              agent_id: string;
              previous_version_id: string;
              published_at: string;
              version_id: string;
            }[];
          };
      fn_publish_followup_flow_version: {
        Args: { p_created_by: string; p_graph: Json; p_org: string; p_pointer: string };
        Returns: string;
      };
      fn_push_inscricoes_que_veem_a_conversa: {
        Args: { p_conversation: string; p_org: string };
        Returns: {
          auth: string;
          endpoint: string;
          id: string;
          p256dh: string;
          user_id: string;
        }[];
      };
      fn_reaplicar_modulos_instalados: { Args: Record<PropertyKey, never>; Returns: undefined };
      fn_reativar_organizacao: {
        Args: { p_ator: string; p_kind_exigido: string; p_org: string };
        Returns: Json;
      };
      fn_recalcular_cliente_do_contato: {
        Args: { p_contact: string; p_emitir: boolean; p_org: string };
        Returns: string;
      };
      fn_registrar_jid_do_aviso: { Args: { p_jid: string; p_org: string }; Returns: undefined };
      fn_relatorio_financeiro: {
        Args: { p_ate: string; p_de: string; p_org: string };
        Returns: Json;
      };
      fn_reply_action: {
        Args: {
          p_action: string;
          p_body?: string;
          p_feedback?: string;
          p_id: string;
          p_org: string;
          p_revision: string;
        };
        Returns: string;
      };
      fn_reply_begin: {
        Args: {
          p_agent: string;
          p_conversation: string;
          p_org: string;
          p_token: string;
          p_version: string;
        };
        Returns: {
          agent_id: string;
          agent_version_id: string;
          approved_at: string | null;
          approved_body: string | null;
          approved_by: string | null;
          approved_support_session_id: string | null;
          channel_session_id: string;
          contact_id: string;
          context_revision: number;
          conversation_id: string;
          created_at: string;
          edited_body: string | null;
          error_code: string | null;
          feedback: Json | null;
          generation_token: string;
          id: string;
          message_id: string | null;
          operation_revision: number;
          organization_id: string;
          original_body: string | null;
          proposals: NonNullable<Json>;
          revision: number;
          send_job_id: string | null;
          service_boundary: NonNullable<Json>;
          status: string;
          trace: NonNullable<Json>;
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "ai_reply_drafts";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      fn_reply_context_current: { Args: { p_id: string; p_org: string }; Returns: boolean };
      fn_reply_delivery_policy: {
        Args: { p_acquired_at: string; p_job: string; p_org: string; p_worker: string };
        Returns: Json;
      };
      fn_reply_prepare: {
        Args: { p_acquired_at: string; p_job: string; p_org: string; p_worker: string };
        Returns: boolean;
      };
      fn_reply_receipt_policy: {
        Args: { p_acquired_at: string; p_job: string; p_org: string; p_worker: string };
        Returns: Json;
      };
      fn_reply_record_receipt: {
        Args: {
          p_acquired_at: string;
          p_echo_ids?: string[];
          p_external: string;
          p_job: string;
          p_message: string;
          p_org: string;
          p_worker: string;
        };
        Returns: Json;
      };
      fn_reply_settle: {
        Args: {
          p_acquired_at: string;
          p_error?: string;
          p_job: string;
          p_org: string;
          p_state: string;
          p_worker: string;
        };
        Returns: boolean;
      };
      fn_request_channel_routing: {
        Args: { p_conversation: string; p_org: string };
        Returns: undefined;
      };
      fn_reserve_channel_connection: {
        Args: {
          p_display_name?: string;
          p_hash: string;
          p_key: string;
          p_onboarding?: boolean;
          p_org: string;
        };
        Returns: Json;
      };
      fn_resolve_inbound_number: {
        Args: { p_number: string };
        Returns: {
          default_ai_agent_id: string;
          fallback_user_id: string;
          organization_id: string;
          routing_mode: string;
        }[];
      };
      fn_resolver_avisos_de_lembrete_expirados: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      fn_responder_caso_por_whatsapp: {
        Args: {
          p_action: string;
          p_body: string;
          p_case: string;
          p_message_key: string;
          p_org: string;
          p_phone_variants: string[];
          p_session: string;
        };
        Returns: string;
      };
      fn_role_at_least: { Args: { p_min: string; p_org: string }; Returns: boolean };
      fn_routing_unassigned_notice: {
        Args: { p_conversation: string; p_org: string; p_reason: string };
        Returns: undefined;
      };
      fn_saldo_de_fidelidade: { Args: { p_contact: string; p_org: string }; Returns: number };
      fn_semear_tipos_de_agendamento: { Args: { p_organization_id: string }; Returns: number };
      fn_service_begin: {
        Args: { p_contact: string; p_observed?: Json; p_org: string; p_session?: string };
        Returns: Json;
      };
      fn_service_boundary: { Args: { p_conversation: string; p_org: string }; Returns: Json };
      fn_service_event_contact: {
        Args: { p_entity_id: string; p_entity_kind: string; p_event_type: string; p_org: string };
        Returns: {
          contact_id: string;
          suportado: boolean;
        }[];
      };
      fn_service_event_origin: {
        Args: { p_contact: string; p_event: string; p_org: string; p_session?: string };
        Returns: Json;
      };
      fn_service_inbound: { Args: { p_message: string }; Returns: undefined };
      fn_service_lock: { Args: { p_contact: string; p_org: string }; Returns: undefined };
      fn_service_observe: { Args: { p_contact: string; p_org: string }; Returns: Json };
      fn_service_observe_command: { Args: { p_contact: string; p_org: string }; Returns: Json };
      fn_service_status: {
        Args: { p_conversation: string; p_expected?: number; p_org: string; p_status: string };
        Returns: {
          active_agent_set_at: string | null;
          active_ai_agent_id: string | null;
          active_intent: string | null;
          assigned_at: string | null;
          assigned_to_user_id: string | null;
          assigned_to_user_name: string | null;
          assignee_kind: string | null;
          awaiting_since: string | null;
          bot_silenced_until: string | null;
          channel: string;
          channel_session_id: string;
          contact_id: string;
          contato_trava_humano: boolean;
          created_at: string;
          current_demanda_id: string | null;
          group_chat_id: string | null;
          id: string;
          is_group: boolean;
          last_handoff_at: string | null;
          last_handoff_reason: string | null;
          last_inbound_at: string | null;
          last_message_at: string | null;
          last_message_preview: string | null;
          last_outbound_at: string | null;
          metadata: NonNullable<Json>;
          organization_id: string;
          provider_conversation_id: string | null;
          rag_review_status: string | null;
          reply_context_revision: number;
          service_closed_at: string | null;
          service_revision: number;
          service_started_at: string | null;
          snooze_until: string | null;
          snoozed_at: string | null;
          snoozed_by_user_id: string | null;
          status: string;
          status_changed_at: string;
          tags: string[];
          unread_count_for_assignee: number;
          updated_at: string;
          usable_for_rag: boolean;
          usable_for_rag_marked_at: string | null;
          usable_for_rag_marked_by: string | null;
        };
        SetofOptions: {
          from: "*";
          to: "conversations";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      fn_session_mfa_proven: { Args: Record<PropertyKey, never>; Returns: boolean };
      fn_set_channel_routing: {
        Args: {
          p_channel: string;
          p_default_assignee?: string;
          p_mode?: string;
          p_org: string;
          p_reset?: boolean;
          p_users: string[];
        };
        Returns: Json;
      };
      fn_settle_meta_ctwa_click: {
        Args: {
          p_click: string;
          p_detail: string;
          p_org: string;
          p_reason: string;
          p_status: string;
          p_token: string;
        };
        Returns: boolean;
      };
      fn_settle_meta_lead_submitted: {
        Args: {
          p_detail: string;
          p_lead: string;
          p_org: string;
          p_reason: string;
          p_status: string;
          p_token: string;
        };
        Returns: boolean;
      };
      fn_situacao_conta_como_atendimento: { Args: { p_status: string }; Returns: boolean };
      fn_solicitar_reenvio_conversao:
        | { Args: { p_lead: string; p_org: string }; Returns: boolean }
        | { Args: { p_event: string; p_lead: string; p_org: string }; Returns: boolean };
      fn_solicitar_reenvio_meta_ctwa_click: {
        Args: { p_click: string; p_org: string };
        Returns: boolean;
      };
      fn_start_support: {
        Args: {
          p_actor: string;
          p_mode?: string;
          p_org: string;
          p_previous: string;
          p_session: string;
          p_ttl?: number;
        };
        Returns: string;
      };
      fn_support_callback_write_allowed: {
        Args: { p_actor?: string; p_org: string; p_session?: string };
        Returns: boolean;
      };
      fn_support_context: { Args: Record<PropertyKey, never>; Returns: Json };
      fn_support_storage_write_allowed: { Args: { p_name: string }; Returns: boolean };
      fn_support_write_allowed: { Args: { p_org: string }; Returns: boolean };
      fn_suspender_organizacao: {
        Args: { p_ator: string; p_kind: string; p_motivo: string; p_org: string };
        Returns: Json;
      };
      fn_tags_de_conversa_em_uso: {
        Args: { p_org: string };
        Returns: {
          tag: string;
        }[];
      };
      fn_tags_normalizar: {
        Args: { p_de: string; p_para: string; p_remover: boolean; p_tags: string[] };
        Returns: string[];
      };
      fn_telefone_variantes: { Args: { p_telefone: string }; Returns: string[] };
      fn_titular_apagado_a_pedido: {
        Args: { p_lid: string; p_org: string; p_telefone: string };
        Returns: boolean;
      };
      fn_upsert_wa_contact: {
        Args: {
          p_chat_id: string;
          p_kind: string;
          p_lid: string;
          p_notify: string;
          p_org: string;
          p_phone: string;
        };
        Returns: string;
      };
      fn_upsert_wa_conversation: {
        Args: { p_contact: string; p_org: string; p_session: string };
        Returns: string;
      };
      fn_upsert_wa_conversation_importada: {
        Args: { p_contact: string; p_last_message_at: string; p_org: string; p_session: string };
        Returns: string;
      };
      fn_user_org_ids: { Args: Record<PropertyKey, never>; Returns: string[] };
      fn_user_role_in: { Args: { p_org: string }; Returns: number };
      fn_user_role_in_org: { Args: { p_org: string }; Returns: string };
      fn_uso_de_ia: {
        Args: {
          p_agent_id?: string;
          p_ate: string;
          p_desde: string;
          p_org: string;
          p_purpose?: string;
        };
        Returns: Json;
      };
      fn_vaga_ao_reviver_canal: { Args: { p_org: string; p_canal: string }; Returns: undefined };
      fn_vocabulario_de_tags: {
        Args: { p_org: string };
        Returns: {
          cor: string;
          descricao: string;
          em_regras: number;
          no_vocabulario: boolean;
          tag: string;
          uso_em_contatos: number;
          uso_em_conversas: number;
          uso_em_leads: number;
        }[];
      };
      fn_vocabulario_de_tags_operar: {
        Args: { p_acao: string; p_cor?: string; p_destino: string; p_org: string; p_tag: string };
        Returns: Json;
      };
      fn_vocabulario_de_tags_pagina: {
        Args: { p_busca?: string; p_limit?: number; p_offset?: number; p_org: string };
        Returns: Json;
      };
      fn_wake_channel_routing: { Args: { p_channel?: string; p_org: string }; Returns: undefined };
      midpoint: { Args: { p_next: number; p_prev: number }; Returns: number };
      retrieve_top_k_chunks: {
        Args: {
          p_embedding: string;
          p_k?: number;
          p_kb_version_id: string;
          p_organization_id: string;
          p_threshold?: number;
        };
        Returns: {
          chunk_id: string;
          content: string;
          knowledge_source_id: string;
          metadata: Json;
          similarity: number;
        }[];
      };
      show_limit: { Args: Record<PropertyKey, never>; Returns: number };
      show_trgm: { Args: { "": string }; Returns: string[] };
      tags_do_contato: {
        Args: {
          c: Omit<
            Database["public"]["Tables"]["conversations"]["Row"],
            Database["public"]["Tables"]["conversations"]["ComputedFields"]
          >;
        };
        Returns: string[];
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
