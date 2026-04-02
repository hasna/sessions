import { getPackageInfo } from "../lib/package.js";

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
};

function json(
  payload: Record<string, unknown>,
  status = 200
): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: jsonHeaders,
  });
}

export function createSessionsServer(options: {
  port?: number;
  hostname?: string;
} = {}) {
  const pkg = getPackageInfo();
  const hostname = options.hostname ?? process.env.HOST ?? "127.0.0.1";
  const port = Number.isFinite(options.port)
    ? options.port
    : Number.parseInt(process.env.PORT || "3456", 10);

  return Bun.serve({
    hostname,
    port: Number.isFinite(port) ? port : 3456,
    fetch(request) {
      const url = new URL(request.url);

      if (request.method !== "GET") {
        return json(
          {
            ok: false,
            error: "Method not allowed",
            allowedMethods: ["GET"],
          },
          405
        );
      }

      if (url.pathname === "/" || url.pathname === "/info") {
        return json({
          ok: true,
          name: pkg.name,
          version: pkg.version,
          description: pkg.description,
          endpoints: ["/health", "/info"],
        });
      }

      if (url.pathname === "/health") {
        return json({
          ok: true,
          service: pkg.name,
          version: pkg.version,
        });
      }

      return json(
        {
          ok: false,
          error: "Not found",
          endpoints: ["/health", "/info"],
        },
        404
      );
    },
  });
}
