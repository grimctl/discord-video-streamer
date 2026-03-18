import process from "node:process";
import { Client, type Message } from "discord.js-selfbot-v13";
import { loadConfig } from "./config.js";
import { startControlServer, type ControlServerHandle } from "./control-server.js";
import { resumeStreamAfterGatewayRecovery } from "./gateway-resume.js";
import { Logger } from "./logger.js";
import { StreamSession, type StreamResumeCandidate } from "./stream-session.js";

type ParsedCommand = {
  name: string;
  argument: string;
};

type MutationRunner = <T>(
  action: string,
  context: Record<string, unknown>,
  operation: () => Promise<T>,
) => Promise<T>;

const GATEWAY_RECOVERY_TIMEOUT_MS = 60_000;

async function main(): Promise<void> {
  const { config, configPath } = await loadConfig(process.argv[2]);
  const logger = new Logger(config.logging.level);
  const client = new Client();
  const session = new StreamSession(client, config, logger);
  let shuttingDown = false;
  let fatalGatewayExitInFlight = false;
  let gatewayRecovering = false;
  let gatewayResumeCandidate: StreamResumeCandidate | undefined;
  let gatewayResumeInFlight: Promise<void> | undefined;
  let gatewayRecoveryTimeout: NodeJS.Timeout | undefined;
  let gatewayRecoveryReason: string | undefined;
  let gatewayResetInFlight: Promise<void> | undefined;
  let controlServer: ControlServerHandle | undefined;
  const getGatewayBlockReason = () =>
    gatewayRecovering
      ? gatewayRecoveryReason ?? "discord gateway is reconnecting"
      : undefined;
  const runMutation = createMutationRunner(logger, getGatewayBlockReason);

  logger.info("Loaded configuration", { configPath, prefix: config.prefix });

  if (config.api.enabled) {
    controlServer = startControlServer({
      client,
      config: config.api,
      getGatewayBlockReason,
      logger,
      runMutation,
      session,
    });
  }

  client.on("ready", () => {
    logger.info("Discord client ready", {
      user: client.user?.tag,
      userId: client.user?.id,
    });
    void handleGatewayRecovered("ready");
    void syncDisplayName(client, config.displayName, logger);
  });

  client.on("error", (error) => {
    logger.error("Discord client error", { error: error.message });
  });

  client.on("warn", (warning) => {
    logger.warn("Discord client warning", { warning });
  });

  client.on("shardReconnecting", (shardId) => {
    if (gatewayRecovering) {
      return;
    }

    gatewayResumeCandidate = session.getResumeCandidate();
    if (gatewayResumeCandidate) {
      logger.info("Captured active stream for gateway recovery", {
        shardId,
        guildId: gatewayResumeCandidate.voiceTarget.guildId,
        channelId: gatewayResumeCandidate.voiceTarget.channelId,
        url: gatewayResumeCandidate.url,
      });
    }

    gatewayRecovering = true;
    gatewayRecoveryReason = `discord gateway is reconnecting on shard ${shardId}`;
    gatewayRecoveryTimeout = setTimeout(() => {
      logger.error("Discord gateway recovery timed out; exiting for restart", {
        shardId,
        timeoutMs: GATEWAY_RECOVERY_TIMEOUT_MS,
      });
      void exitForFatalGatewayEvent("gatewayRecoveryTimeout", {
        shardId,
        timeoutMs: GATEWAY_RECOVERY_TIMEOUT_MS,
      });
    }, GATEWAY_RECOVERY_TIMEOUT_MS);
    gatewayRecoveryTimeout.unref();

    logger.warn("Discord shard reconnecting; stopping active stream", {
      shardId,
      timeoutMs: GATEWAY_RECOVERY_TIMEOUT_MS,
    });
    void resetSessionForGatewayEvent("shardReconnecting", { shardId });
  });

  client.on("shardResume", (shardId, replayedEvents) => {
    logger.info("Discord shard resumed", {
      shardId,
      replayedEvents,
    });
    void handleGatewayRecovered("shardResume", {
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
      await handleCommand(
        message,
        command,
        session,
        logger,
        config.prefix,
        runMutation,
      );
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
    clearGatewayRecovery(signal);
    logger.info("Shutting down", { signal });
    await session.stop(true);
    await controlServer?.close().catch((error: unknown) => {
      logger.warn("Failed closing control API", {
        error: formatError(error),
      });
    });
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

  const handleGatewayRecovered = async (
    event: string,
    context: Record<string, unknown> = {},
  ) => {
    if (!gatewayRecovering) {
      return;
    }

    if (gatewayResumeInFlight) {
      return gatewayResumeInFlight;
    }

    gatewayResumeInFlight = (async () => {
      await gatewayResetInFlight;

      const candidate = gatewayResumeCandidate;
      if (candidate) {
        await resumeStreamAfterGatewayRecovery({
          candidate,
          context,
          event,
          logger,
          session,
          shouldContinue: () => !shuttingDown && gatewayRecovering,
        });
      }

      gatewayResumeCandidate = undefined;
      clearGatewayRecovery(event, context);
    })().finally(() => {
      gatewayResumeInFlight = undefined;
    });

    return gatewayResumeInFlight;
  };

  const exitForFatalGatewayEvent = async (
    event: string,
    context: Record<string, unknown> = {},
  ) => {
    if (shuttingDown || fatalGatewayExitInFlight) {
      return;
    }

    fatalGatewayExitInFlight = true;
    gatewayResumeCandidate = undefined;
    clearGatewayRecovery(event);

    await resetSessionForGatewayEvent(event, context);
    shuttingDown = true;
    await controlServer?.close().catch(() => undefined);
    session.dispose();
    client.destroy();

    logger.error("Discord session became unrecoverable; exiting", {
      event,
      ...context,
    });

    process.exit(1);
  };

  const clearGatewayRecovery = (
    event: string,
    context: Record<string, unknown> = {},
  ) => {
    if (!gatewayRecovering) {
      return;
    }

    gatewayRecovering = false;
    gatewayRecoveryReason = undefined;
    gatewayResumeCandidate = undefined;

    if (gatewayRecoveryTimeout) {
      clearTimeout(gatewayRecoveryTimeout);
      gatewayRecoveryTimeout = undefined;
    }

    logger.info("Discord gateway recovery ended", {
      event,
      ...context,
    });
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
  runMutation: MutationRunner,
): Promise<void> {
  switch (command.name) {
    case "play": {
      if (!command.argument) {
        await reply(message, `Usage: ${prefix}play <iptv-stream-url>`);
        return;
      }

      await runMutation(
        "discord.play",
        {
          authorId: message.author.id,
          guildId: message.guildId,
          channelId: message.member?.voice?.channel?.id ?? message.author.voice?.channel?.id,
          url: command.argument,
        },
        () => session.start(message, command.argument),
      );
      await reply(
        message,
        `Starting IPTV stream in your current voice channel:
\`${command.argument}\``,
      );
      return;
    }

    case "stop": {
      const stopped = await runMutation(
        "discord.stop",
        {
          authorId: message.author.id,
          guildId: message.guildId,
        },
        () => session.stop(false),
      );
      await reply(
        message,
        stopped ? "Stopped the active stream." : "No active stream to stop.",
      );
      return;
    }

    case "disconnect": {
      await runMutation(
        "discord.disconnect",
        {
          authorId: message.author.id,
          guildId: message.guildId,
        },
        () => session.stop(true),
      );
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

async function syncDisplayName(
  client: Client,
  displayName: string,
  logger: Logger,
): Promise<void> {
  const desiredDisplayName = displayName.trim();
  if (!desiredDisplayName || !client.user) {
    return;
  }

  if (client.user.globalName === desiredDisplayName) {
    logger.debug("Discord display name already configured", {
      displayName: desiredDisplayName,
    });
    return;
  }

  try {
    await client.user.setGlobalName(desiredDisplayName);
    logger.info("Updated Discord display name", {
      displayName: desiredDisplayName,
    });
  } catch (error) {
    logger.warn("Failed updating Discord display name", {
      displayName: desiredDisplayName,
      error: formatError(error),
    });
  }
}

function createMutationRunner(
  logger: Logger,
  getBlockReason: () => string | undefined,
): MutationRunner {
  let queue = Promise.resolve();

  return async <T>(
    action: string,
    context: Record<string, unknown>,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const run = async () => {
      const blockReason = getBlockReason();
      if (blockReason) {
        throw new Error(blockReason);
      }

      logger.info("Starting control mutation", {
        action,
        ...context,
      });

      try {
        const result = await operation();
        logger.info("Completed control mutation", {
          action,
          ...context,
        });
        return result;
      } catch (error) {
        logger.warn("Control mutation failed", {
          action,
          error: formatError(error),
          ...context,
        });
        throw error;
      }
    };

    const next = queue.then(run, run);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };
}

void main().catch((error) => {
  console.error(formatError(error));
  process.exit(1);
});
