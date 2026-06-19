import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDatabase } from "../db/database.js";
import {
  getStorageStatus,
  parseStorageTables,
  pullStorageChanges,
  pushStorageChanges,
  syncStorageChanges,
} from "../db/storage-sync.js";
import { getPackageVersion } from "../lib/package.js";

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(error: unknown) {
  return {
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

export function registerSessionsStorageTools(server: McpServer): void {
  server.tool(
    "sessions_storage_status",
    "Show sessions local database and storage sync status",
    {},
    async () => {
      try {
        return ok(getStorageStatus());
      } catch (error) {
        return err(error);
      }
    }
  );

  server.tool(
    "sessions_storage_push",
    "Push local sessions data to PostgreSQL",
    { tables: z.string().optional().describe("Comma-separated table names") },
    async ({ tables }) => {
      try {
        return ok(await pushStorageChanges(parseStorageTables(tables)));
      } catch (error) {
        return err(error);
      }
    }
  );

  server.tool(
    "sessions_storage_pull",
    "Pull PostgreSQL sessions data into the local database",
    { tables: z.string().optional().describe("Comma-separated table names") },
    async ({ tables }) => {
      try {
        return ok(await pullStorageChanges(parseStorageTables(tables)));
      } catch (error) {
        return err(error);
      }
    }
  );

  server.tool(
    "sessions_storage_sync",
    "Push local changes, then pull remote changes",
    { tables: z.string().optional().describe("Comma-separated table names") },
    async ({ tables }) => {
      try {
        return ok(await syncStorageChanges(parseStorageTables(tables)));
      } catch (error) {
        return err(error);
      }
    }
  );

  server.tool(
    "sessions_storage_feedback",
    "Save feedback for sessions",
    {
      message: z.string(),
      email: z.string().optional(),
      category: z.enum(["bug", "feature", "general"]).optional(),
    },
    async ({ message, email, category }) => {
      try {
        const db = getDatabase();
        db.run(
          "INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)",
          [message, email || null, category || "general", getPackageVersion()]
        );
        return ok({ saved: true });
      } catch (error) {
        return err(error);
      }
    }
  );
}
