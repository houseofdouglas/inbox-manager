import fs from 'fs';
import path from 'path';

interface NewsletterState {
  // The oldest historical day processed so far (walks backward over time)
  oldestProcessedDate: string | null; // YYYY-MM-DD
}

const STATE_FILE = path.join(process.cwd(), 'newsletter-state.json');

export function toDateStr(d: Date): string {
  return d.toISOString().split('T')[0];
}

export function fromDateStr(s: string): Date {
  return new Date(s + 'T00:00:00Z');
}

export class NewsletterStateService {
  private state: NewsletterState;

  constructor() {
    this.state = this.load();
  }

  private load(): NewsletterState {
    if (fs.existsSync(STATE_FILE)) {
      try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      } catch {
        // ignore corrupt state
      }
    }
    return { oldestProcessedDate: null };
  }

  private save(): void {
    fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
  }

  /**
   * Always returns: last 24 hours (today's window).
   * This is processed on every run, no state needed.
   */
  getRecentWindow(): { startDate: Date; endDate: Date } {
    const endDate = new Date();
    endDate.setUTCHours(0, 0, 0, 0);
    const startDate = new Date(endDate);
    startDate.setUTCDate(startDate.getUTCDate() - 1);
    return { startDate, endDate };
  }

  /**
   * Returns the next historical day to process (walking backward).
   * First call: the day before yesterday (since yesterday is covered by getRecentWindow).
   * Each subsequent call: one more day back.
   */
  getHistoricalWindow(): { startDate: Date; endDate: Date; label: string } {
    let endDate: Date;

    if (!this.state.oldestProcessedDate) {
      // Haven't started yet — start just before the recent window
      const recent = this.getRecentWindow();
      endDate = recent.startDate; // = yesterday
    } else {
      endDate = fromDateStr(this.state.oldestProcessedDate);
    }

    const startDate = new Date(endDate);
    startDate.setUTCDate(startDate.getUTCDate() - 1);

    return { startDate, endDate, label: toDateStr(startDate) };
  }

  markHistoricalProcessed(startDate: Date): void {
    this.state.oldestProcessedDate = toDateStr(startDate);
    this.save();
  }

  getStatus(): string {
    if (!this.state.oldestProcessedDate) return 'historical: not yet started';
    const recent = this.getRecentWindow();
    return `historical coverage back to ${this.state.oldestProcessedDate} (today = ${toDateStr(recent.endDate)})`;
  }
}
