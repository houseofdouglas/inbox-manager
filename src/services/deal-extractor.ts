import { Deal, DealExtraction } from '../types.js';
import { DatabaseService } from './database.js';

type CompletionFn = (prompt: string) => Promise<string>;

export class DealExtractor {
  constructor(
    private complete: CompletionFn,
    private db: DatabaseService,
  ) {}

  async extract(emailId: string, companyName: string, subject: string, body: string): Promise<Deal | null> {
    const extraction = await this.callAI(subject, body);
    if (!extraction.hasOffer || !extraction.description) return null;

    const history = this.db.getCompanyDeals(companyName);
    const noveltyScore = this.calculateNovelty(extraction, history);

    return {
      emailId,
      companyName,
      discountType: extraction.discountType ?? 'other',
      discountValue: extraction.discountValue ?? null,
      description: extraction.description,
      noveltyScore,
      extractedAt: new Date().toISOString(),
    };
  }

  private async callAI(subject: string, body: string): Promise<DealExtraction> {
    const prompt = `Analyze this marketing email and extract any promotional offer or discount.

Subject: ${subject}
Body (first 2000 chars): ${body.slice(0, 2000)}

If there is a specific offer, extract it. If it's just a generic promotional email with no specific deal, say hasOffer: false.

Respond in this exact JSON format:
{
  "hasOffer": true | false,
  "discountType": "percentage" | "flat" | "free_shipping" | "bogo" | "trial" | "other",
  "discountValue": number or null (e.g. 20 for "20% off", 5 for "$5 off", null if not numeric),
  "description": "concise description e.g. '20% off sitewide' or '2 for 1 on shoes'"
}

If hasOffer is false, omit the other fields.`;

    const response = await this.complete(prompt);
    return this.parse(response);
  }

  private parse(response: string): DealExtraction {
    try {
      const match = response.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) ||
                    response.match(/(\{[\s\S]*?\})/);
      if (!match) return { hasOffer: false };
      const parsed = JSON.parse(match[1]);
      return {
        hasOffer: !!parsed.hasOffer,
        discountType: parsed.discountType,
        discountValue: typeof parsed.discountValue === 'number' ? parsed.discountValue : undefined,
        description: parsed.description,
      };
    } catch {
      return { hasOffer: false };
    }
  }

  private calculateNovelty(current: DealExtraction, history: Deal[]): number {
    if (history.length === 0) return 1.0;

    const sameType = history.filter(d => d.discountType === current.discountType);
    if (sameType.length === 0) return 0.9; // new type of offer for this company

    // For percentage discounts, compare value against history
    if (current.discountType === 'percentage' && current.discountValue != null) {
      const values = sameType
        .map(d => d.discountValue)
        .filter((v): v is number => v != null);

      if (values.length === 0) return 0.5;

      const maxHistorical = Math.max(...values);
      const avgHistorical = values.reduce((a, b) => a + b, 0) / values.length;

      if (current.discountValue > maxHistorical) return 0.85; // best deal ever from them
      if (current.discountValue > avgHistorical * 1.2) return 0.6; // better than usual
      if (current.discountValue >= avgHistorical * 0.9) return 0.15; // same as usual
      return 0.05; // worse than their average
    }

    // For flat discounts, same logic
    if (current.discountType === 'flat' && current.discountValue != null) {
      const values = sameType
        .map(d => d.discountValue)
        .filter((v): v is number => v != null);

      if (values.length > 0) {
        const max = Math.max(...values);
        if (current.discountValue > max) return 0.8;
        if (current.discountValue >= max * 0.9) return 0.15;
        return 0.05;
      }
    }

    // For non-numeric types (free shipping, bogo, trial) — seen it before = low novelty
    const frequency = sameType.length / history.length;
    if (frequency > 0.5) return 0.1; // they do this all the time
    if (frequency > 0.2) return 0.3;
    return 0.5;
  }
}
