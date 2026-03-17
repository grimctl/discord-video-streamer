import process from "node:process";
import { Client, type Message } from "discord.js-selfbot-v13";
import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { StreamSession } from "./stream-session.js";

type ParsedCommand = {
  name: string;
  argument: string;
};

async function main(): Promise<void> {
  const { config, configPath } = await loadConfig(process.argv[2]);
  const logger = new Logger(config.logging.level);
  const client = new Client();
  const session = new StreamSession(client, config, logger);
  let shuttingDown = false;
  let fatalGatewayExitInFlight = false;
  let gatewayResetInFlight: Promise<void> | undefined;

  logger.info("Loaded configuration", { configPath, prefix: config.prefix });

  client.on("ready", () => {
    logger.info("Discord client ready", {
      user: client.user?.tag,
      userId: client.user?.id,
    });
  });

  client.on("error", (error) => {
    logger.error("Discord client error", { error: error.message });
  });

  client.on("warn", (warning) => {
    logger.warn("Discord client warning", { warning });
  });

  client.on("shardReconnecting", (shardId) => {
    logger.warn("Discord shard reconnecting; stopping active stream", {
      shardId,
    });
    void resetSessionForGatewayEvent("shardReconnecting", { shardId });
  });

  client.on("shardResume", (shardId, replayedEvents) => {
    logger.info("Discord shard resumed", {
      shardId,
      replayedEvents,
    });
  });

  client.on("shardDisconnect", (closeEvent, shardId) => {
    logger.error("Discord shard disconnected permanently", {
      shardId,
      code: closeEvent.code,
      reason: closeEvent.reason,
      wasClean: closeEvent.wasClean,
    });
    void exitForFatalGatewayEvent("shardDisconnect", {
      shardId,
      code: closeEvent.code,
      reason: closeEvent.reason,
      wasClean: closeEvent.wasClean,
    });
  });

  client.on("invalidated", () => {
    logger.error("Discord session invalidated", {});
    void exitForFatalGatewayEvent("invalidated");
  });

  client.on("messageCreate", async (message: Message) => {
    if (message.author.bot || !message.content) {
      return;
    }

    const command = parseCommand(message.content, config.prefix);
    if (!command) {
      return;
    }

    logger.info("Handling command", {
      authorId: message.author.id,
      channelId: message.channelId,
      guildId: message.guildId,
      command: command.name,
    });

    try {
      await handleCommand(message, command, session, logger, config.prefix);
    } catch (error) {
      const reason = formatError(error);
      logger.warn("Command failed", {
        command: command.name,
        error: reason,
      });
      await reply(message, `Command failed: \`${reason}\``);
    }
  });

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info("Shutting down", { signal });
    await session.stop(true);
    session.dispose();
    client.destroy();
    process.exit(0);
  };

  const resetSessionForGatewayEvent = async (
    event: string,
    context: Record<string, unknown> = {},
  ) => {
    if (shuttingDown) {
      return;
    }

    if (gatewayResetInFlight) {
      return gatewayResetInFlight;
    }

    gatewayResetInFlight = session
      .stop(true)
      .then(() => undefined)
      .catch((error: unknown) => {
        logger.warn("Failed stopping stream during gateway event", {
          event,
          error: formatError(error),
          ...context,
        });
      })
      .finally(() => {
        gatewayResetInFlight = undefined;
      });

    return gatewayResetInFlight;
  };

  const exitForFatalGatewayEvent = async (
    event: string,
    context: Record<string, unknown> = {},
  ) => {
    if (shuttingDown || fatalGatewayExitInFlight) {
      return;
    }

    fatalGatewayExitInFlight = true;

    await resetSessionForGatewayEvent(event, context);
    shuttingDown = true;
    session.dispose();
    client.destroy();

    logger.error("Discord session became unrecoverable; exiting", {
      event,
      ...context,
    });

    process.exit(1);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection", { error: formatError(reason) });
  });

  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception", { error: error.message, stack: error.stack });
  });

  await client.login(config.token);
}

function parseCommand(content: string, prefix: string): ParsedCommand | undefined {
  if (!content.startsWith(prefix)) {
    return undefined;
  }

  const body = content.slice(prefix.length).trim();
  if (!body) {
    return undefined;
  }

  const separatorIndex = body.indexOf(" ");
  if (separatorIndex === -1) {
    return {
      name: body.toLowerCase(),
      argument: "",
    };
  }

  return {
    name: body.slice(0, separatorIndex).toLowerCase(),
    argument: body.slice(separatorIndex + 1).trim(),
  };
}

async function handleCommand(
  message: Message,
  command: ParsedCommand,
  session: StreamSession,
  logger: Logger,
  prefix: string,
): Promise<void> {
  switch (command.name) {
    case "play": {
      if (!command.argument) {
        await reply(message, `Usage: ${prefix}play <iptv-stream-url>`);
        return;
      }

      await session.start(message, command.argument);
      await reply(
        message,
        `Starting IPTV stream in your current voice channel:
\`${command.argument}\``,
      );
      return;
    }

    case "stop": {
      const stopped = await session.stop(false);
      await reply(
        message,
        stopped ? "Stopped the active stream." : "No active stream to stop.",
      );
      return;
    }

    case "disconnect": {
      await session.stop(true);
      await reply(message, "Stopped streaming and left the voice channel.");
      return;
    }

    case "status": {
      await reply(message, `\`\`\`
${session.getStatus()}
\`\`\``);
      return;
    }

    case "help": {
      await reply(
        message,
        [
          `Available commands with prefix ${prefix}`,
          `${prefix}play <url> - stop the current stream and start this IPTV URL`,
          `${prefix}stop - stop streaming but stay in voice`,
          `${prefix}disconnect - stop streaming and leave voice`,
          `${prefix}status - show stream status and retry state`,
        ].join("\n"),
      );
      return;
    }

    default: {
      logger.debug("Ignoring unsupported command", { command: command.name });
      return;
    }
  }
}

async function reply(message: Message, content: string): Promise<void> {
  await message.reply(content);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

void main().catch((error) => {
  console.error(formatError(error));
  process.exit(1);
});
