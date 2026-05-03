import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  AttachmentBuilder,
  Channel,
  Client,
  ChannelType,
  GatewayIntentBits,
  Message,
  Partials,
  SendableChannels,
} from 'discord.js';

import { runAgentWithRetry, AgentProgressEvent } from './agent.js';
import { AgentError } from './errors.js';
import {
  AGENT_ID,
  AGENT_TIMEOUT_MS,
  DASHBOARD_PORT,
  DASHBOARD_TOKEN,
  DASHBOARD_URL,
  DISCORD_ALLOWED_CHANNEL_ID,
  DISCORD_ALLOWED_USER_ID,
  DISCORD_BOT_TOKEN,
  EXFILTRATION_GUARD_ENABLED,
  MODEL_FALLBACK_CHAIN,
  PROJECT_ROOT,
  PROTECTED_ENV_VARS,
  SHOW_COST_FOOTER,
  SMART_ROUTING_CHEAP_MODEL,
  SMART_ROUTING_ENABLED,
  agentDefaultModel,
  agentMcpAllowlist,
  agentSystemPrompt,
} from './config.js';
import { buildCostFooter } from './cost-footer.js';
import {
  clearSession,
  getRecentMemories,
  getRecentTaskOutputs,
  getSession,
  pinMemory,
  setSession,
  unpinMemory,
} from './db.js';
import { scanForSecrets, redactSecrets } from './exfiltration-guard.js';
import { logger } from './logger.js';
import {
  MEMORY_NUDGE_TEXT,
  buildMemoryContext,
  evaluateMemoryRelevance,
  saveConversationTurn,
  shouldNudgeMemory,
} from './memory.js';
import { classifyMessageComplexity } from './message-classifier.js';
import { messageQueue } from './message-queue.js';
import { delegateToAgent, parseDelegation } from './orchestrator.js';
import {
  audit,
  checkKillPhrase,
  executeEmergencyKill,
  getSecurityStatus,
  isLocked,
  lock,
  touchActivity,
  unlock,
} from './security.js';
import { emitChatEvent, setActiveAbort, setProcessing } from './state.js';
import { synthesizeSpeech, transcribeAudio, voiceCapabilities } from './voice.js';

// Discord enforces a hard 2000-char per-message ceiling.
const DISCORD_MAX_MESSAGE_LENGTH = 1900;

// Discord typing indicators auto-expire after ~10s.
const DISCORD_TYPING_REFRESH_MS = 8_000;

const chatModelOverride = new Map<string, string>();
const voiceMode = new Map<string, 'on' | 'off'>();

function writeTempFile(buffer: Buffer, suffix: string): string {
  const p = path.join(os.tmpdir(), `claudeclaw-discord-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${suffix}`);
  fs.writeFileSync(p, buffer);
  return p;
}

function tryUnlink(p: string): void {
  try { fs.unlinkSync(p); } catch (err) { logger.warn({ err, path: p }, 'tmp unlink failed'); }
}

/** Is this Discord user allowed to talk to the bot? */
function isAuthorised(userId: string): boolean {
  if (!DISCORD_ALLOWED_USER_ID) return false;
  return userId === DISCORD_ALLOWED_USER_ID;
}

function splitMessage(text: string): string[] {
  if (text.length <= DISCORD_MAX_MESSAGE_LENGTH) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > DISCORD_MAX_MESSAGE_LENGTH) {
    const chunk = remaining.slice(0, DISCORD_MAX_MESSAGE_LENGTH);
    const lastNewline = chunk.lastIndexOf('\n');
    const splitAt = lastNewline > DISCORD_MAX_MESSAGE_LENGTH / 2 ? lastNewline : DISCORD_MAX_MESSAGE_LENGTH;
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

interface FileMarker {
  type: 'document' | 'photo';
  filePath: string;
  caption?: string;
}

function extractFileMarkers(text: string): { text: string; files: FileMarker[] } {
  const files: FileMarker[] = [];
  const pattern = /\[SEND_(FILE|PHOTO):([^\]\|]+)(?:\|([^\]]*))?\]/g;
  const cleaned = text.replace(pattern, (_, kind: string, filePath: string, caption?: string) => {
    files.push({
      type: kind === 'PHOTO' ? 'photo' : 'document',
      filePath: filePath.trim(),
      caption: caption?.trim() || undefined,
    });
    return '';
  });
  return { text: cleaned.replace(/\n{3,}/g, '\n\n').trim(), files };
}

