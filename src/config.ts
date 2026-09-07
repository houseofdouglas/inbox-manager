import dotenv from 'dotenv';
import { AIProvider, ClaudeModel, GeminiModel, UsageMetadata } from './types.js';

export type LlamaModel = string; // freeform — set to whatever model name the server expects

dotenv.config();

const CLAUDE_MODEL_MAP: Record<ClaudeModel, string> = {
  'opus': 'claude-opus-4-5-20251101',
  'sonnet': 'claude-sonnet-4-5-20250929',
  'haiku': 'claude-3-5-haiku-20241022'
};

export const config = {
  aiProvider: (process.env.AI_PROVIDER as AIProvider) || 'llama',

  // Claude config
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  claudeModel: (process.env.CLAUDE_MODEL as ClaudeModel) || 'sonnet',

  // Gemini config
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: (process.env.GEMINI_MODEL as GeminiModel) || 'gemini-2.5-flash',

  // llama.cpp config
  llamaBaseUrl: process.env.LLAMA_BASE_URL || 'http://localhost:8080',
  llamaModel: process.env.LLAMA_MODEL || 'local',

  // Optional self-healing: when the model server stops generating, a run can
  // restart it. Empty ssh host means "same machine" (restart locally) if the
  // base URL is loopback, and "don't try" otherwise.
  llamaSshHost: process.env.LLAMA_SSH_HOST || '',

  // One prefix for every launchd job this project installs, matching
  // LABEL_PREFIX in host/config.sh. Keep the two machines in agreement:
  // a run that restarts the model server addresses it by this label.
  launchdLabelPrefix: process.env.LAUNCHD_LABEL_PREFIX || 'com.inbox-manager',

  get llamaServiceLabel(): string {
    return process.env.LLAMA_SERVICE_LABEL || `${this.launchdLabelPrefix}.mlx-server`;
  },

  // Shell command that restarts the model server, run on the host. The default
  // is macOS/launchd; a Linux or Windows host must set LLAMA_RESTART_CMD to
  // whatever restarts its service (e.g. `systemctl --user restart ollama`).
  // Empty disables automatic restarts entirely.
  get llamaRestartCmd(): string {
    if (process.env.LLAMA_RESTART_CMD !== undefined) return process.env.LLAMA_RESTART_CMD;
    return `launchctl kickstart -k gui/$(id -u)/${this.llamaServiceLabel}`;
  },

  get dailyJobLabel(): string {
    return `${this.launchdLabelPrefix}.inbox-daily`;
  },

  // Recipient for the daily digest and failure alerts.
  // Empty means "whichever account token.json authorized" — resolved at runtime.
  digestRecipient: process.env.DIGEST_RECIPIENT || '',
  // Which signed-in Google account the digest's deal links open. Matches the
  // /u/<n>/ segment Gmail shows in its own URLs.
  gmailAccountIndex: process.env.GMAIL_ACCOUNT_INDEX || '0',

  // General config
  batchSize: parseInt(process.env.BATCH_SIZE || '50', 10),
  dryRun: process.env.DRY_RUN === 'true',
  dbPath: process.env.DB_PATH || 'inbox.db',

  getClaudeModelId(): string {
    return CLAUDE_MODEL_MAP[this.claudeModel];
  }
};

export function validateConfig(): void {
  if (!['claude', 'gemini', 'llama', 'claude-cli'].includes(config.aiProvider)) {
    throw new Error('AI_PROVIDER must be one of: claude, gemini, llama, claude-cli');
  }

  if (config.aiProvider === 'claude') {
    if (!config.anthropicApiKey) {
      throw new Error('ANTHROPIC_API_KEY is required when using Claude');
    }
    if (!['opus', 'sonnet', 'haiku'].includes(config.claudeModel)) {
      throw new Error('CLAUDE_MODEL must be one of: opus, sonnet, haiku');
    }
  }

  if (config.aiProvider === 'gemini') {
    if (!config.geminiApiKey) {
      throw new Error('GEMINI_API_KEY is required when using Gemini');
    }
    if (!['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash-exp', 'gemini-1.5-flash', 'gemini-1.5-pro'].includes(config.geminiModel)) {
      throw new Error('GEMINI_MODEL must be one of: gemini-2.5-flash, gemini-2.5-flash-lite, gemini-2.0-flash-exp, gemini-1.5-flash, gemini-1.5-pro');
    }
  }
}

// Pricing per 1M tokens in USD
const PRICING = {
  claude: {
    'opus': { input: 5.00, output: 25.00 },
    'sonnet': { input: 3.00, output: 15.00 },
    'haiku': { input: 1.00, output: 5.00 }
  },
  gemini: {
    'gemini-2.5-flash': { input: 0.15, output: 0.60 },
    'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
    'gemini-2.0-flash-exp': { input: 0.30, output: 2.50 },
    'gemini-1.5-flash': { input: 0.15, output: 0.60 },
    'gemini-1.5-pro': { input: 1.25, output: 5.00 }
  }
};

export function calculateCost(usage: UsageMetadata): number {
  if (config.aiProvider === 'llama' || config.aiProvider === 'claude-cli') return 0;

  let inputCost = 0;
  let outputCost = 0;

  if (config.aiProvider === 'claude') {
    const pricing = PRICING.claude[config.claudeModel];
    inputCost = (usage.inputTokens / 1_000_000) * pricing.input;
    outputCost = (usage.outputTokens / 1_000_000) * pricing.output;
  } else {
    const pricing = PRICING.gemini[config.geminiModel];
    inputCost = (usage.inputTokens / 1_000_000) * pricing.input;
    outputCost = (usage.outputTokens / 1_000_000) * pricing.output;
  }

  return inputCost + outputCost;
}
