import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import {
  AutocompleteInteraction,
  Client,
  Events,
  GatewayIntentBits,
  Guild,
  GuildMember,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { startHealthServer } from "./health-server.js";

const token = process.env.DISCORD_BOT_TOKEN?.trim().replace(/^Bot\s+/i, "");
if (!token) {
  throw new Error("Missing DISCORD_BOT_TOKEN. Add it in Replit Secrets.");
}

const audioDirectory = fileURLToPath(new URL("./", import.meta.url));
const autoJoinUsername = "sora107_";
const supportedAudioExtensions = new Set([
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".ogg",
  ".opus",
  ".wav",
]);

const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Join your current voice channel"),
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play an audio file from the bot's audio folder")
    .addStringOption((option) =>
      option
        .setName("track")
        .setDescription("Choose an audio file")
        .setRequired(true)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop the current audio"),
  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Leave the voice channel"),
].map((command) => command.toJSON());

type GuildPlayback = {
  player: ReturnType<typeof createAudioPlayer>;
  transcoder?: ChildProcessByStdio<null, Readable, Readable>;
  finishCurrent?: () => void;
};

const playbacks = new Map<string, GuildPlayback>();
const activeIntros = new Map<string, Promise<void>>();
const voiceRecoveryTasks = new Map<string, Promise<void>>();
let missingIntroWarningShown = false;
let gatewayDisconnectedAt: number | undefined;
let gatewayResetInProgress = false;

function createDiscordClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
}

let client = createDiscordClient();
const healthServer = startHealthServer(() => client.isReady());
let shuttingDown = false;
const gatewayWatchdog = setInterval(() => {
  if (shuttingDown || client.isReady()) {
    gatewayDisconnectedAt = undefined;
    return;
  }

  gatewayDisconnectedAt ??= Date.now();
  if (gatewayResetInProgress || Date.now() - gatewayDisconnectedAt < 120_000) {
    return;
  }

  gatewayResetInProgress = true;
  gatewayDisconnectedAt = Date.now();
  void (async () => {
    console.warn(
      "[gateway] Discord has not become ready for 2 minutes; restarting the client connection.",
    );
    try {
      await client.destroy();
      if (shuttingDown) return;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      if (shuttingDown) return;
      client = createDiscordClient();
      registerClientListeners(client);
      await client.login(token);
      console.info("[gateway] Discord client login restarted.");
    } catch (error) {
      console.error("[gateway] Could not restart the Discord client:", error);
    } finally {
      gatewayResetInProgress = false;
    }
  })();
}, 30_000);
gatewayWatchdog.unref();

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function listAudioFiles(): Promise<string[]> {
  try {
    const entries = await readdir(audioDirectory, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isFile() &&
          supportedAudioExtensions.has(path.extname(entry.name).toLowerCase()),
      )
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    console.error("Could not read the audio folder:", error);
    return [];
  }
}

async function autocompleteTrack(
  interaction: AutocompleteInteraction,
): Promise<void> {
  const search = interaction.options.getFocused().toLowerCase();
  const matches = (await listAudioFiles())
    .filter((name) => name.toLowerCase().includes(search))
    .slice(0, 25);

  await interaction.respond(matches.map((name) => ({ name, value: name })));
}

async function getMember(interaction: {
  guild: Guild | null;
  user: { id: string };
}): Promise<GuildMember | null> {
  if (!interaction.guild) return null;
  return interaction.guild.members.fetch(interaction.user.id);
}

async function joinMemberVoiceChannel(
  guild: Guild,
  member: GuildMember,
  options: { forceReconnect?: boolean; playIntro?: boolean } = {},
) {
  const channel = member.voice.channel;
  if (!channel) {
    throw new Error("Join a voice channel first, then try again.");
  }

  const current = getVoiceConnection(guild.id);
  if (current?.joinConfig.channelId === channel.id && !options.forceReconnect) {
    try {
      await entersState(current, VoiceConnectionStatus.Ready, 30_000);
      if (options.playIntro !== false) void startIntro(guild.id);
      return current;
    } catch {
      current.destroy();
    }
  } else {
    current?.destroy();
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
  });
  watchVoiceConnection(guild.id, connection);

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch {
    connection.destroy();
    throw new Error(
      "The voice connection did not become ready. Check the bot's Connect and Speak permissions, then try again.",
    );
  }

  if (options.playIntro !== false) void startIntro(guild.id);
  return connection;
}

