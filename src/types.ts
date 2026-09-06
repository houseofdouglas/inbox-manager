export type EmailCategory = 'marketing' | 'transactional' | 'personal';

export type AIProvider = 'claude' | 'gemini' | 'llama' | 'claude-cli';

export type ClaudeModel = 'opus' | 'sonnet' | 'haiku';

export type GeminiModel = 'gemini-2.5-flash' | 'gemini-2.5-flash-lite' | 'gemini-2.0-flash-exp' | 'gemini-1.5-flash' | 'gemini-1.5-pro';

export interface UsageMetadata {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface EmailClassification {
  category: EmailCategory;
  companyName?: string;
  confidence: number;
  reasoning: string;
  usage?: UsageMetadata;
}

export interface EmailData {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  snippet: string;
  date: string;
  labels: string[];
  body?: string;
}

export interface NewsletterEmail extends EmailData {
  body: string;
  unsubscribeLink?: string;
}

export interface NewsletterAnalysis {
  isInteresting: boolean;
  interestScore: number; // 0-10
  relevantTopics: string[];
  keyPoints: string[];
  actionItems: string[];
  summary: string;
  reason: string;
}

export interface NewsletterResult {
  email: NewsletterEmail;
  analysis: NewsletterAnalysis;
}

export interface DealExtraction {
  hasOffer: boolean;
  discountType?: 'percentage' | 'flat' | 'free_shipping' | 'bogo' | 'trial' | 'other';
  discountValue?: number;
  description?: string;
}

export interface Deal {
  id?: number;
  emailId: string;
  companyName: string;
  discountType: string;
  discountValue: number | null;
  description: string;
  noveltyScore: number;
  extractedAt: string;
}

export interface EmailRecord {
  id: string;
  threadId: string;
  subject: string;
  fromAddress: string;
  dateRaw: string;
  dateTs: number;
  year: number;
  month: number;
  category: string;
  companyName: string | null;
  confidence: number;
  snippet: string;
  archived: number;
  processedAt: string;
}

export interface ProcessingResult {
  processed: number;
  skipped: number;
  errors: number;
  details: {
    marketing: number;
    transactional: number;
    personal: number;
  };
}
