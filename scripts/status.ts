#!/usr/bin/env tsx
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ── ANSI helpers ────────────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function ok(msg: string) {
  console.log(`  ${c.green}✓${c.reset}  ${msg}`);
}
function warn(msg: string) {
  console.log(`  ${c.yellow}⚠${c.reset}  ${msg}`);
}
function fail(msg: string) {
  console.log(`  ${c.red}✗${c.reset}  ${msg}`);
}

function parseEnvFile(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return result;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }
  return result;
}

async function main() {
  console.log();
  console.log(`  ${c.bold}${c.cyan}ClaudeClaw Status${c.reset}`);
  console.log(`  ${c.gray}${'─'.repeat(17)}${c.reset}`);

  // Node version
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0], 10);
  if (nodeMajor >= 20) {
    ok(`Node ${nodeVersion}`);
  } else {
    fail(`Node ${nodeVersion} (20+ required)`);
  }

  // Claude CLI
  const claudeCmd = process.platform === 'win32' ? 'where claude' : 'which claude';
  try {
    execSync(claudeCmd, { stdio: 'pipe' });
    let claudeVersion = '';
    try {
      claudeVersion = execSync('claude --version', { stdio: 'pipe' })
        .toString()
        .trim();
    } catch {
      // version check failed
    }
    ok(`Claude CLI ${claudeVersion}`);
  } catch {
    fail('Claude CLI not found');
  }

  // .env
  const envPath = path.join(PROJECT_ROOT, '.env');
  const env = parseEnvFile(envPath);

  const messenger = (env.MESSENGER_TYPE || 'telegram').toLowerCase();

  if (messenger === 'discord') {
    // Discord bot token
    if (env.DISCORD_BOT_TOKEN) {
      try {
        const res = await fetch('https://discord.com/api/v10/users/@me', {
          headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
        });
        const data = (await res.json().catch(() => ({}))) as { username?: string; id?: string };
        if (res.ok && data.username) {
          ok(`Discord bot: ${data.username} (id ${data.id})`);
        } else {
          fail('Discord bot token: invalid');
        }
      } catch {
        warn('Discord bot token: set but could not validate (network error)');
      }
    } else {
      fail('Discord bot token: not configured');
    }

    if (env.DISCORD_ALLOWED_USER_ID) {
      ok(`Discord user ID: ${env.DISCORD_ALLOWED_USER_ID}`);
    } else {
      fail('Discord user ID: not set — bot will reject all messages');
    }

    if (env.DISCORD_ALLOWED_CHANNEL_ID) {
      ok(`Discord channel ID: ${env.DISCORD_ALLOWED_CHANNEL_ID}`);
    }
  } else {
    // Telegram bot token
    if (env.TELEGRAM_BOT_TOKEN) {
      try {
        const res = await fetch(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`,
        );
        const data = (await res.json()) as {
          ok: boolean;
          result?: { username?: string };
        };
        if (data.ok && data.result?.username) {
          ok(`Bot token: @${data.result.username}`);
        } else {
          fail('Bot token: invalid');
        }
      } catch {
        warn('Bot token: set but could not validate (network error)');
      }
    } else {
      fail('Bot token: not configured');
    }

    // Chat ID
    if (env.ALLOWED_CHAT_ID) {
      ok(`Chat ID: ${env.ALLOWED_CHAT_ID}`);
    } else {
      warn('Chat ID: not set');
    }
  }

  // Voice STT
  if (env.GROQ_API_KEY) {
    ok('Voice STT: Groq (configured)');
  } else {
    warn('Voice STT: not configured');
  }

  // Voice TTS
  if (env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID) {
    ok('Voice TTS: ElevenLabs (configured)');
  } else {
    warn('Voice TTS: not configured');
  }

  // Service status
  if (process.platform === 'darwin') {
    try {
      const output = execSync('launchctl list com.claudeclaw.app', {
        stdio: 'pipe',
      })
        .toString()
        .trim();
      const pidMatch = output.match(/"PID"\s*=\s*(\d+)/);
      if (pidMatch) {
        ok(`Service: running (PID ${pidMatch[1]})`);
      } else {
        const lines = output.split('\n');
        let pid = '';
        for (const line of lines) {
          const parts = line.split('\t');
          if (parts.length >= 3 && parts[2] === 'com.claudeclaw.app') {
            pid = parts[0].trim();
            break;
          }
        }
        if (pid && pid !== '-') {
          ok(`Service: running (PID ${pid})`);
        } else {
          warn('Service: loaded but not running');
        }
      }
    } catch {
      warn('Service: not installed');
    }
  } else if (process.platform === 'linux') {
    try {
      const output = execSync('systemctl --user is-active claudeclaw', {
        stdio: 'pipe',
      }).toString().trim();
      if (output === 'active') {
        ok('Service: running (systemd)');
      } else {
        warn(`Service: ${output}`);
      }
    } catch {
      warn('Service: not installed (systemd)');
    }
  } else {
    try {
      execSync('pm2 describe claudeclaw', { stdio: 'pipe' });
      ok('Service: running (PM2)');
    } catch {
      warn('Service: not detected (check PM2 or start manually)');
    }
  }

  // Memory DB
  const dbPath = path.join(PROJECT_ROOT, 'store', 'claudeclaw.db');
  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const row = db.prepare('SELECT COUNT(*) AS cnt FROM memories').get() as {
        cnt: number;
      };
      ok(`Memory DB: ${row.cnt} memories stored`);
      db.close();
    } catch {
      warn('Memory DB: exists but could not read');
    }
  } else {
    warn('Memory DB: not initialized (run the bot first)');
  }

  // Footer
  console.log(`  ${c.gray}${'─'.repeat(17)}${c.reset}`);

  // Determine overall status
  const hasToken = messenger === 'discord'
    ? !!(env.DISCORD_BOT_TOKEN && env.DISCORD_ALLOWED_USER_ID)
    : !!env.TELEGRAM_BOT_TOKEN;
  const hasClaude = (() => {
    try {
      execSync('which claude', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  })();

  if (hasToken && hasClaude && nodeMajor >= 20) {
    console.log(`  ${c.green}${c.bold}All systems go.${c.reset}`);
  } else {
    console.log(
      `  ${c.yellow}${c.bold}Some checks need attention.${c.reset}`,
    );
  }

  console.log();
}

main().catch((err) => {
  console.error(`  ${c.red}Status check failed:${c.reset}`, err);
  process.exit(1);
});
