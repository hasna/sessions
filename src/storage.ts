// Public storage entrypoint (`@hasna/sessions/storage`).
//
// The ONE client storage seam: `resolveSessionStore` returns a `SessionStore`
// backed by either the local SQLite index (LocalStore) or the self_hosted /v1
// HTTP API (ApiStore, bearer key). There is no DSN / DATABASE_URL path on the
// client — that was the split-brain bug and has been removed.
export {
  resolveSessionStore,
  type SessionStore,
  type Env,
  type ListOptions,
  type SearchHitDto,
  type StoreStats,
} from "./db/session-store.js";
