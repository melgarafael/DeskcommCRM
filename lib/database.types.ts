export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
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
          tool_calls: Json;
        };
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
          tool_calls?: Json;
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
          tool_calls?: Json;
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
      ai_agent_versions: {
        Row: {
          agent_id: string;
          channel_session_id: string;
          cost_budget_cents: number;
          created_at: string;
          created_by: string | null;
          credential_id: string | null;
          handoff_keywords: string[];
          handoff_tool_enabled: boolean;
          history_message_window: number;
          history_token_window: number;
          id: string;
          max_steps: number;
          model: string;
          organization_id: string;
          provider: string;
          published_at: string | null;
          status: string;
          superseded_at: string | null;
          system_prompt: string;
          token_budget: number;
          tool_ids: string[];
          trigger_config: Json;
          version_number: number;
        };
        Insert: {
          agent_id: string;
          channel_session_id: string;
          cost_budget_cents?: number;
          created_at?: string;
          created_by?: string | null;
          credential_id?: string | null;
          handoff_keywords?: string[];
          handoff_tool_enabled?: boolean;
          history_message_window?: number;
          history_token_window?: number;
          id?: string;
          max_steps?: number;
          model: string;
          organization_id: string;
          provider: string;
          published_at?: string | null;
          status?: string;
          superseded_at?: string | null;
          system_prompt: string;
          token_budget?: number;
          tool_ids?: string[];
          trigger_config?: Json;
          version_number: number;
        };
        Update: {
          agent_id?: string;
          channel_session_id?: string;
          cost_budget_cents?: number;
          created_at?: string;
          created_by?: string | null;
          credential_id?: string | null;
          handoff_keywords?: string[];
          handoff_tool_enabled?: boolean;
          history_message_window?: number;
          history_token_window?: number;
          id?: string;
          max_steps?: number;
          model?: string;
          organization_id?: string;
          provider?: string;
          published_at?: string | null;
          status?: string;
          superseded_at?: string | null;
          system_prompt?: string;
          token_budget?: number;
          tool_ids?: string[];
          trigger_config?: Json;
          version_number?: number;
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
          config: Json;
          created_at: string;
          created_by: string | null;
          description: string | null;
          guardrails: Json;
          id: string;
          is_active: boolean;
          is_default: boolean;
          kind: string;
          model: string;
          name: string;
          organization_id: string;
          priority: number;
          published_version_id: string | null;
          system_prompt: string;
          updated_at: string;
        };
        Insert: {
          active_kb_version_id?: string | null;
          archived_at?: string | null;
          config?: Json;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          guardrails?: Json;
          id?: string;
          is_active?: boolean;
          is_default?: boolean;
          kind?: string;
          model?: string;
          name: string;
          organization_id: string;
          priority?: number;
          published_version_id?: string | null;
          system_prompt: string;
          updated_at?: string;
        };
        Update: {
          active_kb_version_id?: string | null;
          archived_at?: string | null;
          config?: Json;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          guardrails?: Json;
          id?: string;
          is_active?: boolean;
          is_default?: boolean;
          kind?: string;
          model?: string;
          name?: string;
          organization_id?: string;
          priority?: number;
          published_version_id?: string | null;
          system_prompt?: string;
          updated_at?: string;
        };
        Relationships: [
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
          is_disabled: boolean;
          is_throttled: boolean;
          last_alarm_sent_at: string | null;
          monthly_limit_cents: number;
          organization_id: string;
          updated_at: string;
        };
        Insert: {
          action_at_100pct?: string;
          alarm_threshold_pct?: number;
          current_month_consumed_cents?: number;
          current_period_start?: string;
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
          metadata: Json;
          organization_id: string;
          position: number;
          token_count: number;
        };
        Insert: {
          content: string;
          content_hash: string;
          created_at?: string;
          embedding: string;
          id?: string;
          kb_version_id: string;
          knowledge_source_id: string;
          metadata?: Json;
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
          metadata?: Json;
          organization_id?: string;
          position?: number;
          token_count?: number;
        };
        Relationships: [
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
          agent_id: string;
          citations: Json;
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
        Insert: {
          agent_id: string;
          citations?: Json;
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
          total_tokens?: number | null;
        };
        Update: {
          agent_id?: string;
          citations?: Json;
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
          total_tokens?: number | null;
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
          agent_id: string;
          chunks_count: number;
          created_at: string;
          id: string;
          ingested_at: string | null;
          is_active: boolean;
          last_index_error: string | null;
          last_index_status: string | null;
          last_indexed_at: string | null;
          name: string;
          organization_id: string;
          source_metadata: Json;
          source_type: string;
          status: string;
          updated_at: string;
        };
        Insert: {
          agent_id: string;
          chunks_count?: number;
          created_at?: string;
          id?: string;
          ingested_at?: string | null;
          is_active?: boolean;
          last_index_error?: string | null;
          last_index_status?: string | null;
          last_indexed_at?: string | null;
          name?: string;
          organization_id: string;
          source_metadata?: Json;
          source_type: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          agent_id?: string;
          chunks_count?: number;
          created_at?: string;
          id?: string;
          ingested_at?: string | null;
          is_active?: boolean;
          last_index_error?: string | null;
          last_index_status?: string | null;
          last_indexed_at?: string | null;
          name?: string;
          organization_id?: string;
          source_metadata?: Json;
          source_type?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
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
          agent_id: string;
          created_at: string;
          description: string | null;
          error_message: string | null;
          id: string;
          indexed_at: string | null;
          is_active: boolean;
          organization_id: string;
          sources_snapshot: Json;
          status: string | null;
          total_chunks: number;
          version_number: number;
        };
        Insert: {
          activated_at?: string | null;
          activated_by?: string | null;
          agent_id: string;
          created_at?: string;
          description?: string | null;
          error_message?: string | null;
          id?: string;
          indexed_at?: string | null;
          is_active?: boolean;
          organization_id: string;
          sources_snapshot?: Json;
          status?: string | null;
          total_chunks?: number;
          version_number: number;
        };
        Update: {
          activated_at?: string | null;
          activated_by?: string | null;
          agent_id?: string;
          created_at?: string;
          description?: string | null;
          error_message?: string | null;
          id?: string;
          indexed_at?: string | null;
          is_active?: boolean;
          organization_id?: string;
          sources_snapshot?: Json;
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
          id: string;
          input_price_per_million_cents: number | null;
          is_default_for_provider: boolean;
          metadata: Json;
          model_id: string;
          output_price_per_million_cents: number | null;
          provider: string;
          released_at: string | null;
          supports_tools: boolean;
        };
        Insert: {
          context_window?: number | null;
          deprecated_at?: string | null;
          description?: string | null;
          display_name: string;
          id?: string;
          input_price_per_million_cents?: number | null;
          is_default_for_provider?: boolean;
          metadata?: Json;
          model_id: string;
          output_price_per_million_cents?: number | null;
          provider: string;
          released_at?: string | null;
          supports_tools?: boolean;
        };
        Update: {
          context_window?: number | null;
          deprecated_at?: string | null;
          description?: string | null;
          display_name?: string;
          id?: string;
          input_price_per_million_cents?: number | null;
          is_default_for_provider?: boolean;
          metadata?: Json;
          model_id?: string;
          output_price_per_million_cents?: number | null;
          provider?: string;
          released_at?: string | null;
          supports_tools?: boolean;
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
        Insert: {
          api_key_encrypted: string;
          api_key_iv: string;
          api_key_last4: string;
          api_key_tag: string;
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
          metadata: Json;
          organization_id: string | null;
          request_id: string | null;
          resource_id: string | null;
          resource_type: string | null;
        };
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
          metadata?: Json;
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
          metadata?: Json;
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
          scopes: Json;
          token_hash: string;
          updated_at: string;
        };
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
          scopes?: Json;
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
          scopes?: Json;
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
      attendant_availability: {
        Row: {
          capacity: number;
          id: string;
          is_available: boolean;
          last_heartbeat_at: string | null;
          organization_id: string;
          schedule: Json;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          capacity?: number;
          id?: string;
          is_available?: boolean;
          last_heartbeat_at?: string | null;
          organization_id: string;
          schedule?: Json;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          capacity?: number;
          id?: string;
          is_available?: boolean;
          last_heartbeat_at?: string | null;
          organization_id?: string;
          schedule?: Json;
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
          consecutive_health_fails: number;
          created_at: string;
          created_by: string | null;
          daily_message_limit: number;
          display_name: string | null;
          engine: string;
          id: string;
          is_warmup_complete: boolean | null;
          last_health_check_at: string | null;
          last_status_change_at: string;
          metadata: Json;
          organization_id: string;
          phone_number: string | null;
          status: string;
          status_reason: string | null;
          updated_at: string;
          waha_session_name: string;
          warmup_completed_at: string | null;
          warmup_started_at: string | null;
          webhook_path_token: string;
          webhook_secret_encrypted: string;
        };
        Insert: {
          consecutive_health_fails?: number;
          created_at?: string;
          created_by?: string | null;
          daily_message_limit?: number;
          display_name?: string | null;
          engine?: string;
          id?: string;
          is_warmup_complete?: boolean | null;
          last_health_check_at?: string | null;
          last_status_change_at?: string;
          metadata?: Json;
          organization_id: string;
          phone_number?: string | null;
          status?: string;
          status_reason?: string | null;
          updated_at?: string;
          waha_session_name: string;
          warmup_completed_at?: string | null;
          warmup_started_at?: string | null;
          webhook_path_token?: string;
          webhook_secret_encrypted: string;
        };
        Update: {
          consecutive_health_fails?: number;
          created_at?: string;
          created_by?: string | null;
          daily_message_limit?: number;
          display_name?: string | null;
          engine?: string;
          id?: string;
          is_warmup_complete?: boolean | null;
          last_health_check_at?: string | null;
          last_status_change_at?: string;
          metadata?: Json;
          organization_id?: string;
          phone_number?: string | null;
          status?: string;
          status_reason?: string | null;
          updated_at?: string;
          waha_session_name?: string;
          warmup_completed_at?: string | null;
          warmup_started_at?: string | null;
          webhook_path_token?: string;
          webhook_secret_encrypted?: string;
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
      contacts: {
        Row: {
          anonymized_at: string | null;
          birthdate: string | null;
          blocked_at: string | null;
          blocked_reason: string | null;
          consent: Json;
          cpf_encrypted: string | null;
          cpf_hash: string | null;
          created_at: string;
          created_by_user_id: string | null;
          display_name: string | null;
          email: string | null;
          email_normalized: string | null;
          force_human: boolean;
          id: string;
          is_anonymized: boolean;
          is_blocked: boolean;
          is_merged_into: string | null;
          last_activity_at: string | null;
          merged_at: string | null;
          name: string | null;
          organization_id: string;
          phone_number: string | null;
          source: string;
          source_metadata: Json;
          tags: string[];
          updated_at: string;
          wa_identity: string | null;
        };
        Insert: {
          anonymized_at?: string | null;
          birthdate?: string | null;
          blocked_at?: string | null;
          blocked_reason?: string | null;
          consent?: Json;
          cpf_encrypted?: string | null;
          cpf_hash?: string | null;
          created_at?: string;
          created_by_user_id?: string | null;
          display_name?: string | null;
          email?: string | null;
          email_normalized?: string | null;
          force_human?: boolean;
          id?: string;
          is_anonymized?: boolean;
          is_blocked?: boolean;
          is_merged_into?: string | null;
          last_activity_at?: string | null;
          merged_at?: string | null;
          name?: string | null;
          organization_id: string;
          phone_number?: string | null;
          source?: string;
          source_metadata?: Json;
          tags?: string[];
          updated_at?: string;
          wa_identity?: string | null;
        };
        Update: {
          anonymized_at?: string | null;
          birthdate?: string | null;
          blocked_at?: string | null;
          blocked_reason?: string | null;
          consent?: Json;
          cpf_encrypted?: string | null;
          cpf_hash?: string | null;
          created_at?: string;
          created_by_user_id?: string | null;
          display_name?: string | null;
          email?: string | null;
          email_normalized?: string | null;
          force_human?: boolean;
          id?: string;
          is_anonymized?: boolean;
          is_blocked?: boolean;
          is_merged_into?: string | null;
          last_activity_at?: string | null;
          merged_at?: string | null;
          name?: string | null;
          organization_id?: string;
          phone_number?: string | null;
          source?: string;
          source_metadata?: Json;
          tags?: string[];
          updated_at?: string;
          wa_identity?: string | null;
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
      conversations: {
        Row: {
          assigned_at: string | null;
          assigned_to_user_id: string | null;
          assignee_kind: string | null;
          bot_silenced_until: string | null;
          channel: string;
          channel_session_id: string;
          contact_id: string;
          created_at: string;
          group_chat_id: string | null;
          id: string;
          is_group: boolean;
          last_handoff_at: string | null;
          last_handoff_reason: string | null;
          last_inbound_at: string | null;
          last_message_at: string | null;
          last_message_preview: string | null;
          last_outbound_at: string | null;
          metadata: Json;
          organization_id: string;
          rag_review_status: string | null;
          status: string;
          status_changed_at: string;
          tags: string[];
          unread_count_for_assignee: number;
          updated_at: string;
          usable_for_rag: boolean;
          usable_for_rag_marked_at: string | null;
          usable_for_rag_marked_by: string | null;
        };
        Insert: {
          assigned_at?: string | null;
          assigned_to_user_id?: string | null;
          assignee_kind?: string | null;
          bot_silenced_until?: string | null;
          channel?: string;
          channel_session_id: string;
          contact_id: string;
          created_at?: string;
          group_chat_id?: string | null;
          id?: string;
          is_group?: boolean;
          last_handoff_at?: string | null;
          last_handoff_reason?: string | null;
          last_inbound_at?: string | null;
          last_message_at?: string | null;
          last_message_preview?: string | null;
          last_outbound_at?: string | null;
          metadata?: Json;
          organization_id: string;
          rag_review_status?: string | null;
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
          assigned_at?: string | null;
          assigned_to_user_id?: string | null;
          assignee_kind?: string | null;
          bot_silenced_until?: string | null;
          channel?: string;
          channel_session_id?: string;
          contact_id?: string;
          created_at?: string;
          group_chat_id?: string | null;
          id?: string;
          is_group?: boolean;
          last_handoff_at?: string | null;
          last_handoff_reason?: string | null;
          last_inbound_at?: string | null;
          last_message_at?: string | null;
          last_message_preview?: string | null;
          last_outbound_at?: string | null;
          metadata?: Json;
          organization_id?: string;
          rag_review_status?: string | null;
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
          contact_id: string | null;
          created_at: string;
          id: string;
          lead_id: string;
          metadata: Json;
          organization_id: string;
          payload: Json;
          performed_at: string;
          performed_by_user_id: string | null;
          source_id: string | null;
          source_module: string;
          type: string;
        };
        Insert: {
          contact_id?: string | null;
          created_at?: string;
          id?: string;
          lead_id: string;
          metadata?: Json;
          organization_id: string;
          payload?: Json;
          performed_at?: string;
          performed_by_user_id?: string | null;
          source_id?: string | null;
          source_module: string;
          type: string;
        };
        Update: {
          contact_id?: string | null;
          created_at?: string;
          id?: string;
          lead_id?: string;
          metadata?: Json;
          organization_id?: string;
          payload?: Json;
          performed_at?: string;
          performed_by_user_id?: string | null;
          source_id?: string | null;
          source_module?: string;
          type?: string;
        };
        Relationships: [
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
      crm_lead_links: {
        Row: {
          created_at: string;
          created_by_user_id: string | null;
          id: string;
          lead_id: string;
          link_kind: string;
          metadata: Json;
          organization_id: string;
          target_id: string;
          target_kind: string;
        };
        Insert: {
          created_at?: string;
          created_by_user_id?: string | null;
          id?: string;
          lead_id: string;
          link_kind: string;
          metadata?: Json;
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
          metadata?: Json;
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
      crm_leads: {
        Row: {
          assigned_at: string | null;
          closed_at: string | null;
          contact_id: string | null;
          created_at: string;
          created_by_user_id: string | null;
          currency: string | null;
          custom_fields: Json;
          description: string | null;
          expected_close_date: string | null;
          external_id: string | null;
          id: string;
          last_activity_at: string | null;
          lost_reason: string | null;
          organization_id: string;
          owner_user_id: string | null;
          pipeline_id: string;
          position_in_stage: number;
          source: string;
          source_metadata: Json;
          stage_id: string;
          status: string;
          tags: string[];
          title: string;
          updated_at: string;
          value_cents: number | null;
        };
        Insert: {
          assigned_at?: string | null;
          closed_at?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by_user_id?: string | null;
          currency?: string | null;
          custom_fields?: Json;
          description?: string | null;
          expected_close_date?: string | null;
          external_id?: string | null;
          id?: string;
          last_activity_at?: string | null;
          lost_reason?: string | null;
          organization_id: string;
          owner_user_id?: string | null;
          pipeline_id: string;
          position_in_stage?: number;
          source?: string;
          source_metadata?: Json;
          stage_id: string;
          status?: string;
          tags?: string[];
          title: string;
          updated_at?: string;
          value_cents?: number | null;
        };
        Update: {
          assigned_at?: string | null;
          closed_at?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by_user_id?: string | null;
          currency?: string | null;
          custom_fields?: Json;
          description?: string | null;
          expected_close_date?: string | null;
          external_id?: string | null;
          id?: string;
          last_activity_at?: string | null;
          lost_reason?: string | null;
          organization_id?: string;
          owner_user_id?: string | null;
          pipeline_id?: string;
          position_in_stage?: number;
          source?: string;
          source_metadata?: Json;
          stage_id?: string;
          status?: string;
          tags?: string[];
          title?: string;
          updated_at?: string;
          value_cents?: number | null;
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
        ];
      };
      crm_pipelines: {
        Row: {
          created_at: string;
          description: string | null;
          id: string;
          is_archived: boolean;
          is_default: boolean;
          name: string;
          organization_id: string;
          position: number;
          settings: Json;
          slug: string;
          updated_at: string;
          vocabulary: Json;
        };
        Insert: {
          created_at?: string;
          description?: string | null;
          id?: string;
          is_archived?: boolean;
          is_default?: boolean;
          name: string;
          organization_id: string;
          position?: number;
          settings?: Json;
          slug: string;
          updated_at?: string;
          vocabulary?: Json;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          id?: string;
          is_archived?: boolean;
          is_default?: boolean;
          name?: string;
          organization_id?: string;
          position?: number;
          settings?: Json;
          slug?: string;
          updated_at?: string;
          vocabulary?: Json;
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
      crm_stages: {
        Row: {
          color: string | null;
          created_at: string;
          description: string | null;
          expected_duration_hours: number | null;
          id: string;
          is_archived: boolean;
          is_lost: boolean;
          is_won: boolean;
          name: string;
          organization_id: string;
          pipeline_id: string;
          position: number;
          requires_human: boolean;
          slug: string;
          updated_at: string;
        };
        Insert: {
          color?: string | null;
          created_at?: string;
          description?: string | null;
          expected_duration_hours?: number | null;
          id?: string;
          is_archived?: boolean;
          is_lost?: boolean;
          is_won?: boolean;
          name: string;
          organization_id: string;
          pipeline_id: string;
          position: number;
          requires_human?: boolean;
          slug: string;
          updated_at?: string;
        };
        Update: {
          color?: string | null;
          created_at?: string;
          description?: string | null;
          expected_duration_hours?: number | null;
          id?: string;
          is_archived?: boolean;
          is_lost?: boolean;
          is_won?: boolean;
          name?: string;
          organization_id?: string;
          pipeline_id?: string;
          position?: number;
          requires_human?: boolean;
          slug?: string;
          updated_at?: string;
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
          metadata: Json;
          next_attempt_at: string | null;
          organization_id: string;
          payload: Json;
          status: string;
          updated_at: string;
        };
        Insert: {
          attempts?: number;
          consumed_by?: string[];
          created_at?: string;
          entity_id?: string | null;
          entity_kind: string;
          event_type: string;
          id?: string;
          last_error?: string | null;
          metadata?: Json;
          next_attempt_at?: string | null;
          organization_id: string;
          payload?: Json;
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
          metadata?: Json;
          next_attempt_at?: string | null;
          organization_id?: string;
          payload?: Json;
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
      idempotency_keys: {
        Row: {
          created_at: string;
          endpoint: string;
          expires_at: string;
          id: string;
          key: string;
          organization_id: string;
          request_hash: string;
          response_body: Json;
          status_code: number;
        };
        Insert: {
          created_at?: string;
          endpoint: string;
          expires_at?: string;
          id?: string;
          key: string;
          organization_id: string;
          request_hash: string;
          response_body: Json;
          status_code: number;
        };
        Update: {
          created_at?: string;
          endpoint?: string;
          expires_at?: string;
          id?: string;
          key?: string;
          organization_id?: string;
          request_hash?: string;
          response_body?: Json;
          status_code?: number;
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
      incidents: {
        Row: {
          acknowledged_at: string | null;
          acknowledged_by: string | null;
          created_at: string;
          id: string;
          organization_id: string | null;
          payload: Json;
          resolution_note: string | null;
          resolved_at: string | null;
          resolved_by: string | null;
          severity: string;
          status: string;
          type: string;
          updated_at: string;
        };
        Insert: {
          acknowledged_at?: string | null;
          acknowledged_by?: string | null;
          created_at?: string;
          id?: string;
          organization_id?: string | null;
          payload?: Json;
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
          payload?: Json;
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
          external_customer_id: string | null;
          id: string;
          organization_id: string;
          received_at: string;
          request_payload: Json;
          request_type: string;
          result: Json | null;
          scope: string;
          source: string;
          status: string;
          updated_at: string;
        };
        Insert: {
          attempts?: number;
          cascaded_to?: Json | null;
          completed_at?: string | null;
          contact_id?: string | null;
          created_at?: string;
          due_at: string;
          emergency?: boolean;
          error_message?: string | null;
          external_customer_id?: string | null;
          id?: string;
          organization_id: string;
          received_at?: string;
          request_payload?: Json;
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
          external_customer_id?: string | null;
          id?: string;
          organization_id?: string;
          received_at?: string;
          request_payload?: Json;
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
          trigger_payload: Json;
        };
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
          trigger_payload?: Json;
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
          trigger_payload?: Json;
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
          direction: string;
          error_code: string | null;
          error_message: string | null;
          external_id: string | null;
          id: string;
          media_mime: string | null;
          media_size_bytes: number | null;
          media_storage_path: string | null;
          media_url: string | null;
          metadata: Json;
          organization_id: string;
          read_at: string | null;
          sent_at: string;
          sent_by_user_id: string | null;
          sent_via: string;
          status: string;
          type: string;
          updated_at: string;
        };
        Insert: {
          ack?: number | null;
          activity_id?: string | null;
          body?: string | null;
          channel_session_id: string;
          contact_id: string;
          conversation_id: string;
          created_at?: string;
          delivered_at?: string | null;
          direction: string;
          error_code?: string | null;
          error_message?: string | null;
          external_id?: string | null;
          id?: string;
          media_mime?: string | null;
          media_size_bytes?: number | null;
          media_storage_path?: string | null;
          media_url?: string | null;
          metadata?: Json;
          organization_id: string;
          read_at?: string | null;
          sent_at?: string;
          sent_by_user_id?: string | null;
          sent_via?: string;
          status?: string;
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
          direction?: string;
          error_code?: string | null;
          error_message?: string | null;
          external_id?: string | null;
          id?: string;
          media_mime?: string | null;
          media_size_bytes?: number | null;
          media_storage_path?: string | null;
          media_url?: string | null;
          metadata?: Json;
          organization_id?: string;
          read_at?: string | null;
          sent_at?: string;
          sent_by_user_id?: string | null;
          sent_via?: string;
          status?: string;
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
            foreignKeyName: "messages_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
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
          payload: Json;
          price_cents: number;
          rag_chunk_count: number;
          rag_indexed_at: string | null;
          title: string;
          updated_at: string;
          url: string | null;
        };
        Insert: {
          available_qty?: number;
          created_at?: string;
          description?: string | null;
          external_id: string;
          id?: string;
          image_url?: string | null;
          last_updated_at: string;
          organization_id: string;
          payload?: Json;
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
          payload?: Json;
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
          payload: Json;
          payment_method: string | null;
          status: string;
          total_cents: number;
          tracking_code: string | null;
          updated_at: string;
          updated_at_remote: string | null;
        };
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
          payload?: Json;
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
          payload?: Json;
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
      organizations: {
        Row: {
          ai_budget_cents: number | null;
          cnpj: string | null;
          created_at: string;
          created_by: string | null;
          display_name: string;
          dpo_email: string | null;
          id: string;
          legal_name: string;
          locale: string;
          media_retention_days: number;
          onboarded_at: string | null;
          onboarding_state: Json;
          privacy_policy_url: string | null;
          rate_limit_rps: number;
          redacted_at: string | null;
          settings: Json;
          slug: string;
          status: string;
          suspended_at: string | null;
          suspended_by: string | null;
          suspended_reason: string | null;
          timezone: string;
          updated_at: string;
        };
        Insert: {
          ai_budget_cents?: number | null;
          cnpj?: string | null;
          created_at?: string;
          created_by?: string | null;
          display_name: string;
          dpo_email?: string | null;
          id?: string;
          legal_name: string;
          locale?: string;
          media_retention_days?: number;
          onboarded_at?: string | null;
          onboarding_state?: Json;
          privacy_policy_url?: string | null;
          rate_limit_rps?: number;
          redacted_at?: string | null;
          settings?: Json;
          slug: string;
          status?: string;
          suspended_at?: string | null;
          suspended_by?: string | null;
          suspended_reason?: string | null;
          timezone?: string;
          updated_at?: string;
        };
        Update: {
          ai_budget_cents?: number | null;
          cnpj?: string | null;
          created_at?: string;
          created_by?: string | null;
          display_name?: string;
          dpo_email?: string | null;
          id?: string;
          legal_name?: string;
          locale?: string;
          media_retention_days?: number;
          onboarded_at?: string | null;
          onboarding_state?: Json;
          privacy_policy_url?: string | null;
          rate_limit_rps?: number;
          redacted_at?: string | null;
          settings?: Json;
          slug?: string;
          status?: string;
          suspended_at?: string | null;
          suspended_by?: string | null;
          suspended_reason?: string | null;
          timezone?: string;
          updated_at?: string;
        };
        Relationships: [];
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
          store_metadata: Json;
          updated_at: string;
          webhook_path_token: string;
          webhook_secret_encrypted: string;
          webhook_subscriptions: Json;
        };
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
          store_metadata?: Json;
          updated_at?: string;
          webhook_path_token?: string;
          webhook_secret_encrypted: string;
          webhook_subscriptions?: Json;
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
          store_metadata?: Json;
          updated_at?: string;
          webhook_path_token?: string;
          webhook_secret_encrypted?: string;
          webhook_subscriptions?: Json;
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
          created_at: string;
          id: string;
          invited_at: string | null;
          invited_by: string | null;
          organization_id: string;
          revoked_at: string | null;
          role: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          accepted_at?: string | null;
          created_at?: string;
          id?: string;
          invited_at?: string | null;
          invited_by?: string | null;
          organization_id: string;
          revoked_at?: string | null;
          role: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          accepted_at?: string | null;
          created_at?: string;
          id?: string;
          invited_at?: string | null;
          invited_by?: string | null;
          organization_id?: string;
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
          raw_body: string;
          received_at: string;
          signature_header: string | null;
          status: string;
          valid_signature: boolean | null;
          webhook_path_token: string | null;
        };
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
          raw_body: string;
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
          raw_body?: string;
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
    };
    Views: {
      ai_provider_credentials_safe: {
        Row: {
          api_key_last4: string | null;
          created_at: string | null;
          created_by: string | null;
          id: string | null;
          is_active: boolean | null;
          label: string | null;
          models_available: string[] | null;
          organization_id: string | null;
          provider: string | null;
          updated_at: string | null;
          validated_at: string | null;
          validation_error: string | null;
        };
        Insert: {
          api_key_last4?: string | null;
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
    };
    Functions: {
      activate_kb_version: {
        Args: { p_agent_id: string; p_version_id: string };
        Returns: undefined;
      };
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
      fn_attendant_metrics: {
        Args: { p_from: string; p_org: string; p_owner?: string; p_to: string };
        Returns: Json;
      };
      fn_can_view_conversation: {
        Args: { p_assigned_to_user_id: string; p_org: string };
        Returns: boolean;
      };
      fn_can_view_lead: {
        Args: { p_org: string; p_owner_user_id: string };
        Returns: boolean;
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
          assigned_at: string | null;
          assigned_to_user_id: string | null;
          assignee_kind: string | null;
          bot_silenced_until: string | null;
          channel: string;
          channel_session_id: string;
          contact_id: string;
          created_at: string;
          group_chat_id: string | null;
          id: string;
          is_group: boolean;
          last_handoff_at: string | null;
          last_handoff_reason: string | null;
          last_inbound_at: string | null;
          last_message_at: string | null;
          last_message_preview: string | null;
          last_outbound_at: string | null;
          metadata: Json;
          organization_id: string;
          rag_review_status: string | null;
          status: string;
          status_changed_at: string;
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
      fn_decrypt_oauth: { Args: { ciphertext: string }; Returns: string };
      fn_encrypt_oauth: { Args: { plaintext: string }; Returns: string };
      fn_is_platform_admin: { Args: never; Returns: boolean };
      fn_lgpd_cascade_redact_contact: {
        Args: {
          p_contact_id: string;
          p_organization_id: string;
          p_request_id: string;
        };
        Returns: Json;
      };
      fn_log_event: {
        Args: {
          p_event_type: string;
          p_organization_id: string;
          p_payload?: Json;
        };
        Returns: string;
      };
      fn_mark_conversation_message: {
        Args: {
          p_at: string;
          p_conv: string;
          p_direction: string;
          p_preview: string;
        };
        Returns: undefined;
      };
      fn_member_role_in_org: {
        Args: { p_org: string; p_user: string };
        Returns: string;
      };
      fn_publish_ai_agent_version: {
        Args: { p_agent_id: string; p_org_id: string; p_version_id: string };
        Returns: {
          agent_id: string;
          previous_version_id: string;
          published_at: string;
          version_id: string;
        }[];
      };
      fn_role_at_least: {
        Args: { p_min: string; p_org: string };
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
      fn_user_org_ids: { Args: never; Returns: string[] };
      fn_user_role_in: { Args: { p_org: string }; Returns: number };
      fn_user_role_in_org: { Args: { p_org: string }; Returns: string };
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
      show_limit: { Args: never; Returns: number };
      show_trgm: { Args: { "": string }; Returns: string[] };
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
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
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
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
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
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
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
