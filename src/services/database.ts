import Database from 'better-sqlite3';
import { Deal, EmailRecord } from '../types.js';
import { config } from '../config.js';

export class DatabaseService {
  db: Database.Database;

  constructor() {
    this.db = new Database(config.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS emails (
        id TEXT PRIMARY KEY,
        thread_id TEXT,
        subject TEXT,
        from_address TEXT,
        date_raw TEXT,
        date_ts INTEGER,
        year INTEGER,
        month INTEGER,
        category TEXT,
        company_name TEXT,
        confidence REAL,
        snippet TEXT,
        archived INTEGER DEFAULT 0,
        processed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS deals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email_id TEXT NOT NULL REFERENCES emails(id),
        company_name TEXT NOT NULL,
        discount_type TEXT NOT NULL,
        discount_value REAL,
        description TEXT NOT NULL,
        novelty_score REAL NOT NULL,
        extracted_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_emails_category ON emails(category);
      CREATE INDEX IF NOT EXISTS idx_emails_year_month ON emails(year, month);
      CREATE INDEX IF NOT EXISTS idx_emails_company ON emails(company_name);
      CREATE INDEX IF NOT EXISTS idx_emails_sender ON emails(from_address);
      CREATE INDEX IF NOT EXISTS idx_deals_company ON deals(company_name);
    `);
  }

  // --- Key/value metadata (e.g. last-sent timestamps for once-daily gating) ---

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  getEmailState(emailId: string): { skip: boolean; needsGmailArchive: boolean; category: string; companyName: string | null } | null {
    const row = this.db.prepare('SELECT archived, category, company_name FROM emails WHERE id = ?').get(emailId) as
      | { archived: number; category: string; company_name: string | null }
      | undefined;
    if (!row) return null;
    const skip = row.archived === 1 || row.category === 'personal';
    // Needs archiving in Gmail if it was classified as non-personal but archived=1 in DB
    // (dry-run leftovers that never got moved in Gmail)
    const needsGmailArchive = row.archived === 1 && row.category !== 'personal';
    return { skip, needsGmailArchive, category: row.category, companyName: row.company_name };
  }

  shouldSkip(emailId: string): boolean {
    return this.getEmailState(emailId)?.skip ?? false;
  }

  saveEmail(record: EmailRecord): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO emails
        (id, thread_id, subject, from_address, date_raw, date_ts, year, month,
         category, company_name, confidence, snippet, archived, processed_at)
      VALUES
        (@id, @threadId, @subject, @fromAddress, @dateRaw, @dateTs, @year, @month,
         @category, @companyName, @confidence, @snippet, @archived, @processedAt)
    `).run(record);
  }

  saveDeal(deal: Deal): void {
    this.db.prepare(`
      INSERT INTO deals
        (email_id, company_name, discount_type, discount_value, description, novelty_score, extracted_at)
      VALUES
        (@emailId, @companyName, @discountType, @discountValue, @description, @noveltyScore, @extractedAt)
    `).run(deal);
  }

  getCompanyDeals(companyName: string, limit: number = 50): Deal[] {
    return this.db.prepare(`
      SELECT * FROM deals WHERE company_name = ? ORDER BY extracted_at DESC LIMIT ?
    `).all(companyName, limit) as Deal[];
  }

  getProcessedCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM emails').get() as { count: number };
    return row.count;
  }

  // --- Stats queries ---

  getCountByYearMonth(): Array<{ year: number; month: number; category: string; count: number }> {
    return this.db.prepare(`
      SELECT year, month, category, COUNT(*) as count
      FROM emails
      GROUP BY year, month, category
      ORDER BY year, month
    `).all() as Array<{ year: number; month: number; category: string; count: number }>;
  }

  getTopSenders(category: string, limit: number = 20): Array<{ from_address: string; count: number }> {
    return this.db.prepare(`
      SELECT from_address, COUNT(*) as count
      FROM emails
      WHERE category = ?
      GROUP BY from_address
      ORDER BY count DESC
      LIMIT ?
    `).all(category, limit) as Array<{ from_address: string; count: number }>;
  }

  getCategoryTotals(): Array<{ category: string; count: number }> {
    return this.db.prepare(`
      SELECT category, COUNT(*) as count
      FROM emails
      GROUP BY category
      ORDER BY count DESC
    `).all() as Array<{ category: string; count: number }>;
  }

  // Companies that always send the same deal (lowest avg novelty = most repetitive)
  getRepetitivePromoters(limit: number = 15): Array<{ company_name: string; deal_count: number; avg_novelty: number; typical_offer: string }> {
    return this.db.prepare(`
      SELECT
        company_name,
        COUNT(*) as deal_count,
        ROUND(AVG(novelty_score), 2) as avg_novelty,
        (SELECT description FROM deals d2
         WHERE d2.company_name = d.company_name
         GROUP BY description ORDER BY COUNT(*) DESC LIMIT 1) as typical_offer
      FROM deals d
      GROUP BY company_name
      HAVING deal_count >= 3
      ORDER BY avg_novelty ASC
      LIMIT ?
    `).all(limit) as Array<{ company_name: string; deal_count: number; avg_novelty: number; typical_offer: string }>;
  }

