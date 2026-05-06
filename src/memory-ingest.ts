import { query } from '@anthropic-ai/claude-agent-sdk';
import { generateContent, parseJsonResponse } from './gemini.js';
import { cosineSimilarity, embedText } from './embeddings.js';
import { getMemoriesWithEmbeddings, saveStructuredMemoryAtomic } from './db.js';
import { logger } from './logger.js';
import { readEnvFile } from './env.js';
import { getScrubbedSdkEnv } from './security.js';

// Callback for notifying when a high-importance memory is created.
// Set by bot.ts to send a Telegram notification.
let onHighImportanceMemory: ((memoryId: number, summary: string, importance: number) => void) | null = null;

// Quota-aware backoff. When Gemini returns 429 RESOURCE_EXHAUSTED we
// pause ingestion for INGEST_QUOTA_BACKOFF_MS instead of retrying on
// every turn — otherwise the log fills with the same error and we burn
// quota the moment it refreshes. After the window we try again; if it
// still 429s we reset the cooldown. Surface the suspended state via
// `getIngestionQuotaStatus` so /api/health can show "memory paused".
const INGEST_QUOTA_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes
let _ingestSuspendedUntil = 0;
let _last429At = 0;

function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|RESOURCE_EXHAUSTED|quota/i.test(msg);
}

/**
 * Extract a memory via Claude Haiku through the Agent SDK on the OAuth
 * subscription path. Used as the PRIMARY extractor — Gemini was hitting
 * 429 RESOURCE_EXHAUSTED on free-tier quota, leaving every conversation
 * with no long-term memory written. Haiku via OAuth uses the same auth
 * the agents use; no extra API key required.
 *
 * Returns the raw JSON string the model produced (or empty string on
 * failure). Caller is responsible for parsing + validation, same as
 * before — keeps the contract identical to generateContent().
 */
export async function extractViaClaude(prompt: string, timeoutMs = 15_000): Promise<string> {
  const secrets = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
  const env = getScrubbedSdkEnv(secrets);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let text = '';
  try {
    async function* turn(): AsyncGenerator<{
      type: 'user';
      message: { role: 'user'; content: string };
      parent_tool_use_id: null;
      session_id: string;
    }> {
      yield {
        type: 'user',
        message: { role: 'user', content: prompt },
        parent_tool_use_id: null,
        session_id: '',
      };
    }
    for await (const ev of query({
      prompt: turn(),
      options: {
        model: 'claude-haiku-4-5-20251001',
        allowedTools: [],
        disallowedTools: ['*'],
        settingSources: [],
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        env,
        abortController: abort,
      } as any,
    })) {
      const e = ev as Record<string, unknown>;
      if (e.type === 'result' && typeof e.result === 'string') {
        text = e.result;
      }
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'Memory extraction (Claude Haiku) failed');
    throw err;
  } finally {
    clearTimeout(timer);
  }
  return text;
}

export function getIngestionQuotaStatus(): {
  suspended: boolean;
  suspendedUntil: number | null;
  last429At: number | null;
} {
  const now = Date.now();
  return {
    suspended: now < _ingestSuspendedUntil,
    suspendedUntil: _ingestSuspendedUntil > now ? _ingestSuspendedUntil : null,
    last429At: _last429At > 0 ? _last429At : null,
  };
}

export function setHighImportanceCallback(cb: (memoryId: number, summary: string, importance: number) => void): void {
  onHighImportanceMemory = cb;
}

interface ExtractionResult {
  summary: string;
  entities: string[];
  topics: string[];
  importance: number;
}

const EXTRACTION_PROMPT = `You are a memory extraction agent. Given a conversation exchange between a user and their AI assistant, decide if it contains information worth remembering LONG-TERM (weeks/months from now).

The bar is HIGH. Most exchanges should be skipped. Only extract if a future conversation would go noticeably worse without this memory.

SKIP (return {"skip": true}) if:
- The message is just an acknowledgment (ok, yes, no, got it, thanks, send it, do it)
- It's a command with no lasting context (/chatid, /help, checkpoint, convolife, etc)
- It's ephemeral task execution (send this email, check my calendar, read this message, draft a response, move these emails, fill out this form)
- The content is only relevant to this exact moment or this session
- It's a greeting or small talk with no substance
- It's a one-off action request like "shorten that", "generate 3 ideas", "look up X", "draft a reply"
- It's a correction of a typo or minor instruction adjustment
- It's asking for information or a status check ("how much did we make", "what's trending", "what time is it")
- The assistant is SUMMARIZING what it just did ("I sent the messages", "Here's what I moved", "Done, here's your inbox")
- The assistant is SUMMARIZING the session or recapping prior conversation. Session summaries are meta-information, not new facts.
- It's form-filling, application steps, or draft iteration that won't matter once the form is submitted
- It describes what the assistant sent/did/moved/drafted for the user (these are task logs, not memories)
- The exchange is about a specific person's one-time message or request that won't recur

EXTRACT only if the exchange reveals:
- User preferences or habits that apply GOING FORWARD (not just this one time)
- Decisions or policies (how to handle X from now on)
- Important relationships: WHO someone is and HOW the user relates to them (not what they said in one message)
- Corrections to the assistant's behavior (feedback on approach)
- Business rules or workflows that are STANDING RULES
- Recurring patterns or routines
- Technical preferences or architectural decisions

If extracting, return JSON:
{
  "skip": false,
  "summary": "1-2 sentence summary focused on the LASTING FACT, not the conversation. Write as a rule or fact, not a narrative.",
  "entities": ["entity1", "entity2"],
  "topics": ["topic1", "topic2"],
  "importance": 0.0-1.0
}

Importance guide:
- 0.8-1.0: Core identity, strong preferences, critical business rules, relationship dynamics
- 0.5-0.7: Useful context, standing project decisions, moderate preferences, workflow patterns
- 0.3-0.4: Borderline. If in doubt, skip. Only extract if you are confident this will matter in a future session.

User message: {USER_MESSAGE}
Assistant response: {ASSISTANT_RESPONSE}`;

