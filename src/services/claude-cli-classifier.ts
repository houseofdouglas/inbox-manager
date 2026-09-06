import { execSync } from 'child_process';
import { EmailClassification, EmailData } from '../types.js';

export class ClaudeCliClassifier {
  async classify(email: EmailData): Promise<EmailClassification> {
    const prompt = this.buildPrompt(email);
    const text = await this.callClaude(prompt);
    return this.parse(text);
  }

  async classifyBatch(emails: EmailData[]): Promise<Map<string, EmailClassification>> {
    const results = new Map<string, EmailClassification>();
    // claude -p is already fast; process 3 in parallel
    const concurrency = 3;
    for (let i = 0; i < emails.length; i += concurrency) {
      const batch = emails.slice(i, i + concurrency);
      const settled = await Promise.allSettled(
        batch.map(email => this.classify(email))
      );
      settled.forEach((outcome, idx) => {
        if (outcome.status === 'fulfilled') {
          results.set(batch[idx].id, outcome.value);
        }
      });
    }
    return results;
  }

  private async callClaude(prompt: string): Promise<string> {
    const result = execSync('claude -p', {
      input: prompt,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    return result.toString().trim();
  }

  private buildPrompt(email: EmailData): string {
    const content = email.body
      ? `Body:\n${email.body.slice(0, 4000)}`
      : `Preview: ${email.snippet}`;
    return `Classify this email. Categories: marketing, transactional, personal.

From: ${email.from}
Subject: ${email.subject}
${content}

Output JSON only — no markdown, no explanation:
{"category":"marketing|transactional|personal","company":"brand name (omit if personal)","confidence":0.0-1.0}`;
  }

  private parse(response: string): EmailClassification {
    // Strip markdown fences if present
    const cleaned = response.replace(/```(?:json)?/g, '').replace(/```/g, '').trim();
    const json = cleaned.match(/\{[\s\S]*?\}/)?.[0];
    if (json) {
      try {
        const p = JSON.parse(json);
        if (p.category) {
          return {
            category: p.category,
            companyName: p.company || p.companyName || undefined,
            confidence: p.confidence ?? 0.9,
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
        confidence: parseFloat(response.match(/"confidence"\s*:\s*([\d.]+)/)?.[1] ?? '0.9'),
        reasoning: '',
      };
    }
    throw new Error(`Claude CLI parse failed: ${response.slice(0, 200)}`);
  }
}