function findAutoJoinMember(guild: Guild): GuildMember | undefined {
  return guild.members.cache.find(
    (member) =>
      !member.user.bot &&
      member.user.username.toLowerCase() === autoJoinUsername.toLowerCase() &&
      Boolean(member.voice.channel),
  );
}

function recoverVoiceConnection(guildId: string): Promise<void> {
  const ongoingRecovery = voiceRecoveryTasks.get(guildId);
  if (ongoingRecovery) return ongoingRecovery;

  const recovery = (async () => {
    let attempt = 0;

    while (!shuttingDown) {
      if (!client.isReady()) {
        await delay(2_000);
        continue;
      }

      const guild = client.guilds.cache.get(guildId);
      const member = guild && findAutoJoinMember(guild);
      if (!guild || !member?.voice.channel) return;

      const connection = getVoiceConnection(guildId);
      if (
        connection?.joinConfig.channelId === member.voice.channel.id &&
        connection.state.status === VoiceConnectionStatus.Ready
      ) {
        return;
      }

      if (
        connection?.joinConfig.channelId === member.voice.channel.id &&
        connection.state.status === VoiceConnectionStatus.Disconnected &&
        connection.rejoin()
      ) {
        try {
          await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
          console.info(`[voice] Reconnected in guild ${guildId}.`);
          return;
        } catch {
          // Replace the connection below if rejoining the existing socket failed.
        }
      }

      try {
        await joinMemberVoiceChannel(guild, member, {
          forceReconnect: true,
          playIntro: false,
        });
        console.info(`[voice] Re-established connection in guild ${guildId}.`);
        return;
      } catch (error) {
        const retryDelay = Math.min(1_000 * 2 ** Math.min(attempt, 5), 30_000);
        attempt += 1;
        console.warn(
          `[voice] Reconnect attempt failed in guild ${guildId}; retrying in ${retryDelay / 1_000}s.`,
          error,
        );
        await delay(retryDelay);
      }
    }
  })().finally(() => {
    if (voiceRecoveryTasks.get(guildId) === recovery) {
      voiceRecoveryTasks.delete(guildId);
    }
  });

  voiceRecoveryTasks.set(guildId, recovery);
  return recovery;
}

function watchVoiceConnection(
  guildId: string,
  connection: ReturnType<typeof joinVoiceChannel>,
): void {
  connection.on(VoiceConnectionStatus.Disconnected, () => {
    if (getVoiceConnection(guildId) !== connection) return;
    console.warn(`[voice] Connection dropped in guild ${guildId}; recovering.`);
    void recoverVoiceConnection(guildId);
  });
}

function restoreVoiceConnections(): void {
  for (const guild of client.guilds.cache.values()) {
    const member = findAutoJoinMember(guild);
    if (member?.voice.channel) {
      void recoverVoiceConnection(guild.id);
    }
  }
}

function getPlayback(guildId: string): GuildPlayback {
  let playback = playbacks.get(guildId);
  if (!playback) {
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Stop },
    });
    playback = { player };
    playbacks.set(guildId, playback);
  }
  return playback;
}

function stopPlayback(playback: GuildPlayback): void {
  playback.finishCurrent?.();
  playback.finishCurrent = undefined;
  playback.player.stop(true);
  playback.transcoder?.kill("SIGTERM");
  playback.transcoder = undefined;
}

function leaveVoiceChannel(guildId: string): void {
  activeIntros.delete(guildId);
  const playback = playbacks.get(guildId);
  if (playback) stopPlayback(playback);
  getVoiceConnection(guildId)?.destroy();
}