/**
 * Analyze a conversation turn and extract structured memory if warranted.
 * Called async (fire-and-forget) after the assistant responds.
 * Returns true if a memory was saved, false if skipped.
 */
export async function ingestConversationTurn(
  chatId: string,
  userMessage: string,
  assistantResponse: string,
  agentId = 'main',
  /** Multi-user (v0.1.0): tag the new memory with the human who owns
   *  this conversation. NULL for paths that don't yet have user
   *  identity (war room, legacy callers); migration 004 backfills any
   *  pre-existing rows to the owner. */
  userId?: number,
): Promise<boolean> {
  // Hard filter: skip very short messages and commands
  if (userMessage.length <= 15 || userMessage.startsWith('/')) return false;

  // If we recently hit a quota wall, don't even try — it'll just spam the
  // log with the same RESOURCE_EXHAUSTED error every turn. Surface the
  // suspended state via getIngestionQuotaStatus so /api/health can warn.
  if (Date.now() < _ingestSuspendedUntil) return false;

  try {
    const prompt = EXTRACTION_PROMPT
      .replace('{USER_MESSAGE}', userMessage.slice(0, 2000))
      .replace('{ASSISTANT_RESPONSE}', assistantResponse.slice(0, 2000));

    // Primary path: Claude Haiku via OAuth (no API key, no quota wall).
    // We swapped from Gemini because the free-tier RESOURCE_EXHAUSTED
    // was hitting on every turn and silently killing memory ingestion.
    let raw: string;
    try {
      raw = await extractViaClaude(prompt);
    } catch (claudeErr) {
      // Fallback: try Gemini if it has a key configured. The 429 backoff
      // path inside the catch below handles quota errors gracefully.
      logger.warn({ err: claudeErr instanceof Error ? claudeErr.message : claudeErr }, 'Claude extraction failed; falling back to Gemini');
      raw = await generateContent(prompt);
    }
    const result = parseJsonResponse<ExtractionResult & { skip?: boolean }>(raw);

    if (!result || result.skip) return false;

    // Validate required fields
    if (!result.summary || typeof result.importance !== 'number') {
      logger.warn({ result }, 'Gemini extraction missing required fields');
      return false;
    }

    // Hard filter: only save memories with meaningful importance.
    // 0.5 threshold ensures only genuinely useful context gets through.
    // The 0.3-0.4 tier was almost entirely noise (task logs, form steps).
    if (result.importance < 0.5) return false;

    // Clamp importance to valid range
    const importance = Math.max(0, Math.min(1, result.importance));

    // Generate embedding early so we can check for duplicates before saving
    let embedding: number[] = [];
    try {
      const embeddingText = `${result.summary} ${(result.entities ?? []).join(' ')} ${(result.topics ?? []).join(' ')}`;
      embedding = await embedText(embeddingText);
    } catch (embErr) {
      logger.warn({ err: embErr }, 'Failed to generate embedding for duplicate check');
    }

    // Duplicate detection: skip if a very similar memory already exists
    if (embedding.length > 0) {
      const existing = getMemoriesWithEmbeddings(chatId);
      for (const mem of existing) {
        const sim = cosineSimilarity(embedding, mem.embedding);
        if (sim > 0.85) {
          logger.debug(
            { similarity: sim.toFixed(3), existingId: mem.id, newSummary: result.summary.slice(0, 60) },
            'Skipping duplicate memory',
          );
          return false;
        }
      }
    }

    const memoryId = saveStructuredMemoryAtomic(
      chatId,
      userMessage,
      result.summary,
      result.entities ?? [],
      result.topics ?? [],
      importance,
      embedding,
      'conversation',
      agentId,
      userId,
    );

    // Notify on high-importance memories so the user can pin them
    if (importance >= 0.8 && onHighImportanceMemory) {
      try { onHighImportanceMemory(memoryId, result.summary, importance); } catch { /* non-fatal */ }
    }

    logger.info(
      { chatId, importance, memoryId, topics: result.topics, summary: result.summary.slice(0, 80) },
      'Memory ingested',
    );
    return true;
  } catch (err) {
    // Gemini failure should never block the bot.
    // 429 / quota errors deserve a cooldown — otherwise every turn fires
    // the same failed call and floods the log. Suspend ingestion for the
    // configured window; subsequent calls return early until the window
    // expires. Drop the log level on the suspension itself so we don't
    // re-warn every time the cooldown is hit.
    if (isQuotaError(err)) {
      _last429At = Date.now();
      const wasSuspended = _ingestSuspendedUntil > Date.now();
      _ingestSuspendedUntil = Date.now() + INGEST_QUOTA_BACKOFF_MS;
      if (!wasSuspended) {
        logger.warn(
          { backoffMs: INGEST_QUOTA_BACKOFF_MS },
          'Memory ingestion quota exceeded (Gemini 429). Suspending ingestion until cooldown expires.',
        );
      }
      return false;
    }
    logger.error({ err }, 'Memory ingestion failed (Gemini)');
    return false;
  }
}
