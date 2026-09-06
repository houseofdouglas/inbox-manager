import { GoogleGenerativeAI } from '@google/generative-ai';
import { EmailClassification, EmailData } from '../types.js';

export class GeminiClassifier {
  private client: GoogleGenerativeAI;
  private model: string;

  constructor(apiKey: string, model: string = 'gemini-2.0-flash-exp') {
    this.client = new GoogleGenerativeAI(apiKey);
    this.model = model;
  }

  async classify(email: EmailData): Promise<EmailClassification> {
    const prompt = this.buildClassificationPrompt(email);

    const model = this.client.getGenerativeModel({ model: this.model });
    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text();

    const classification = this.parseClassification(text);

    // Add usage metadata if available
    if (response.usageMetadata) {
      classification.usage = {
        inputTokens: response.usageMetadata.promptTokenCount || 0,
        outputTokens: response.usageMetadata.candidatesTokenCount || 0,
        totalTokens: response.usageMetadata.totalTokenCount || 0
      };
    }

    return classification;
  }

  private buildClassificationPrompt(email: EmailData): string {
    return `Classify this email into one of three categories: marketing, transactional, or personal.

Email Details:
From: ${email.from}
Subject: ${email.subject}
Preview: ${email.snippet}
Date: ${email.date}

Categories:
- marketing: Promotional emails, newsletters, advertisements from companies
- transactional: Receipts, order confirmations, shipping notifications, password resets, account notifications
- personal: Emails from real people (friends, family, colleagues) with personal communication

If it's from a company (marketing or transactional), identify the company name. Use the short canonical brand name only — no legal suffixes, no domain extensions, no descriptors (e.g. "Amazon" not "Amazon.com", "Subway" not "SUBWAY Restaurants", "Home Depot" not "The Home Depot"). Use title case.

IMPORTANT: In the reasoning field, use single quotes (') instead of double quotes (") when quoting text to ensure valid JSON.

Respond in this exact JSON format:
{
  "category": "marketing" | "transactional" | "personal",
  "companyName": "string (only for marketing/transactional, omit for personal)",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}`;
  }

  private repairJson(jsonString: string): string {
    // Attempt to fix common JSON issues in the reasoning field
    // 1. Remove invalid escape sequences like \' (JSON doesn't support this)
    // 2. Fix unescaped double quotes

    // First, fix invalid escape sequences globally
    const repaired = jsonString
      // Remove backslash before single quotes (invalid in JSON)
      .replace(/\\'/g, "'");

    // Then fix quotes in the reasoning field specifically
    const lines = repaired.split('\n');
    const repairedLines = lines.map(line => {
      // Only process lines that look like the "reasoning" field
      if (line.includes('"reasoning"')) {
        // Find the value part after "reasoning":
        const match = line.match(/"reasoning"\s*:\s*"(.*)"/);
        if (match) {
          const value = match[1];
          // Replace unescaped quotes (not preceded by backslash) with escaped quotes
          const fixed = value.replace(/(?<!\\)"/g, '\\"');
          return line.replace(value, fixed);
        }
      }
      return line;
    });

    return repairedLines.join('\n');
  }

  private parseClassification(response: string): EmailClassification {
    try {
      let jsonString = '';

      // First, try to extract from markdown code fences
      const markdownMatch = response.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
      if (markdownMatch) {
        jsonString = markdownMatch[1];
      } else {
        // Fall back to extracting JSON object directly (non-greedy)
        const jsonMatch = response.match(/\{[\s\S]*?\}/);
        if (!jsonMatch) {
          throw new Error('No JSON found in response');
        }
        jsonString = jsonMatch[0];
      }

      // Try to parse as-is first
      let parsed;
      try {
        parsed = JSON.parse(jsonString);
      } catch {
        // Attempt to repair and parse again
        const repairedJson = this.repairJson(jsonString);
        parsed = JSON.parse(repairedJson);
      }

      return {
        category: parsed.category,
        companyName: parsed.companyName,
        confidence: parsed.confidence,
        reasoning: parsed.reasoning
      };
    } catch (error) {
      console.error('Failed to parse classification response:', response);
      throw new Error(`Classification parsing failed: ${error}`);
    }
  }

  async classifyBatch(emails: EmailData[]): Promise<Map<string, EmailClassification>> {
    const results = new Map<string, EmailClassification>();

    // Process in parallel with concurrency limit
    const concurrency = 5;
    for (let i = 0; i < emails.length; i += concurrency) {
      const batch = emails.slice(i, i + concurrency);
      const classifications = await Promise.all(
        batch.map(async (email) => {
          try {
            const classification = await this.classify(email);
            return { id: email.id, classification };
          } catch (error) {
            console.error(`Error classifying email ${email.id}:`, error);
            return null;
          }
        })
      );

      classifications.forEach((result) => {
        if (result) {
          results.set(result.id, result.classification);
        }
      });

      // Small delay to avoid rate limiting
      if (i + concurrency < emails.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    return results;
  }
}
