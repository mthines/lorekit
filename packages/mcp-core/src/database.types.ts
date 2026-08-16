export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      api_tokens: {
        Row: {
          created_at: string
          id: string
          last_used_at: string | null
          name: string
          org_access: string
          org_ids: string[]
          permissions: string[]
          scopes: string[]
          token_hash: string
          token_prefix: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_used_at?: string | null
          name: string
          org_access?: string
          org_ids?: string[]
          permissions?: string[]
          scopes?: string[]
          token_hash: string
          token_prefix: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          last_used_at?: string | null
          name?: string
          org_access?: string
          org_ids?: string[]
          permissions?: string[]
          scopes?: string[]
          token_hash?: string
          token_prefix?: string
          user_id?: string
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          action: string
          created_at: string
          id: string
          metadata: Json | null
          resource_id: string | null
          resource_type: string | null
          target: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          id?: string
          metadata?: Json | null
          resource_id?: string | null
          resource_type?: string | null
          target?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          id?: string
          metadata?: Json | null
          resource_id?: string | null
          resource_type?: string | null
          target?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      github_installations: {
        Row: {
          account_type: string
          created_at: string
          github_account_id: number
          github_account_login: string
          id: string
          installation_id: number
          status: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          account_type: string
          created_at?: string
          github_account_id: number
          github_account_login: string
          id?: string
          installation_id: number
          status?: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          account_type?: string
          created_at?: string
          github_account_id?: number
          github_account_login?: string
          id?: string
          installation_id?: number
          status?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      installation_repositories: {
        Row: {
          active: boolean
          added_at: string
          full_name: string
          id: string
          installation_id: number
          removed_at: string | null
        }
        Insert: {
          active?: boolean
          added_at?: string
          full_name: string
          id?: string
          installation_id: number
          removed_at?: string | null
        }
        Update: {
          active?: boolean
          added_at?: string
          full_name?: string
          id?: string
          installation_id?: number
          removed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "installation_repositories_installation_id_fkey"
            columns: ["installation_id"]
            isOneToOne: false
            referencedRelation: "github_installations"
            referencedColumns: ["installation_id"]
          },
        ]
      }
      memories: {
        Row: {
          archived_at: string | null
          created_at: string
          created_by: string | null
          expires_at: string | null
          fts: unknown
          id: string
          key: string
          org_id: string | null
          origin_branch: string | null
          origin_commit: string | null
          origin_pr: number | null
          origin_repo: string | null
          scope: string
          source_agent: string | null
          tags: string[]
          trigger: string | null
          updated_at: string
          updated_by: string | null
          user_id: string | null
          value: string
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          fts?: unknown
          id?: string
          key: string
          org_id?: string | null
          origin_branch?: string | null
          origin_commit?: string | null
          origin_pr?: number | null
          origin_repo?: string | null
          scope: string
          source_agent?: string | null
          tags?: string[]
          trigger?: string | null
          updated_at?: string
          updated_by?: string | null
          user_id?: string | null
          value: string
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          fts?: unknown
          id?: string
          key?: string
          org_id?: string | null
          origin_branch?: string | null
          origin_commit?: string | null
          origin_pr?: number | null
          origin_repo?: string | null
          scope?: string
          source_agent?: string | null
          tags?: string[]
          trigger?: string | null
          updated_at?: string
          updated_by?: string | null
          user_id?: string | null
          value?: string
        }
        Relationships: [
          {
            foreignKeyName: "memories_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      org_invites: {
        Row: {
          created_at: string
          expires_at: string | null
          id: string
          invited_by: string | null
          invitee_email: string | null
          invitee_handle: string | null
          org_id: string
          responded_at: string | null
          role: string
          status: string
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          id?: string
          invited_by?: string | null
          invitee_email?: string | null
          invitee_handle?: string | null
          org_id: string
          responded_at?: string | null
          role?: string
          status?: string
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          id?: string
          invited_by?: string | null
          invitee_email?: string | null
          invitee_handle?: string | null
          org_id?: string
          responded_at?: string | null
          role?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_invites_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      org_limits: {
        Row: {
          created_at: string
          max_memories: number | null
          org_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          max_memories?: number | null
          org_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          max_memories?: number | null
          org_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_limits_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      org_members: {
        Row: {
          created_at: string
          org_id: string
          role: string
          user_id: string
        }
        Insert: {
          created_at?: string
          org_id: string
          role?: string
          user_id: string
        }
        Update: {
          created_at?: string
          org_id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_members_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      org_scope_bindings: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          org_id: string
          scope: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          org_id: string
          scope: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          org_id?: string
          scope?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_scope_bindings_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      orgs: {
        Row: {
          created_at: string
          created_by: string | null
          deleted_at: string | null
          id: string
          name: string
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          name: string
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          name?: string
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      plans: {
        Row: {
          created_at: string
          description: string | null
          max_memories: number
          name: string
          requests_per_minute: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          max_memories: number
          name: string
          requests_per_minute: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          max_memories?: number
          name?: string
          requests_per_minute?: number
          updated_at?: string
        }
        Relationships: []
      }
      rate_limit_counters: {
        Row: {
          count: number
          user_id: string
          window_start: string
        }
        Insert: {
          count?: number
          user_id: string
          window_start: string
        }
        Update: {
          count?: number
          user_id?: string
          window_start?: string
        }
        Relationships: []
      }
      usage_events: {
        Row: {
          auth_type: string
          created_at: string
          duration_ms: number | null
          id: string
          memory_count: number | null
          org_id: string | null
          outcome: string
          plan_name: string | null
          scope_type: string | null
          tool_name: string
          user_id: string | null
        }
        Insert: {
          auth_type: string
          created_at?: string
          duration_ms?: number | null
          id?: string
          memory_count?: number | null
          org_id?: string | null
          outcome: string
          plan_name?: string | null
          scope_type?: string | null
          tool_name: string
          user_id?: string | null
        }
        Update: {
          auth_type?: string
          created_at?: string
          duration_ms?: number | null
          id?: string
          memory_count?: number | null
          org_id?: string | null
          outcome?: string
          plan_name?: string | null
          scope_type?: string | null
          tool_name?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "usage_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      user_limits: {
        Row: {
          created_at: string
          max_memories: number | null
          plan_name: string | null
          requests_per_minute: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          max_memories?: number | null
          plan_name?: string | null
          requests_per_minute?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          max_memories?: number | null
          plan_name?: string | null
          requests_per_minute?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_limits_plan_name_fkey"
            columns: ["plan_name"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["name"]
          },
        ]
      }
      user_plans: {
        Row: {
          created_at: string
          plan_name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          plan_name?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          plan_name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_plans_plan_name_fkey"
            columns: ["plan_name"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["name"]
          },
        ]
      }
      webhook_secrets: {
        Row: {
          active: boolean
          created_at: string
          id: string
          repo: string | null
          secret: string
          user_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          repo?: string | null
          secret: string
          user_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          repo?: string | null
          secret?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      archive_memory: {
        Args: { p_key: string; p_scope: string; p_user_id: string }
        Returns: string
      }
      lorekit_check_rate_limit: {
        Args: { p_user_id: string; p_window_seconds?: number }
        Returns: {
          allowed: boolean
          current_count: number
          limit_value: number
          retry_after_seconds: number
        }[]
      }
      lorekit_default_limit: { Args: { p_key: string }; Returns: number }
      lorekit_find_user_by_github_id: {
        Args: { p_github_account_id: string }
        Returns: string
      }
      lorekit_get_limit: {
        Args: { p_key: string; p_user_id: string }
        Returns: number
      }
      lorekit_get_org_limit: {
        Args: { p_key: string; p_org_id: string }
        Returns: number
      }
      lorekit_installation_remove: {
        Args: { p_installation_id: number }
        Returns: undefined
      }
      lorekit_installation_remove_repos: {
        Args: { p_installation_id: number; p_repos: string[] }
        Returns: undefined
      }
      lorekit_installation_upsert: {
        Args: {
          p_account_type: string
          p_github_account_id: number
          p_github_account_login: string
          p_installation_id: number
          p_repos: string[]
          p_status: string
          p_user_id: string
        }
        Returns: string
      }
      lorekit_invite_addressed_to_caller: {
        Args: { p_invite: Database["public"]["Tables"]["org_invites"]["Row"] }
        Returns: boolean
      }
      lorekit_invite_org_details: {
        Args: { p_invite_id: string }
        Returns: {
          inviter_avatar_url: string
          inviter_handle: string
          member_count: number
          org_created_at: string
          org_name: string
          org_slug: string
        }[]
      }
      lorekit_api_token_org_allowed: {
        Args: { p_org_access: string; p_org_id: string; p_org_ids: string[] }
        Returns: boolean
      }
      lorekit_api_token_scope_allowed: {
        Args: { p_patterns: string[]; p_scope: string }
        Returns: boolean
      }
      lorekit_api_token_scopes_valid: { Args: { p_patterns: string[] }; Returns: boolean }
      lorekit_api_token_set_scoping: {
        Args: {
          p_org_access?: string
          p_org_ids?: string[]
          p_scopes?: string[]
          p_token_id: string
        }
        Returns: {
          id: string
          org_access: string
          org_ids: string[]
          scopes: string[]
        }[]
      }
      lorekit_member_org_ids: { Args: { p_user_id: string }; Returns: string[] }
      lorekit_memory_count: { Args: { p_user_id: string }; Returns: Json }
      lorekit_memory_activity: {
        Args: {
          p_bucket?: string
          p_since?: string
          p_until?: string
          p_user_id: string
        }
        Returns: {
          bucket: string
          count: number
          scope: string
        }[]
      }
      lorekit_memory_facets: {
        Args: { p_archived?: boolean; p_user_id: string }
        Returns: {
          count: number
          facet: string
          value: string
        }[]
      }
      lorekit_memory_scopes: {
        Args: {
          p_key_org_access?: string
          p_key_org_ids?: string[]
          p_key_scopes?: string[]
          p_user_id: string
        }
        Returns: {
          count: number
          last_activity: string | null
          scope: string
        }[]
      }
      lorekit_memory_tags: {
        Args: { p_archived?: boolean; p_user_id: string }
        Returns: {
          count: number
          tag: string
        }[]
      }
      lorekit_org_can: {
        Args: { p_capability: string; p_org_id: string; p_user_id: string }
        Returns: boolean
      }
      lorekit_org_create: {
        Args: { p_name: string; p_slug: string }
        Returns: string
      }
      lorekit_org_delete: { Args: { p_org_id: string }; Returns: undefined }
      lorekit_org_invite: {
        Args: {
          p_invitee_email?: string
          p_invitee_handle?: string
          p_org_id: string
          p_role?: string
        }
        Returns: string
      }
      lorekit_org_invite_accept: {
        Args: { p_invite_id: string }
        Returns: undefined
      }
      lorekit_org_invite_decline: {
        Args: { p_invite_id: string }
        Returns: undefined
      }
      lorekit_org_invite_revoke: {
        Args: { p_invite_id: string }
        Returns: undefined
      }
      lorekit_org_leave: { Args: { p_org_id: string }; Returns: undefined }
      lorekit_org_member_remove: {
        Args: { p_org_id: string; p_target_user_id: string }
        Returns: undefined
      }
      lorekit_org_member_role: {
        Args: { p_org_id: string; p_role: string; p_target_user_id: string }
        Returns: undefined
      }
      lorekit_org_members_list: {
        Args: { p_org_id: string }
        Returns: {
          avatar_url: string
          handle: string
          joined_at: string
          role: string
          user_id: string
        }[]
      }
      lorekit_org_purge: { Args: { p_org_id: string }; Returns: undefined }
      lorekit_org_rename: {
        Args: { p_name: string; p_org_id: string }
        Returns: undefined
      }
      lorekit_org_role: {
        Args: { p_org_id: string; p_user_id: string }
        Returns: string
      }
      lorekit_purge_all_expired_memories: { Args: never; Returns: number }
      lorekit_purge_old_usage_events: {
        Args: { p_older_than?: string }
        Returns: number
      }
      lorekit_purge_rate_limit_counters: {
        Args: { p_older_than?: string }
        Returns: number
      }
      lorekit_record_usage_event: {
        Args: {
          p_auth_type?: string
          p_client?: string
          p_correlation_id?: string
          p_duration_ms?: number
          p_host?: string
          p_key_org_access?: string
          p_key_org_ids?: string[]
          p_kind?: string
          p_memory_count?: number
          p_org_id?: string
          p_outcome?: string
          p_plan_name?: string
          p_result_count?: number
          p_scope?: string
          p_scope_type?: string
          p_tool_name?: string
          p_user_id?: string
        }
        Returns: string
      }
      lorekit_scope_bind: {
        Args: { p_org_id: string; p_scope: string }
        Returns: string
      }
      lorekit_scope_unbind: {
        Args: { p_org_id: string; p_scope: string }
        Returns: undefined
      }
      memory_delete: {
        Args: {
          p_force?: boolean
          p_key?: string
          p_org_slug?: string
          p_scope?: string
          p_user_id: string
        }
        Returns: {
          archived: boolean
          deleted: boolean
        }[]
      }
      memory_write: {
        Args: {
          p_clear_ttl?: boolean
          p_created_at?: string
          p_key: string
          p_key_org_access?: string
          p_key_org_ids?: string[]
          p_org_slug?: string
          p_origin_branch?: string
          p_origin_commit?: string
          p_origin_pr?: number
          p_origin_repo?: string
          p_scope: string
          p_source_agent?: string
          p_tags?: string[]
          p_trigger?: string
          p_ttl_seconds?: number
          p_user_id: string
          p_value: string
        }
        Returns: {
          binding_org_slug: string
          created_at: string
          expires_at: string
          id: string
          inserted: boolean
          org_routed: boolean
        }[]
      }
      purge_archived_memories: {
        Args: { p_retention_days?: number; p_user_id: string }
        Returns: number
      }
      purge_expired_memories: { Args: { p_user_id: string }; Returns: number }
      restore_memory: {
        Args: { p_key: string; p_scope: string; p_user_id: string }
        Returns: string
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