async function playAudioFile(guildId: string, filePath: string): Promise<void> {
  const connection = getVoiceConnection(guildId);
  if (!connection) {
    throw new Error("The bot is not connected to a voice channel.");
  }
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch {
    throw new Error(
      "The voice connection was not ready in time to play audio.",
    );
  }

  const playback = getPlayback(guildId);
  stopPlayback(playback);
  connection.subscribe(playback.player);

  return new Promise((resolve, reject) => {
    let settled = false;
    let hasPlayed = false;
    let ffmpegError = "";
    let startTimeout: NodeJS.Timeout;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(startTimeout);
      playback.player.off(AudioPlayerStatus.Idle, onIdle);
      playback.player.off(AudioPlayerStatus.Playing, onPlaying);
      playback.player.off("error", onPlayerError);
      if (playback.finishCurrent === finishPlayback) {
        playback.finishCurrent = undefined;
      }
      if (error) reject(error);
      else resolve();
    };
    const onIdle = () => {
      finish(
        hasPlayed
          ? undefined
          : new Error("The audio player stopped before playback began."),
      );
    };
    const onPlaying = () => {
      hasPlayed = true;
      clearTimeout(startTimeout);
    };
    const onPlayerError = (error: Error) => finish(error);
    const finishPlayback = () => finish();

    const transcoder = spawn(
      "ffmpeg",
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        filePath,
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-c:a",
        "libopus",
        "-application",
        "audio",
        "-frame_duration",
        "20",
        "-b:a",
        "128k",
        "-flush_packets",
        "1",
        "-f",
        "ogg",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    playback.transcoder = transcoder;
    playback.finishCurrent = finishPlayback;
    playback.player.once(AudioPlayerStatus.Idle, onIdle);
    playback.player.on(AudioPlayerStatus.Playing, onPlaying);
    playback.player.once("error", onPlayerError);
    transcoder.stderr.setEncoding("utf8");
    transcoder.stderr.on("data", (chunk: string) => {
      ffmpegError += chunk;
    });
    transcoder.on("error", (error) => {
      finish(error);
      playback.player.stop(true);
      transcoder.kill("SIGTERM");
    });
    transcoder.on("close", (code) => {
      if (playback.transcoder === transcoder) playback.transcoder = undefined;
      if (code !== 0 && code !== null && !settled) {
        finish(
          new Error(
            `FFmpeg exited with code ${code}${ffmpegError.trim() ? `: ${ffmpegError.trim()}` : "."}`,
          ),
        );
        playback.player.stop(true);
      }
    });

    startTimeout = setTimeout(() => {
      finish(new Error("The audio player did not start within 20 seconds."));
      playback.player.stop(true);
      transcoder.kill("SIGTERM");
    }, 20_000);

    try {
      playback.player.play(
        createAudioResource(transcoder.stdout, {
          inputType: StreamType.OggOpus,
          metadata: { filePath },
        }),
      );
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      playback.player.stop(true);
      transcoder.kill("SIGTERM");
    }
  });
}

function startIntro(guildId: string): Promise<void> {
  const currentIntro = activeIntros.get(guildId);
  if (currentIntro) return currentIntro;

  const introPath = path.join(audioDirectory, "intro.mp3");
  if (!existsSync(introPath)) {
    if (!missingIntroWarningShown) {
      console.warn(
        "Intro audio not found. Add services/discord-voice-bot/audio/intro.mp3 to enable it.",
      );
      missingIntroWarningShown = true;
    }
    return Promise.resolve();
  }

  const introPromise = playAudioFile(guildId, introPath).catch(
    (error: unknown) => {
      console.error("Could not play the voice-channel intro:", error);
    },
  );
  activeIntros.set(guildId, introPromise);
  void introPromise.finally(() => {
    if (activeIntros.get(guildId) === introPromise) {
      activeIntros.delete(guildId);
    }
  });
  return introPromise;
}

async function playTrack(
  guild: Guild,
  member: GuildMember,
  fileName: string,
): Promise<void> {
  const files = await listAudioFiles();
  if (!files.includes(fileName)) {
    throw new Error("That audio file is not in the bot's audio folder.");
  }

  await joinMemberVoiceChannel(guild, member);
  await activeIntros.get(guild.id);
  await playAudioFile(guild.id, path.join(audioDirectory, fileName));
}

