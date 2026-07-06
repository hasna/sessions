// @generated from OpenAPI by @hasna/contracts SDK generator — DO NOT EDIT.
// Source: SessionsApi 0.11.39

export interface Session { "id": string; "source": "claude" | "codex" | "gemini"; "source_id": string; "source_path"?: string | null; "title"?: string | null; "project_path"?: string | null; "project_name"?: string | null; "model"?: string | null; "model_provider"?: string | null; "git_branch"?: string | null; "git_sha"?: string | null; "git_origin_url"?: string | null; "cli_version"?: string | null; "is_subagent": boolean; "parent_session_id"?: string | null; "total_input_tokens"?: number; "total_output_tokens"?: number; "total_cache_read_tokens"?: number; "total_cache_write_tokens"?: number; "total_thinking_tokens"?: number; "message_count"?: number; "tool_call_count"?: number; "started_at"?: string | null; "ended_at"?: string | null; "duration_seconds"?: number | null; "ingested_at"?: string; "updated_at"?: string; "source_modified_at"?: string | null; "machine"?: string | null; "metadata"?: Record<string, unknown> }

export interface Machine { "name": string; "hostname"?: string | null; "platform"?: string | null; "first_seen_at"?: string; "last_seen_at"?: string; "session_count"?: number }

export interface SessionCreate { "id"?: string; "source": "claude" | "codex" | "gemini"; "source_id": string; "source_path"?: string | null; "title"?: string | null; "project_path"?: string | null; "project_name"?: string | null; "model"?: string | null; "model_provider"?: string | null; "git_branch"?: string | null; "git_sha"?: string | null; "git_origin_url"?: string | null; "cli_version"?: string | null; "is_subagent"?: boolean; "parent_session_id"?: string | null; "machine"?: string | null; "started_at"?: string | null; "ended_at"?: string | null; "metadata"?: Record<string, unknown> }

export interface HealthResponse { "status": string; "version": string; "mode": string }

export interface SessionResponse { "ok": boolean; "session": Session }

export interface SessionListResponse { "ok": boolean; "count"?: number; "sessions": Array<Session> }

export interface SearchResponse { "ok": boolean; "query"?: string; "count"?: number; "results": Array<{ "session": Session; "match": string; "snippet"?: string }> }

export interface MachinesResponse { "ok": boolean; "machines": Array<Machine> }

export interface StatsResponse { "ok": boolean; "session_count": number; "message_count"?: number; "tool_call_count"?: number; "by_source"?: Array<{ "source": string; "sessions": number }>; "projects"?: Array<{ "project_name"?: string | null; "project_path"?: string | null; "session_count": number }> }

export interface DeleteResponse { "ok": boolean; "deleted": boolean; "id"?: string }

export interface ErrorResponse { "ok": boolean; "error": string }

export interface SessionsApiOptions {
  /** Base URL, e.g. process.env.APP_API_URL. */
  baseUrl: string;
  /** API key, e.g. process.env.APP_API_KEY. Sent as the 'x-api-key' header. */
  apiKey?: string;
  /** Custom fetch (defaults to global fetch). */
  fetch?: typeof fetch;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

export class SessionsApi {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly baseHeaders: Record<string, string>;

  constructor(options: SessionsApiOptions) {
    if (!options.baseUrl) throw new Error("SessionsApi requires a baseUrl.");
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseHeaders = options.headers ?? {};
  }

  private async request<T>(method: string, path: string, opts: { body?: unknown; query?: Record<string, unknown>; init?: RequestInit }): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (opts.query) {
      for (const [key, value] of Object.entries(opts.query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }
    const headers: Record<string, string> = { Accept: "application/json", ...this.baseHeaders, ...(opts.init?.headers as Record<string, string> | undefined) };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    let payload: BodyInit | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(opts.body);
    }
    const response = await this.fetchImpl(url.toString(), { ...opts.init, method, headers, body: payload });
    const text = await response.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : undefined;
    if (!response.ok) {
      throw new ApiError(response.status, `${method} ${path} failed: ${response.status}`, data);
    }
    return data as T;
  }

    /** Liveness probe */
    async getHealth(init?: RequestInit): Promise<HealthResponse> {
      return this.request("GET", `/health`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Readiness probe (DB reachable + migrated) */
    async getReady(init?: RequestInit): Promise<HealthResponse> {
      return this.request("GET", `/ready`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** List known machines */
    async listMachines(init?: RequestInit): Promise<MachinesResponse> {
      return this.request("GET", `/v1/machines`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Most recent sessions */
    async recentSessions(query?: { "limit"?: number }, init?: RequestInit): Promise<SessionListResponse> {
      return this.request("GET", `/v1/recent`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Search sessions by title/project */
    async searchSessions(query?: { "q": string; "source"?: string; "project"?: string; "machine"?: string; "limit"?: number }, init?: RequestInit): Promise<SearchResponse> {
      return this.request("GET", `/v1/search`, {
        body: undefined,
        query,
        init,
      });
    }

    /** List sessions */
    async listSessions(query?: { "source"?: string; "project"?: string; "machine"?: string; "limit"?: number }, init?: RequestInit): Promise<SessionListResponse> {
      return this.request("GET", `/v1/sessions`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Create or upsert a session */
    async createSession(body: SessionCreate, init?: RequestInit): Promise<SessionResponse> {
      return this.request("POST", `/v1/sessions`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Get a session by id or id prefix */
    async getSession(id: string, init?: RequestInit): Promise<SessionResponse> {
      return this.request("GET", `/v1/sessions/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Delete a session */
    async deleteSession(id: string, init?: RequestInit): Promise<DeleteResponse> {
      return this.request("DELETE", `/v1/sessions/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Aggregate counts */
    async getStats(init?: RequestInit): Promise<StatsResponse> {
      return this.request("GET", `/v1/stats`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Version + mode */
    async getVersion(init?: RequestInit): Promise<HealthResponse> {
      return this.request("GET", `/version`, {
        body: undefined,
        query: undefined,
        init,
      });
    }
}
