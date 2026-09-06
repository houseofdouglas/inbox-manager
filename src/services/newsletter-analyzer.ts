import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config.js';
import { NewsletterAnalysis, NewsletterEmail } from '../types.js';

const READER_INTERESTS = `
- Technology, AI, software development, programming tools, and tech industry news
- Business strategy, finance, markets, investments, startups, and entrepreneurship
- Industry news relevant to professional development and staying current in your field
- Time-sensitive deals, offers, or discounts that are genuinely worth acting on
`.trim();

export class NewsletterAnalyzer {
  private client: GoogleGenerativeAI;

  constructor() {
    this.client = new GoogleGenerativeAI(config.geminiApiKey);
  }

  async analyze(email: NewsletterEmail): Promise<NewsletterAnalysis> {
    const model = this.client.getGenerativeModel({ model: config.geminiModel });

    const prompt = `You are reviewing a newsletter email to help a busy professional decide if it is worth reading.

The reader cares about:
${READER_INTERESTS}

Newsletter:
From: ${email.from}
Subject: ${email.subject}
Date: ${email.date}
Content:
${email.body.slice(0, 6000)}

Analyze this newsletter and respond ONLY with this exact JSON (no markdown fences):
{
  "isInteresting": true or false,
  "interestScore": 0 to 10,
  "relevantTopics": ["topic1"],
  "keyPoints": ["point1", "point2"],
  "actionItems": ["action1"],
  "summary": "1-2 sentence summary of the newsletter content",
  "reason": "brief reason for the interest score"
}

Rules:
- isInteresting: true if interestScore >= 5
- keyPoints: max 3 genuinely valuable insights; empty array if none
- actionItems: things the reader should do or follow up on; max 2; empty if none
- Keep all text concise`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    return this.parse(text);
  }

  private parse(response: string): NewsletterAnalysis {
    // Strip markdown fences if present
    const cleaned = response
      .replace(/^```(?:json)?\s*/m, '')
      .replace(/\s*```$/m, '')
      .trim();

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`No JSON in analyzer response: ${response.slice(0, 200)}`);

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      isInteresting: parsed.isInteresting ?? false,
      interestScore: parsed.interestScore ?? 0,
      relevantTopics: parsed.relevantTopics ?? [],
      keyPoints: parsed.keyPoints ?? [],
      actionItems: parsed.actionItems ?? [],
      summary: parsed.summary ?? '',
      reason: parsed.reason ?? '',
    };
  }
}
