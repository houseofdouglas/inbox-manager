import { request } from 'undici';
import { EmailClassification, EmailData } from '../types.js';

interface OpenAIChatResponse {
  choices: Array<{
    message: { content: string };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

const BATCH_SIZE = 15;
const CONCURRENCY = 3;

// Thrown when the llama server can't be reached at all (down, network error,
// no model loaded) — distinct from a per-email parse/response error so callers
// can tell "the endpoint is broken" from "this one email was weird".
export class LlamaConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlamaConnectionError';
  }
}

export class LlamaClassifier {
  private baseUrl: string;
  private model: string;

  constructor(baseUrl: string = 'http://localhost:8080', model: string = 'local') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
  }

  // Lightweight reachability check — is anything listening at all.
  // NOT a health check: /v1/models is served by the HTTP thread and keeps
  // answering 200 after the generation thread dies. Use canGenerate() to decide
  // whether the server can actually do work.
  async isHealthy(): Promise<boolean> {
    try {
      const { statusCode } = await request(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        headersTimeout: 5_000,
        bodyTimeout: 5_000,
      });
      return statusCode === 200;
    } catch {
      return false;
    }
  }

  // The real health check: ask for a completion. On 2026-09-04 a Metal OOM
  // killed mlx_lm's generation thread while the process kept serving
  // /v1/models, so isHealthy() reported a working server for 22 hours while
  // every classification timed out.
  async canGenerate(timeoutMs = 60_000): Promise<boolean> {
    try {
      const { statusCode, body } = await request(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
          max_tokens: 10,
          temperature: 0,
          chat_template_kwargs: { enable_thinking: false },
        }),
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });
      if (statusCode !== 200) return false;
      const data = await body.json() as OpenAIChatResponse;
      return Boolean(data.choices?.[0]?.message?.content);
    } catch {
      return false;
    }
  }

  private async callApi(prompt: string, maxTokens: number): Promise<string> {
    let response;
    try {
      response = await request(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          temperature: 0,
          chat_template_kwargs: { enable_thinking: false },
        }),
        headersTimeout: 120_000,
        bodyTimeout: 120_000,
      });
    } catch (err) {
      throw new LlamaConnectionError(`Cannot reach llama server at ${this.baseUrl}: ${(err as Error).message}`);
    }

    const { body, statusCode } = response;

    // 404 (no model loaded) and 5xx (server crashed/overloaded) mean the endpoint
    // itself is broken, not that this particular request was malformed.
    if (statusCode === 404 || statusCode >= 500) {
      throw new LlamaConnectionError(`llama server unavailable (HTTP ${statusCode})`);
    }
    if (statusCode !== 200) {
      throw new Error(`llama server error: ${statusCode}`);
    }

    const data = await body.json() as OpenAIChatResponse;
    return data.choices[0]?.message?.content ?? '';
  }

  // Single-email classify — used by the `organize` command
  async classify(email: EmailData): Promise<EmailClassification> {
    const text = await this.callApi(this.buildSinglePrompt(email), 200);
    return this.parseSingle(text);
  }

  // Multi-email batch — 15 emails → 1 API call
  async classifyBatch(emails: EmailData[]): Promise<Map<string, EmailClassification>> {
    const results = new Map<string, EmailClassification>();

    // Split into chunks of BATCH_SIZE
    const chunks: EmailData[][] = [];
    for (let i = 0; i < emails.length; i += BATCH_SIZE) {
      chunks.push(emails.slice(i, i + BATCH_SIZE));
    }

    // Process chunks with limited concurrency
    for (let i = 0; i < chunks.length; i += CONCURRENCY) {
      const window = chunks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        window.map(chunk => this.classifyChunk(chunk))
      );
      const needsRetry: EmailData[] = [];
      settled.forEach((outcome, idx) => {
        if (outcome.status === 'fulfilled') {
          outcome.value.forEach((cls, id) => results.set(id, cls));
        } else {
          // Chunk failed. Retry its emails one at a time rather than guessing.
          // This used to label all 15 as marketing/Unknown, which is actively
          // destructive: callers archive everything that isn't personal, so a
          // single failed chunk silently archived 15 real emails.
          console.error('Batch chunk failed, retrying per-email:', outcome.reason);
          needsRetry.push(...window[idx]);
        }
      });

      // Per-email retry. Anything still failing is left OUT of the map — the
      // caller treats a missing id as an error and leaves the email untouched,
      // so it gets picked up by a later run instead of being mislabelled.
      for (let j = 0; j < needsRetry.length; j += CONCURRENCY) {
        const retryWindow = needsRetry.slice(j, j + CONCURRENCY);
        const retried = await Promise.allSettled(
          retryWindow.map(email => this.classify(email))
        );
        retried.forEach((outcome, idx) => {
          if (outcome.status === 'fulfilled') {
            results.set(retryWindow[idx].id, outcome.value);
          }
        });
      }
    }

    return results;
  }

  private async classifyChunk(emails: EmailData[]): Promise<Map<string, EmailClassification>> {
    const prompt = this.buildBatchPrompt(emails);
    const text = await this.callApi(prompt, BATCH_SIZE * 50);
    return this.parseBatch(text, emails);
  }

  private buildBatchPrompt(emails: EmailData[]): string {
    const lines = emails.map((e, i) => {
      const content = e.body ? e.body.slice(0, 300) : e.snippet.slice(0, 300);
      return `[${i + 1}] From: ${e.from} | Subject: ${e.subject} | Content: ${content}`;
    });

    return `Classify each email below. Categories: marketing (promo/newsletter), transactional (receipt/notification/account), personal (real person).

${lines.join('\n')}

Output a JSON array — one object per email, in order. Fields: i (1-based index), category, company (brand name only, omit for personal), confidence (0-1).
Example: [{"i":1,"category":"marketing","company":"Amazon","confidence":0.97},{"i":2,"category":"personal","confidence":0.9}]

Company name rule: SHORT consumer brand name only — never copy the legal entity or domain from the From address.
  "Chamberlain Group LLC" → "Chamberlain" | "myQ (Chamberlain)" → "Chamberlain" | "Amazon.com" → "Amazon"
  No LLC/Inc/Corp/Group/Ltd. No .com/.net. Title case.

Output the JSON array only, no other text.`;
  }

  private buildSinglePrompt(email: EmailData): string {
    const content = email.body
      ? `Body:\n${email.body.slice(0, 4000)}`
      : `Preview: ${email.snippet}`;
    return `Classify this email. Categories: marketing, transactional, personal.

From: ${email.from}
Subject: ${email.subject}
${content}

Company name rule: use the SHORT consumer brand name, never the legal entity from the From field.
  "Chamberlain Group LLC" → "Chamberlain"
  "Amazon.com" → "Amazon"
  "The Home Depot, Inc." → "Home Depot"

Output JSON only: {"category":"...","company":"short brand name — omit if personal","confidence":0.0-1.0}`;
  }

  private parseSingle(response: string): EmailClassification {
    const json = response.match(/\{[\s\S]*?\}/)?.[0];
    if (json) {
      try {
        const p = JSON.parse(json);
        if (p.category) {
          return {
            category: p.category.toLowerCase(),
            companyName: p.company ?? p.companyName,
            confidence: p.confidence ?? 0.8,
            reasoning: '',
          };
        }
      } catch { /* fall through */ }
    }
    // Regex fallback
    const category = response.match(/"category"\s*:\s*"(marketing|transactional|personal)"/)?.[1];
    if (category) {
      return {
        category: category as EmailClassification['category'],
        companyName: response.match(/"company(?:Name)?"\s*:\s*"([^"]+)"/)?.[1],
        confidence: parseFloat(response.match(/"confidence"\s*:\s*([\d.]+)/)?.[1] ?? '0.8'),
        reasoning: '',
      };
    }
    throw new Error(`Classification parse failed: ${response.slice(0, 200)}`);
  }

  private parseBatch(response: string, emails: EmailData[]): Map<string, EmailClassification> {
    const results = new Map<string, EmailClassification>();

    // Strip markdown fences
    const cleaned = response.replace(/```(?:json)?/g, '').replace(/```/g, '').trim();

    // Find the JSON array
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      throw new Error(`No JSON array in batch response: ${response.slice(0, 300)}`);
    }

    let parsed: Array<{ i: number; category: string; company?: string; confidence?: number }>;
    try {
      parsed = JSON.parse(arrayMatch[0]);
    } catch {
      throw new Error(`JSON parse failed for batch: ${arrayMatch[0].slice(0, 300)}`);
    }

    for (const entry of parsed) {
      const idx = (entry.i ?? 0) - 1;
      const email = emails[idx];
      if (!email) continue;

      const category = entry.category as EmailClassification['category'];
      if (!['marketing', 'transactional', 'personal'].includes(category)) continue;

      results.set(email.id, {
        category,
        companyName: entry.company || undefined,
        confidence: entry.confidence ?? 0.8,
        reasoning: '',
      });
    }

    // Fill in any emails the model skipped with a fallback
    for (let i = 0; i < emails.length; i++) {
      if (!results.has(emails[i].id)) {
        console.error(`Model skipped email at index ${i + 1}, using fallback`);
        results.set(emails[i].id, {
          category: 'marketing',
          companyName: 'Unknown',
          confidence: 0.5,
          reasoning: 'skipped by model',
        });
      }
    }

    return results;
  }
}