  getTopDeals(limit: number = 10): Array<{ company_name: string; description: string; novelty_score: number; email_subject: string; date_raw: string }> {
    return this.db.prepare(`
      SELECT d.company_name, d.description, d.novelty_score, e.subject as email_subject, e.date_raw
      FROM deals d
      JOIN emails e ON d.email_id = e.id
      ORDER BY d.novelty_score DESC, d.discount_value DESC
      LIMIT ?
    `).all(limit) as Array<{ company_name: string; description: string; novelty_score: number; email_subject: string; date_raw: string }>;
  }

  getDealsExtractedSince(since: string): Array<{ company_name: string; discount_type: string; discount_value: number | null; description: string; email_subject: string }> {
    return this.db.prepare(`
      SELECT d.company_name, d.discount_type, d.discount_value, d.description, e.subject as email_subject
      FROM deals d
      JOIN emails e ON d.email_id = e.id
      WHERE d.extracted_at >= ?
      ORDER BY
        CASE d.discount_type WHEN 'percentage' THEN COALESCE(d.discount_value, 0) ELSE 0 END DESC,
        CASE d.discount_type WHEN 'flat' THEN COALESCE(d.discount_value, 0) ELSE 0 END DESC
    `).all(since) as Array<{ company_name: string; discount_type: string; discount_value: number | null; description: string; email_subject: string }>;
  }

  getRecentDealHistory(before: string, days: number): Array<{ company_name: string; description: string }> {
    return this.db.prepare(`
      SELECT d.company_name, d.description
      FROM deals d
      WHERE d.extracted_at < ?
        AND d.extracted_at >= datetime(?, '-${days} days')
    `).all(before, before) as Array<{ company_name: string; description: string }>;
  }

  getDistinctCompanyNames(): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT company_name FROM (
        SELECT company_name FROM emails
          WHERE company_name IS NOT NULL AND company_name != '' AND category != 'personal'
        UNION ALL
        SELECT company_name FROM deals
          WHERE company_name IS NOT NULL AND company_name != ''
      ) ORDER BY company_name
    `).all() as Array<{ company_name: string }>;
    return rows.map(r => r.company_name);
  }

  updateCompanyName(oldName: string, newName: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE emails SET company_name = ? WHERE company_name = ?').run(newName, oldName);
      this.db.prepare('UPDATE deals  SET company_name = ? WHERE company_name = ?').run(newName, oldName);
    });
    tx();
  }

  // --- Classification validation ---

  // Marketing emails processed since `since` that came from senders whose overall
  // history skews transactional — the "buried transactional" failure mode.
  // The model tends to bury these confidently, so this uses sender reputation, not confidence.
  getBuriedTransactionalCandidates(
    since: string,
    minTxnPct: number = 60,
    minSenderTotal: number = 5
  ): Array<{ from_address: string; subject: string; company_name: string | null; sender_txn_pct: number; sender_total: number; confidence: number }> {
    return this.db.prepare(`
      WITH sender_profile AS (
        SELECT from_address,
               COUNT(*) AS total,
               ROUND(100.0 * SUM(CASE WHEN category = 'transactional' THEN 1 ELSE 0 END) / COUNT(*)) AS txn_pct
        FROM emails
        GROUP BY from_address
      )
      SELECT e.from_address, e.subject, e.company_name,
             sp.txn_pct AS sender_txn_pct, sp.total AS sender_total, e.confidence
      FROM emails e
      JOIN sender_profile sp ON e.from_address = sp.from_address
      WHERE e.processed_at >= ?
        AND e.category = 'marketing'
        AND sp.txn_pct >= ?
        AND sp.total >= ?
      ORDER BY sp.txn_pct DESC, sp.total DESC
    `).all(since, minTxnPct, minSenderTotal) as Array<{ from_address: string; subject: string; company_name: string | null; sender_txn_pct: number; sender_total: number; confidence: number }>;
  }

  // One-line health summary for emails processed since `since`.
  getClassificationHealthSince(since: string): {
    byCategory: Array<{ category: string; count: number }>;
    total: number;
    archived: number;
    newSenders: number;
  } {
    const byCategory = this.db.prepare(`
      SELECT category, COUNT(*) AS count
      FROM emails WHERE processed_at >= ?
      GROUP BY category ORDER BY count DESC
    `).all(since) as Array<{ category: string; count: number }>;

    const totals = this.db.prepare(`
      SELECT COUNT(*) AS total, SUM(archived) AS archived
      FROM emails WHERE processed_at >= ?
    `).get(since) as { total: number; archived: number | null };

    const newSenders = this.db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT from_address FROM emails
        GROUP BY from_address
        HAVING MIN(processed_at) >= ?
      )
    `).get(since) as { n: number };

    return {
      byCategory,
      total: totals.total,
      archived: totals.archived ?? 0,
      newSenders: newSenders.n,
    };
  }

  // Who sent you mail since `since`, grouped by category then volume.
  // company_name is null for most personal mail (and some transactional), so we
  // fall back to the sender address. Category case is inconsistent in older rows
  // ("Transactional" vs "transactional"), so it's normalized here.
  getCompanyBreakdownSince(since: string): Array<{ category: string; company: string; count: number }> {
    return this.db.prepare(`
      SELECT LOWER(category) AS category,
             COALESCE(NULLIF(TRIM(company_name), ''), from_address) AS company,
             COUNT(*) AS count
      FROM emails
      WHERE processed_at >= ?
      GROUP BY LOWER(category), company
      ORDER BY category ASC, count DESC, company ASC
    `).all(since) as Array<{ category: string; company: string; count: number }>;
  }

  close(): void {
    this.db.close();
  }
}
