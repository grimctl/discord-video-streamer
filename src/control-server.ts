import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Client } from "discord.js-selfbot-v13";
import type { AppConfig } from "./config.js";
import { evaluateHealthSnapshot } from "./health.js";
import type { Logger } from "./logger.js";
import type { StreamSession } from "./stream-session.js";

type ControlMutationRunner = <T>(
  action: string,
  context: Record<string, unknown>,
  operation: () => Promise<T>,
) => Promise<T>;

type ControlServerOptions = {
  client: Client;
  config: AppConfig["api"];
  getGatewayBlockReason: () => string | undefined;
  logger: Logger;
  runMutation: ControlMutationRunner;
  session: StreamSession;
};

type JsonObject = Record<string, unknown>;

export type ControlServerHandle = {
  close(): Promise<void>;
};

const MAX_BODY_BYTES = 32 * 1024;

export function startControlServer({
  client,
  config,
  getGatewayBlockReason,
  logger,
  runMutation,
  session,
}: ControlServerOptions): ControlServerHandle {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const pathname = url.pathname;
      const remoteAddress = request.socket.remoteAddress ?? "unknown";

      if (request.method === "GET" && pathname === "/healthz") {
        const snapshot = session.getHealthSnapshot();
        const health = evaluateHealthSnapshot(snapshot);
        const gatewayBlockReason = getGatewayBlockReason();
        const ok = health.ok && gatewayBlockReason === undefined;
        const reason = gatewayBlockReason ?? health.reason;

        return sendJson(response, ok ? 200 : 503, {
          ok,
          reason,
          snapshot,
        });
      }

      if (request.method === "GET" && pathname === "/status") {
        return sendJson(response, 200, {
          gatewayBlockedReason: getGatewayBlockReason(),
          snapshot: session.getHealthSnapshot(),
          status: session.getStatus(),
        });
      }

      if (request.method === "POST" && pathname === "/play") {
        const body = await readJsonBody(request);
        const urlValue = getRequiredString(body, "url");
        const guildId = getRequiredString(body, "guildId");
        const channelId = getRequiredString(body, "channelId");
        const gatewayBlockReason = getGatewayBlockReason();

        if (gatewayBlockReason) {
          return sendJson(response, 503, {
            error: gatewayBlockReason,
          });
        }

        if (!client.user) {
          return sendJson(response, 503, {
            error: "discord client is not ready",
          });
        }

        logger.info("Handling API play request", {
          remoteAddress,
          guildId,
          channelId,
          url: urlValue,
        });

        await runMutation(
          "api.play",
          {
            remoteAddress,
            guildId,
            channelId,
            url: urlValue,
          },
          () => session.startWithIds(guildId, channelId, urlValue),
        );

        return sendJson(response, 200, {
          ok: true,
          snapshot: session.getHealthSnapshot(),
          status: session.getStatus(),
        });
      }

      if (request.method === "POST" && pathname === "/stop") {
        const gatewayBlockReason = getGatewayBlockReason();
        if (gatewayBlockReason) {
          return sendJson(response, 503, {
            error: gatewayBlockReason,
          });
        }

        logger.info("Handling API stop request", { remoteAddress });
        const stopped = await runMutation(
          "api.stop",
          { remoteAddress },
          () => session.stop(false),
        );

        return sendJson(response, 200, {
          ok: true,
          stopped,
          snapshot: session.getHealthSnapshot(),
          status: session.getStatus(),
        });
      }

      if (request.method === "POST" && pathname === "/disconnect") {
        const gatewayBlockReason = getGatewayBlockReason();
        if (gatewayBlockReason) {
          return sendJson(response, 503, {
            error: gatewayBlockReason,
          });
        }

        logger.info("Handling API disconnect request", { remoteAddress });
        const disconnected = await runMutation(
          "api.disconnect",
          { remoteAddress },
          () => session.stop(true),
        );

        return sendJson(response, 200, {
          ok: true,
          disconnected,
          snapshot: session.getHealthSnapshot(),
          status: session.getStatus(),
        });
      }

      if (request.method === "GET" && pathname === "/") {
        return sendJson(response, 200, {
          gatewayBlockedReason: getGatewayBlockReason(),
          name: "discord-video-streamer-control-api",
          endpoints: [
            "GET /healthz",
            "GET /status",
            "POST /play",
            "POST /stop",
            "POST /disconnect",
          ],
        });
      }

      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      const message = error instanceof RequestError ? error.message : formatError(error);
      const statusCode = error instanceof RequestError ? error.statusCode : 500;

      if (statusCode >= 500) {
        logger.warn("API request failed", {
          error: message,
          method: request.method,
          path: request.url,
        });
      }

      sendJson(response, statusCode, {
        error: message,
      });
    }
  });

  server.listen(config.port, config.host, () => {
    logger.info("Control API listening", {
      host: config.host,
      port: config.port,
    });
  });

  return {
    close: () => closeServer(server),
  };
}

async function readJsonBody(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;

    if (size > MAX_BODY_BYTES) {
      throw new RequestError(413, "request body is too large");
    }

    chunks.push(buffer);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawBody) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new RequestError(400, "request body must be valid JSON");
  }

  if (!isJsonObject(parsed)) {
    throw new RequestError(400, "request body must be a JSON object");
  }

  return parsed;
}

function getRequiredString(body: JsonObject, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new RequestError(400, `request body must include a non-empty string '${key}'`);
  }

  return value.trim();
}

function sendJson(response: ServerResponse, statusCode: number, body: JsonObject): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

class RequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