const AVAILABLE_MODELS: Record<string, string> = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-5',
  haiku: 'claude-haiku-4-5',
};

export interface DiscordBot {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Push a message to a recipient (DM user ID or channel ID). */
  sendTo(recipient: string, text: string): Promise<void>;
}

/**
 * Create the Discord bot. Does NOT connect yet — call `start()` to log in
 * and begin receiving messages.
 */
export function createDiscordBot(): DiscordBot {
  if (!DISCORD_BOT_TOKEN) {
    throw new Error(
      'DISCORD_BOT_TOKEN not set in .env. Create a Discord application at https://discord.com/developers/applications and paste its bot token.',
    );
  }
  if (!DISCORD_ALLOWED_USER_ID) {
    throw new Error(
      'DISCORD_ALLOWED_USER_ID not set in .env. With Developer Mode on, right-click your username in Discord and pick "Copy User ID".',
    );
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    // DMs arrive as partial channels by default; force a full fetch so
    // message.author and message.content are populated on first delivery.
    partials: [Partials.Channel, Partials.Message],
  });

  /**
   * Resolve a recipient string (channel ID or user ID for DM) into a
   * channel that supports `.send()`. Returns null if the ID is bad or
   * points at a non-sendable surface (e.g. a category, a partial group DM).
   */
  async function resolveRecipientChannel(recipient: string): Promise<SendableChannels | null> {
    try {
      const channel = await client.channels.fetch(recipient).catch(() => null);
      if (channel && channel.isSendable()) return channel;
      // Fall back to opening a DM with that user ID.
      const user = await client.users.fetch(recipient).catch(() => null);
      if (user) {
        const dm = await user.createDM();
        if (dm.isSendable()) return dm;
      }
    } catch (err) {
      logger.warn({ err, recipient }, 'discord recipient resolution failed');
    }
    return null;
  }

  const sendMessage = async (recipient: string, text: string): Promise<void> => {
    const channel = await resolveRecipientChannel(recipient);
    if (!channel) {
      logger.error({ recipient }, 'discord: could not resolve recipient channel');
      return;
    }
    for (const part of splitMessage(text)) {
      try {
        await channel.send({ content: part });
      } catch (err) {
        logger.error({ err, recipient }, 'discord send failed');
      }
    }
  };

  const sendFile = async (recipient: string, filePath: string, caption?: string): Promise<void> => {
    if (!fs.existsSync(filePath)) {
      await sendMessage(recipient, `Could not send file: ${filePath} (not found)`);
      return;
    }
    const channel = await resolveRecipientChannel(recipient);
    if (!channel) return;
    try {
      const attachment = new AttachmentBuilder(filePath);
      await channel.send({ content: caption, files: [attachment] });
    } catch (err) {
      logger.error({ err, filePath }, 'discord file send failed');
      await sendMessage(recipient, `Failed to send file: ${filePath}`);
    }
  };

  const sendTyping = async (channel: Channel): Promise<void> => {
    try {
      if (channel.isTextBased() && 'sendTyping' in channel) {
        await channel.sendTyping();
      }
    } catch {
      // Best-effort.
    }
  };

  /** Download a Discord attachment URL to a temp file. Returns local path. */
  async function downloadAttachment(url: string, suffix: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return writeTempFile(buf, suffix);
  }

  /**
   * Core message handler — Discord twin of signal-bot.ts handleTextMessage().
   *
   * @param forceVoiceReply  When true the reply is sent as a TTS voice clip
   *   (used after transcribing an inbound voice message).
   */
  async function handleTextMessage(
    message: Message,
    text: string,
    forceVoiceReply = false,
  ): Promise<void> {
    const chatId = message.author.id;

    // Group-DMs and other non-sendable surfaces shouldn't reach us, but guard
    // anyway so TS narrows the channel union to SendableChannels for the rest
    // of this handler.
    if (!message.channel.isSendable()) {
      logger.warn({ channelId: message.channel.id, type: message.channel.type }, 'discord: channel not sendable');
      return;
    }
    const channel = message.channel;

    if (checkKillPhrase(text)) {
      audit({ agentId: AGENT_ID, chatId, action: 'kill', detail: 'Emergency kill via Discord', blocked: false });
      await message.reply('EMERGENCY KILL activated. All agents stopping.').catch(() => {});
      executeEmergencyKill();
      return;
    }

    if (isLocked()) {
      if (unlock(text)) {
        audit({ agentId: AGENT_ID, chatId, action: 'unlock', detail: 'PIN accepted', blocked: false });
        await message.reply('Unlocked. Session active.').catch(() => {});
      } else {
        audit({ agentId: AGENT_ID, chatId, action: 'blocked', detail: 'Session locked, wrong PIN', blocked: true });
        await message.reply('Session locked. Send your PIN to unlock.').catch(() => {});
      }
      return;
    }

    touchActivity();
    audit({ agentId: AGENT_ID, chatId, action: 'message', detail: text.slice(0, 200), blocked: false });
    emitChatEvent({ type: 'user_message', chatId, content: text, source: 'discord' });

    const delegation = parseDelegation(text);
    if (delegation) {
      setProcessing(chatId, true);
      void sendTyping(channel);
      try {
        const result = await delegateToAgent(
          delegation.agentId,
          delegation.prompt,
          chatId,
          AGENT_ID,
          async (progressMsg) => {
            emitChatEvent({ type: 'progress', chatId, description: progressMsg });
            await channel.send(progressMsg).catch(() => {});
          },
        );
        const responseText = result.text?.trim() || 'Agent completed with no output.';
        const header = `[${result.agentId} — ${Math.round(result.durationMs / 1000)}s]`;
        saveConversationTurn(chatId, delegation.prompt, responseText, undefined, delegation.agentId);
        emitChatEvent({ type: 'assistant_message', chatId, content: responseText, source: 'discord' });
        for (const part of splitMessage(`${header}\n\n${responseText}`)) {
          await channel.send(part).catch(() => {});
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, agentId: delegation.agentId }, 'Delegation failed');
        await message.reply(`Delegation to ${delegation.agentId} failed: ${msg}`).catch(() => {});
      } finally {
        setProcessing(chatId, false);
      }
      return;
    }

    const sessionId = getSession(chatId, AGENT_ID);
    const { contextText: memCtx, surfacedMemoryIds, surfacedMemorySummaries } = await buildMemoryContext(chatId, text, AGENT_ID);

    const parts: string[] = [];
    if (agentSystemPrompt && !sessionId) {
      parts.push(`[Agent role — follow these instructions]\n${agentSystemPrompt}\n[End agent role]`);
    }
    if (memCtx) parts.push(memCtx);

    const recentTasks = getRecentTaskOutputs(AGENT_ID, 30);
    if (recentTasks.length > 0) {
      const taskLines = recentTasks.map((t) => {
        const ago = Math.round((Date.now() / 1000 - t.last_run) / 60);
        return `[Scheduled task ran ${ago}m ago]\nTask: ${t.prompt}\nOutput:\n${t.last_result}`;
      });
      parts.push(`[Recent scheduled task context]\n${taskLines.join('\n\n')}\n[End task context]`);
    }

    if (shouldNudgeMemory(chatId, AGENT_ID)) parts.push(MEMORY_NUDGE_TEXT);
    parts.push(text);

    const userModel = chatModelOverride.get(chatId) ?? agentDefaultModel;
    const effectiveModel = (SMART_ROUTING_ENABLED && !userModel && classifyMessageComplexity(text) === 'simple')
      ? SMART_ROUTING_CHEAP_MODEL
      : (userModel ?? 'claude-opus-4-6');

    void sendTyping(channel);
    const typingInterval = setInterval(() => void sendTyping(channel), DISCORD_TYPING_REFRESH_MS);
    setProcessing(chatId, true);

    try {
      const onProgress = (event: AgentProgressEvent): void => {
        emitChatEvent({ type: 'progress', chatId, description: event.description });
        // Discord has no edit-message-with-throttling like Telegram, so emit
        // task boundaries only — tool_active would flood the channel.
        if (event.type === 'task_started') void channel.send(`🔄 ${event.description}`).catch(() => {});
        if (event.type === 'task_completed') void channel.send(`✓ ${event.description}`).catch(() => {});
      };

      const abortCtrl = new AbortController();
      setActiveAbort(chatId, abortCtrl);
      const timeoutId = setTimeout(() => {
        logger.warn({ chatId, timeoutMs: AGENT_TIMEOUT_MS }, 'Agent query timed out (Discord)');
        abortCtrl.abort();
      }, AGENT_TIMEOUT_MS);

      const fullMessage = parts.join('\n\n');

      const result = await runAgentWithRetry(
        fullMessage,
        sessionId,
        () => void sendTyping(channel),
        onProgress,
        effectiveModel,
        abortCtrl,
        /* onStreamText */ undefined,
        async (attempt, error) => {
          await channel.send(`${error.recovery.userMessage} (retry ${attempt}/2)`).catch(() => {});
        },
        MODEL_FALLBACK_CHAIN.length > 0 ? MODEL_FALLBACK_CHAIN : undefined,
        agentMcpAllowlist,
      );

      clearTimeout(timeoutId);
      clearInterval(typingInterval);
      setActiveAbort(chatId, null);

      if (result.aborted) {
        setProcessing(chatId, false);
        const msg = result.text === null
          ? `Timed out after ${Math.round(AGENT_TIMEOUT_MS / 1000)}s. Raise AGENT_TIMEOUT_MS in your .env (default is 1800000 = 30 min) and restart, or break the task into smaller steps.`
          : 'Stopped.';
        emitChatEvent({ type: 'assistant_message', chatId, content: msg, source: 'discord' });
        await channel.send(msg).catch(() => {});
        return;
      }

      if (result.newSessionId) setSession(chatId, result.newSessionId, AGENT_ID);

      let rawResponse = result.text?.trim() || 'Done.';

      if (EXFILTRATION_GUARD_ENABLED) {
        const protectedValues = PROTECTED_ENV_VARS
          .map((key) => process.env[key])
          .filter((v): v is string => !!v && v.length > 8);
        const matches = scanForSecrets(rawResponse, protectedValues);
        if (matches.length > 0) {
          rawResponse = redactSecrets(rawResponse, matches);
          logger.warn({ matchCount: matches.length }, 'Exfiltration guard: redacted secrets (Discord)');
        }
      }

      const { text: responseText, files: fileMarkers } = extractFileMarkers(rawResponse);
      const costFooter = buildCostFooter(SHOW_COST_FOOTER, result.usage, effectiveModel);

      saveConversationTurn(chatId, text, rawResponse, result.newSessionId ?? sessionId, AGENT_ID);
      if (surfacedMemoryIds.length > 0) {
        void evaluateMemoryRelevance(surfacedMemoryIds, surfacedMemorySummaries, text, rawResponse).catch(() => {});
      }
      emitChatEvent({ type: 'assistant_message', chatId, content: rawResponse, source: 'discord' });

      const channelId = channel.id;
      for (const file of fileMarkers) {
        await sendFile(channelId, file.filePath, file.caption);
      }

      const textWithFooter = responseText ? responseText + costFooter : '';
      const caps = voiceCapabilities();
      const mode = voiceMode.get(chatId);
      const shouldSpeakBack = caps.tts && (
        mode === 'on' || (mode !== 'off' && forceVoiceReply)
      );

      if (textWithFooter) {
        if (shouldSpeakBack && responseText) {
          let audioPath: string | null = null;
          try {
            const audioBuffer = await synthesizeSpeech(responseText);
            audioPath = writeTempFile(audioBuffer, '.mp3');
            const attachment = new AttachmentBuilder(audioPath);
            await channel.send({ files: [attachment] });
          } catch (ttsErr) {
            logger.error({ err: ttsErr }, 'TTS failed, falling back to text');
            for (const part of splitMessage(textWithFooter)) {
              await channel.send(part).catch(() => {});
            }
          } finally {
            if (audioPath) tryUnlink(audioPath);
          }
        } else {
          for (const part of splitMessage(textWithFooter)) {
            await channel.send(part).catch(() => {});
          }
        }
      }
    } catch (err) {
      clearInterval(typingInterval);
      setActiveAbort(chatId, null);
      const errMsg = err instanceof AgentError
        ? err.recovery.userMessage
        : err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'Agent run failed (Discord)');
      await channel.send(`Error: ${errMsg}`).catch(() => {});
    } finally {
      setProcessing(chatId, false);
    }
  }

  /** Bare /command dispatch. Returns true if handled. */
  async function handleCommand(message: Message, text: string): Promise<boolean> {
    const chatId = message.author.id;
    const match = text.match(/^\/(\w+)(?:\s+(.*))?$/s);
    if (!match) return false;
    const cmd = match[1].toLowerCase();
    const arg = (match[2] ?? '').trim();

    const reply = (msg: string) => message.reply(msg).catch(() => {});

    switch (cmd) {
      case 'start':
        await reply(`ClaudeClaw online via Discord. Agent: ${AGENT_ID}.\n\nSend /help for commands.`);
        return true;

      case 'help':
        await reply(
          'ClaudeClaw — Commands (Discord)\n\n' +
          '/newchat — Start a new Claude session\n' +
          '/forget — Clear session\n' +
          '/memory — View recent memories\n' +
          '/pin <id> — Pin a memory\n' +
          '/unpin <id> — Unpin a memory\n' +
          '/voice on|off|auto — Voice replies: always / never / mirror input\n' +
          '/model <opus|sonnet|haiku> — Switch model\n' +
          '/agents — List available agents\n' +
          '/delegate <agent> <prompt> — Delegate to an agent\n' +
          '/dashboard — Get dashboard link\n' +
          '/lock — Lock session (PIN required to unlock)\n' +
          '/status — Security status\n' +
          '/stop — Stop current processing\n\n' +
          'Send a voice message for speech-to-text; toggle /voice on for audio replies.\n' +
          'Everything else goes straight to Claude.',
        );
        return true;

      case 'newchat':
      case 'forget':
        clearSession(chatId, AGENT_ID);
        await reply('Session cleared. Next message starts fresh.');
        return true;

      case 'memory': {
        const memories = getRecentMemories(chatId, 10);
        if (memories.length === 0) {
          await reply('No recent memories.');
        } else {
          const lines = memories.map((m) => `#${m.id} [${m.importance.toFixed(1)}] ${m.summary.slice(0, 150)}`);
          await reply(`Recent memories:\n\n${lines.join('\n')}`);
        }
        return true;
      }

      case 'pin': {
        const id = parseInt(arg, 10);
        if (!id) { await reply('Usage: /pin <memory_id>'); return true; }
        pinMemory(id);
        await reply(`Memory #${id} pinned.`);
        return true;
      }

      case 'unpin': {
        const id = parseInt(arg, 10);
        if (!id) { await reply('Usage: /unpin <memory_id>'); return true; }
        unpinMemory(id);
        await reply(`Memory #${id} unpinned.`);
        return true;
      }

      case 'voice': {
        const caps = voiceCapabilities();
        if (!caps.tts) {
          await reply(
            'Voice replies not available. Configure one of:\n' +
            '  ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID\n' +
            '  GRADIUM_API_KEY + GRADIUM_VOICE_ID\n' +
            '  KOKORO_URL (local)\n' +
            '…or leave all unset to fall back to macOS `say` (Mac only).',
          );
          return true;
        }
        const sub = arg.toLowerCase();
        if (sub === 'on') {
          voiceMode.set(chatId, 'on');
          await reply('Voice replies enabled. All replies will be spoken. Send /voice off to disable or /voice auto for default mirroring.');
        } else if (sub === 'off') {
          voiceMode.set(chatId, 'off');
          await reply('Voice replies disabled. All replies (including for voice messages) will be text.');
        } else if (sub === 'auto' || sub === 'reset' || sub === 'default') {
          voiceMode.delete(chatId);
          await reply('Voice replies set to auto (mirror incoming modality).');
        } else {
          const state = voiceMode.get(chatId) ?? 'auto';
          await reply(`Voice replies: ${state}\nUsage: /voice on | /voice off | /voice auto`);
        }
        return true;
      }

      case 'model': {
        const key = arg.toLowerCase();
        if (!key) {
          const current = chatModelOverride.get(chatId) ?? agentDefaultModel ?? 'claude-opus-4-6';
          await reply(`Current model: ${current}\n\nUsage: /model <opus|sonnet|haiku>`);
          return true;
        }
        const target = AVAILABLE_MODELS[key];
        if (!target) { await reply('Unknown model. Use opus, sonnet, or haiku.'); return true; }
        chatModelOverride.set(chatId, target);
        await reply(`Model switched to ${target}.`);
        return true;
      }

      case 'dashboard': {
        const token = DASHBOARD_TOKEN;
        if (!token) { await reply('Dashboard not configured (DASHBOARD_TOKEN missing).'); return true; }
        const base = DASHBOARD_URL || `http://localhost:${DASHBOARD_PORT}`;
        const url = `${base}/?token=${token}&chatId=${encodeURIComponent(chatId)}`;
        await reply(`Dashboard:\n${url}`);
        return true;
      }

      case 'agents': {
        const agentsDir = path.join(PROJECT_ROOT, 'agents');
        let ids: string[] = [];
        try {
          ids = fs.readdirSync(agentsDir).filter((d) => fs.statSync(path.join(agentsDir, d)).isDirectory());
        } catch { /* no agents dir */ }
        await reply(ids.length ? `Agents: ${ids.join(', ')}` : 'No additional agents configured.');
        return true;
      }

      case 'delegate': {
        if (!arg) { await reply('Usage: /delegate <agent> <prompt>'); return true; }
        await handleTextMessage(message, `/delegate ${arg}`);
        return true;
      }

      case 'lock':
        lock();
        await reply('Session locked. Send your PIN to unlock.');
        return true;

      case 'status': {
        const s = getSecurityStatus();
        const lines = [
          `PIN lock: ${s.pinEnabled ? (s.locked ? 'locked' : 'unlocked') : 'disabled'}`,
          `Kill phrase: ${s.killPhraseEnabled ? 'enabled' : 'disabled'}`,
          `Idle lock: ${s.idleLockMinutes > 0 ? `${s.idleLockMinutes} min` : 'disabled'}`,
        ];
        await reply(lines.join('\n'));
        return true;
      }

      case 'stop': {
        const { abortActiveQuery } = await import('./state.js');
        abortActiveQuery(chatId);
        await reply('Stopping.');
        return true;
      }

      default:
        return false;
    }
  }

  const onMessage = async (message: Message): Promise<void> => {
    if (message.author.bot) return;
    if (!isAuthorised(message.author.id)) {
      logger.warn({ sender: message.author.id }, 'Dropped unauthorized Discord message');
      return;
    }

    const isDM = message.channel.type === ChannelType.DM;

    // Guild messages: require a mention OR matching DISCORD_ALLOWED_CHANNEL_ID.
    // DMs always pass (already gated by isAuthorised on the user).
    if (!isDM) {
      const mentioned = message.mentions.users.has(client.user?.id ?? '');
      const inAllowedChannel =
        DISCORD_ALLOWED_CHANNEL_ID && message.channel.id === DISCORD_ALLOWED_CHANNEL_ID;
      if (!mentioned && !inAllowedChannel) return;
    }

    // Strip a leading @bot mention from the text so commands like
    // "@bot /help" parse the same as a DM.
    let text = message.content.trim();
    const botId = client.user?.id;
    if (botId) {
      text = text.replace(new RegExp(`^<@!?${botId}>\\s*`), '').trim();
    }

    // Voice-message handling. Discord voice messages arrive as an attachment
    // with `.duration` set or a content-type starting with `audio/`. The blob
    // is hosted on Discord's CDN; download to /tmp and feed to Groq/whisper.
    const voiceAttachment = message.attachments.find((a) =>
      (a.contentType?.startsWith('audio/') ?? false) || a.name?.toLowerCase().endsWith('.ogg'),
    );

    if (voiceAttachment) {
      const caps = voiceCapabilities();
      if (!caps.stt) {
        await message.reply(
          'Voice transcription not configured. Set GROQ_API_KEY for cloud STT or install whisper-cpp for local STT.',
        ).catch(() => {});
        return;
      }
      messageQueue.enqueue(message.author.id, async () => {
        let transcribePath: string | null = null;
        try {
          const ext = path.extname(voiceAttachment.name ?? '') || '.ogg';
          transcribePath = await downloadAttachment(voiceAttachment.url, ext);
          const transcript = await transcribeAudio(transcribePath);
          if (!transcript.trim()) {
            await message.reply('Could not understand the audio. Try again.').catch(() => {});
            return;
          }
          logger.info({ chatId: message.author.id, len: transcript.length }, 'Discord voice transcribed');
          emitChatEvent({ type: 'user_message', chatId: message.author.id, content: `[voice] ${transcript}`, source: 'discord' });
          await handleTextMessage(message, transcript, /* forceVoiceReply */ true);
        } catch (err) {
          logger.error({ err }, 'Voice transcription failed (Discord)');
          await message.reply('Voice transcription failed. Try again or send text.').catch(() => {});
        } finally {
          if (transcribePath) tryUnlink(transcribePath);
        }
      });
      return;
    }

    if (!text && message.attachments.size === 0) return;

    if (text.startsWith('/')) {
      const handled = await handleCommand(message, text);
      if (handled) return;
    }

    messageQueue.enqueue(message.author.id, () => handleTextMessage(message, text));
  };

  return {
    async start(): Promise<void> {
      client.on('messageCreate', (msg) =>
        void onMessage(msg).catch((err) => logger.error({ err }, 'discord onMessage threw')),
      );
      client.once('ready', (c) => {
        logger.info({ tag: c.user.tag, id: c.user.id }, 'Discord bot connected');
      });
      await client.login(DISCORD_BOT_TOKEN);
    },
    async stop(): Promise<void> {
      try { await client.destroy(); } catch { /* already gone */ }
    },
    async sendTo(recipient: string, text: string): Promise<void> {
      await sendMessage(recipient, text);
    },
  };
}

export { splitMessage };