function registerClientListeners(discordClient: Client): void {
  discordClient.on(Events.ClientReady, async (readyClient) => {
    gatewayDisconnectedAt = undefined;
    console.info(
      "[gateway] Discord client is ready; voice-state listener is active.",
    );
    restoreVoiceConnections();
    try {
      const existingCommands = await readyClient.application.commands.fetch();
      for (const command of commands) {
        const existing = existingCommands.find(
          (registered) => registered.name === command.name,
        );
        if (existing) {
          await readyClient.application.commands.edit(existing.id, command);
        } else {
          await readyClient.application.commands.create(command);
        }
      }
      console.info(
        `Logged in as ${readyClient.user.tag}; slash commands are ready.`,
      );
    } catch (error) {
      console.error("Could not register slash commands:", error);
    }
  });

  discordClient.on(Events.ShardDisconnect, (closeEvent, shardId) => {
    gatewayDisconnectedAt ??= Date.now();
    console.warn(
      `[gateway] Shard ${shardId} disconnected (code ${closeEvent.code}); Discord.js will reconnect automatically.`,
    );
  });

  discordClient.on(Events.ShardReconnecting, (shardId) => {
    gatewayDisconnectedAt ??= Date.now();
    console.warn(`[gateway] Reconnecting shard ${shardId}.`);
  });

  discordClient.on(Events.ShardResume, (shardId, replayedEvents) => {
    gatewayDisconnectedAt = undefined;
    console.info(
      `[gateway] Shard ${shardId} resumed; ${replayedEvents} event(s) replayed. Restoring voice connections.`,
    );
    restoreVoiceConnections();
  });

  discordClient.on(Events.VoiceStateUpdate, (oldState, newState) => {
    const member = newState.member ?? oldState.member;
    if (!member || member.user.bot) return;
    if (oldState.channelId === newState.channelId) return;

    const isAutoJoinUser =
      member.user.username.toLowerCase() === autoJoinUsername.toLowerCase();
    console.info(
      `[voice] Channel change received; auto-join username matched: ${isAutoJoinUser}.`,
    );
    const leftOldChannel =
      Boolean(oldState.channelId) && oldState.channelId !== newState.channelId;
    const connection = getVoiceConnection(newState.guild.id);
    const soraLeftVoice =
      isAutoJoinUser && Boolean(oldState.channelId) && !newState.channelId;
    const botChannelIsEmpty =
      Boolean(connection) &&
      leftOldChannel &&
      oldState.channelId === connection?.joinConfig.channelId &&
      Boolean(oldState.channel) &&
      !oldState.channel?.members.some(
        (channelMember) => !channelMember.user.bot,
      );

    if (connection && (soraLeftVoice || botChannelIsEmpty)) {
      leaveVoiceChannel(newState.guild.id);
    }

    if (!isAutoJoinUser || !newState.channelId) return;

    void joinMemberVoiceChannel(newState.guild, member).catch(
      (error: unknown) => {
        console.error(
          `Automatic voice-channel join failed for ${member.user.tag}:`,
          error,
        );
      },
    );
  });

  discordClient.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === "play") {
        await autocompleteTrack(interaction);
      }
      return;
    }
    if (!interaction.isChatInputCommand()) return;

    try {
      if (!interaction.guild) {
        await interaction.reply({
          content: "Use this command in a server.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const member = await getMember(interaction);
      if (!member) {
        await interaction.reply({
          content: "I couldn't find your server member profile.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      switch (interaction.commandName) {
        case "join": {
          await joinMemberVoiceChannel(interaction.guild, member);
          await interaction.reply({
            content: `Joined **${member.voice.channel?.name ?? "your voice channel"}**.`,
            flags: MessageFlags.Ephemeral,
          });
          break;
        }
        case "play": {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const fileName = interaction.options.getString("track", true);
          await playTrack(interaction.guild, member, fileName);
          await interaction.editReply(`Playing **${fileName}**.`);
          break;
        }
        case "stop": {
          const playback = playbacks.get(interaction.guild.id);
          if (playback) stopPlayback(playback);
          await interaction.reply({
            content: playback ? "Playback stopped." : "Nothing is playing.",
            flags: MessageFlags.Ephemeral,
          });
          break;
        }
        case "leave": {
          leaveVoiceChannel(interaction.guild.id);
          await interaction.reply({
            content: "Left the voice channel.",
            flags: MessageFlags.Ephemeral,
          });
          break;
        }
        default:
          await interaction.reply({
            content: "I don't recognize that command.",
            flags: MessageFlags.Ephemeral,
          });
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Something went wrong.";
      console.error(`Command /${interaction.commandName} failed:`, error);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: message });
      } else {
        await interaction.reply({
          content: message,
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  });

  discordClient.on(Events.Error, (error) => {
    console.error("Discord client error:", error);
  });
}

async function shutdown(): Promise<void> {
  shuttingDown = true;
  clearInterval(gatewayWatchdog);
  for (const playback of playbacks.values()) stopPlayback(playback);
  healthServer.close();
  await client.destroy();
}

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

registerClientListeners(client);

try {
  await client.login(token);
} catch (error) {
  console.error(
    "Discord login failed. Check that DISCORD_BOT_TOKEN is the current bot token from the application's Bot page.",
  );
  throw error;
}
