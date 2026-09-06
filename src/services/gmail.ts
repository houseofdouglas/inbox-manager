import { gmail_v1 } from 'googleapis';
import { EmailData, EmailClassification, NewsletterEmail } from '../types.js';
import { getGmailClient } from './gmail-auth.js';

export class GmailService {
  private gmail: gmail_v1.Gmail | null = null;
  private authedAddress: string | null = null;

  async initialize() {
    this.gmail = await getGmailClient();
  }

  // The address of the account token.json authorized. Used as the default
  // recipient for digests and failure alerts, so no address is compiled in.
  async getAuthenticatedAddress(): Promise<string> {
    if (this.authedAddress) return this.authedAddress;
    const gmail = this.ensureInitialized();
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const address = profile.data.emailAddress;
    if (!address) {
      throw new Error('Gmail returned no email address for the authorized account.');
    }
    this.authedAddress = address;
    return address;
  }

  private ensureInitialized() {
    if (!this.gmail) {
      throw new Error('GmailService not initialized. Call initialize() first.');
    }
    return this.gmail;
  }

  extractSenderName(from: string): string {
    // "Display Name <email@domain.com>" → "Display Name"
    const match = from.match(/^"?([^"<]+)"?\s*</);
    if (match) return match[1].trim();
    // "email@domain.com" → "domain"
    const domain = from.match(/@([^.>]+)/);
    return domain ? domain[1] : 'Other';
  }

  private sanitizeLabelName(companyName: string): string {
    return companyName
      // Strip trademark/registered symbols
      .replace(/[®™©]/g, '')
      // Remove common business suffixes
      .replace(/,?\s*(Inc\.?|LLC|L\.L\.C\.?|Corp\.?|Co\.?|Ltd\.?)\s*$/i, '')
      // Strip domain suffixes like ".com", ".net"
      .replace(/\.(com|net|org|io|co)\b/gi, '')
      // Replace ampersand with 'and'
      .replace(/\s*&\s*/g, ' and ')
      // Remove other problematic characters but keep spaces and hyphens
      .replace(/[^\w\s\-]/g, '')
      // Collapse multiple spaces
      .replace(/\s+/g, ' ')
      // Trim
      .trim();
  }

  async getMarketingLabels(): Promise<Array<{ id: string; name: string; companyName: string }>> {
    const gmail = this.ensureInitialized();
    const response = await gmail.users.labels.list({ userId: 'me' });
    return (response.data.labels || [])
      .filter(l => l.name?.startsWith('marketing/') && l.id)
      .map(l => ({
        id: l.id!,
        name: l.name!,
        companyName: l.name!.replace('marketing/', ''),
      }));
  }

  // extraLabelIds intersects rather than unions — passing ['UNREAD'] returns
  // only the unread messages carrying labelId.
  async listLabelMessageIds(labelId: string, extraLabelIds: string[] = []): Promise<string[]> {
    const gmail = this.ensureInitialized();
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const res = await gmail.users.messages.list({
        userId: 'me',
        labelIds: [labelId, ...extraLabelIds],
        maxResults: 500,
        pageToken,
      });
      ids.push(...(res.data.messages || []).map(m => m.id!).filter(Boolean));
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return ids;
  }

  async batchModifyMessages(ids: string[], addLabelIds: string[], removeLabelIds: string[]): Promise<void> {
    const gmail = this.ensureInitialized();
    // Gmail batchModify supports up to 1000 messages per call
    for (let i = 0; i < ids.length; i += 1000) {
      await gmail.users.messages.batchModify({
        userId: 'me',
        requestBody: {
          ids: ids.slice(i, i + 1000),
          addLabelIds,
          removeLabelIds,
        },
      });
    }
  }

  async deleteLabel(labelId: string): Promise<void> {
    const gmail = this.ensureInitialized();
    await gmail.users.labels.delete({ userId: 'me', id: labelId });
  }

  async migrateMarketingLabels(dryRun: boolean = false): Promise<void> {
    const gmail = this.ensureInitialized();

    const response = await gmail.users.labels.list({ userId: 'me' });
    const labels = response.data.labels || [];
    // marketing/ only. The legacy transactional/<sender> labels are deliberately
    // set to labelHide — transactional mail is kept unread, so labelShowIfUnread
    // would put all ~1600 of them back in the sidebar.
    const toUpdate = labels.filter(l => l.name?.startsWith('marketing/'));

    console.log(`Found ${toUpdate.length} labels to update (marketing/).`);

    for (const label of toUpdate) {
      if (!label.id) continue;
      if (dryRun) {
        console.log(`[DRY RUN] Would update: ${label.name}`);
        continue;
      }
      await gmail.users.labels.patch({
        userId: 'me',
        id: label.id,
        requestBody: { labelListVisibility: 'labelShowIfUnread' },
      });
      console.log(`✓ ${label.name}`);
    }
  }

  async getInboxEmails(maxResults: number = 100): Promise<EmailData[]> {
    const gmail = this.ensureInitialized();

    const response = await gmail.users.messages.list({
      userId: 'me',
      labelIds: ['INBOX'],
      maxResults,
    });

    const messages = response.data.messages || [];
    const emails: EmailData[] = [];

    for (const message of messages) {
      if (!message.id) continue;

      try {
        const email = await this.getEmailById(message.id);
        emails.push(email);
      } catch (error) {
        console.error(`Error fetching email ${message.id}:`, error);
      }
    }

    return emails;
  }

  async getInboxPage(
    pageSize: number = 100,
    pageToken?: string
  ): Promise<{ ids: string[]; nextPageToken?: string; totalEstimate: number }> {
    const gmail = this.ensureInitialized();

    const response = await gmail.users.messages.list({
      userId: 'me',
      labelIds: ['INBOX'],
      maxResults: pageSize,
      pageToken,
    });

    return {
      ids: (response.data.messages || []).map(m => m.id!).filter(Boolean),
      nextPageToken: response.data.nextPageToken ?? undefined,
      totalEstimate: response.data.resultSizeEstimate || 0,
    };
  }

  async getEmailWithBody(id: string): Promise<{ email: EmailData; body: string }> {
    const gmail = this.ensureInitialized();

    const response = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'full',
    });

    const message = response.data;
    const headers = message.payload?.headers || [];
    const getHeader = (name: string) =>
      headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

    const body = this.extractBody(message.payload);
    return {
      email: {
        id: message.id!,
        threadId: message.threadId!,
        subject: getHeader('Subject'),
        from: getHeader('From'),
        snippet: message.snippet || '',
        date: getHeader('Date'),
        labels: message.labelIds || [],
        body,
      },
      body,
    };
  }

  async getEmailById(id: string): Promise<EmailData> {
    const gmail = this.ensureInitialized();

    const response = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date'],
    });

    const message = response.data;
    const headers = message.payload?.headers || [];

    const getHeader = (name: string) =>
      headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

    return {
      id: message.id!,
      threadId: message.threadId!,
      subject: getHeader('Subject'),
      from: getHeader('From'),
      snippet: message.snippet || '',
      date: getHeader('Date'),
      labels: message.labelIds || [],
    };
  }

  // name -> id. Without this, every ensureLabel call costs a full labels.list,
  // which is once per organized email.
  private labelCache: Map<string, string> | null = null;
  // Gmail compares label names case-insensitively when deciding whether one
  // already exists, so an exact-match cache is not enough: asking for
  // "marketing/AKAI" when "marketing/Akai" exists misses the cache, fails to
  // create, and then misses again on refresh. This index keeps the lookup in
  // step with Gmail's own uniqueness rule.
  private labelCacheLower: Map<string, string> | null = null;

  private async loadLabelCache(): Promise<Map<string, string>> {
    const gmail = this.ensureInitialized();
    const labelsResponse = await gmail.users.labels.list({ userId: 'me' });
    const cache = new Map<string, string>();
    const lower = new Map<string, string>();
    for (const l of labelsResponse.data.labels ?? []) {
      if (l.name && l.id) {
        cache.set(l.name, l.id);
        lower.set(l.name.toLowerCase(), l.id);
      }
    }
    this.labelCache = cache;
    this.labelCacheLower = lower;
    return cache;
  }

  async ensureLabel(labelName: string): Promise<string> {
    const gmail = this.ensureInitialized();

    const cache = this.labelCache ?? await this.loadLabelCache();
    const cached = cache.get(labelName) ?? this.labelCacheLower?.get(labelName.toLowerCase());
    if (cached) return cached;

    try {
      const createResponse = await gmail.users.labels.create({
        userId: 'me',
        requestBody: {
          name: labelName,
          labelListVisibility: 'labelShowIfUnread',
          messageListVisibility: 'show',
        },
      });
      const id = createResponse.data.id!;
      cache.set(labelName, id);
      this.labelCacheLower?.set(labelName.toLowerCase(), id);
      return id;
    } catch (err) {
      // Either another process created it since the cache was built, or it
      // already exists under a different capitalisation — Gmail rejects both
      // with "Label name exists or conflicts". Refresh and match case-
      // insensitively before giving up.
      await this.loadLabelCache();
      const id = this.labelCache?.get(labelName)
        ?? this.labelCacheLower?.get(labelName.toLowerCase());
      if (id) return id;
      throw err;
    }
  }

  // Single source of truth for how a classification maps to a Gmail label, so
  // organizeEmail and applyLabelOnly can never disagree about the target.
  private labelFor(
    classification: EmailClassification,
    fromAddress: string = ''
  ): { labelName: string; shouldMarkAsRead: boolean } {
    const companyName = classification.companyName
      || (fromAddress ? this.extractSenderName(fromAddress) : '');

    switch (classification.category) {
      case 'marketing':
        return {
          labelName: companyName
            ? `marketing/${this.sanitizeLabelName(companyName)}`
            : 'marketing/Other',
          shouldMarkAsRead: true,
        };
      case 'transactional':
        // Flat label by design: one bucket to review from. The sender is already
        // visible in Gmail's From column, and company_name is kept in inbox.db
        // for the digest, so per-sender sub-labels added sidebar clutter without
        // adding information.
        return { labelName: 'transactional', shouldMarkAsRead: false };
      default:
        return { labelName: 'personal', shouldMarkAsRead: false };
    }
  }

  // Adds the category label WITHOUT touching INBOX. Two callers:
  //  - personal mail, which is labelled but deliberately kept in the inbox and
  //    unread, so organizeEmail (which always strips INBOX) must not be used;
  //  - repairing mail that was archived but never labelled, where it is already
  //    out of the inbox and organizeEmail would wrongly pull it back through
  //    the INBOX removal it does not need.
  //
  // UNREAD is still honoured via labelFor: marketing is *always* marked read,
  // no matter which path applies its label. Leaving it unread here is what left
  // a batch of relabelled marketing mail sitting unread in the archive.
  async applyLabelOnly(
    emailId: string,
    classification: EmailClassification,
    dryRun: boolean = false,
    fromAddress: string = ''
  ): Promise<string> {
    const gmail = this.ensureInitialized();
    const { labelName, shouldMarkAsRead } = this.labelFor(classification, fromAddress);

    if (dryRun) return labelName;

    const labelId = await this.ensureLabel(labelName);
    await gmail.users.messages.modify({
      userId: 'me',
      id: emailId,
      requestBody: {
        addLabelIds: [labelId],
        removeLabelIds: shouldMarkAsRead ? ['UNREAD'] : [],
      },
    });
    return labelName;
  }

  // Paginates a Gmail search to completion and returns every matching id.
  async listMessageIdsByQuery(query: string): Promise<string[]> {
    const gmail = this.ensureInitialized();
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const res = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 500,
        pageToken,
      });
      for (const m of res.data.messages ?? []) {
        if (m.id) ids.push(m.id);
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return ids;
  }

  async organizeEmail(
    emailId: string,
    classification: EmailClassification,
    dryRun: boolean = false,
    fromAddress: string = ''
  ): Promise<void> {
    const gmail = this.ensureInitialized();

    const { labelName, shouldMarkAsRead } = this.labelFor(classification, fromAddress);

    if (dryRun) {
      console.log(`[DRY RUN] Would move email ${emailId} to ${labelName}${shouldMarkAsRead ? ' and mark as read' : ''}`);
      return;
    }

    // Ensure the label exists
    const labelId = await this.ensureLabel(labelName);

    // Prepare label modifications
    const addLabelIds = [labelId];
    const removeLabelIds = ['INBOX'];

    if (shouldMarkAsRead) {
      removeLabelIds.push('UNREAD');
    }

    // Modify the email
    await gmail.users.messages.modify({
      userId: 'me',
      id: emailId,
      requestBody: {
        addLabelIds,
        removeLabelIds,
      },
    });

    console.log(`✓ Organized email ${emailId} → ${labelName}${shouldMarkAsRead ? ' (marked as read)' : ''}`);
  }

  // Extract plain text body from a Gmail message payload
  private extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
    if (!payload) return '';

    // Helper to decode base64url
    const decode = (data: string) =>
      Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');

    // Recursively search parts for text/plain, then text/html
    const findPart = (part: gmail_v1.Schema$MessagePart, mimeType: string): string | null => {
      if (part.mimeType === mimeType && part.body?.data) {
        return decode(part.body.data);
      }
      for (const child of part.parts || []) {
        const result = findPart(child, mimeType);
        if (result) return result;
      }
      return null;
    };

    // Prefer plain text
    const plain = findPart(payload, 'text/plain');
    if (plain) return plain.slice(0, 8000);

    // Fall back to HTML stripped of tags
    const html = findPart(payload, 'text/html');
    if (html) {
      return html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, 8000);
    }

    return '';
  }

  async getNewsletterEmails(startDate: Date, endDate: Date, maxResults: number = 50): Promise<NewsletterEmail[]> {
    const gmail = this.ensureInitialized();

    // Gmail date format: YYYY/MM/DD
    const fmt = (d: Date) => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    const query = `after:${fmt(startDate)} before:${fmt(endDate)} has:list-unsubscribe`;

    const response = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults,
    });

    const messages = response.data.messages || [];
    const emails: NewsletterEmail[] = [];

    for (const message of messages) {
      if (!message.id) continue;
      try {
        const full = await gmail.users.messages.get({
          userId: 'me',
          id: message.id,
          format: 'full',
        });

        const msg = full.data;
        const headers = msg.payload?.headers || [];
        const getHeader = (name: string) =>
          headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

        // Extract unsubscribe link if present
        const unsubscribeHeader = getHeader('List-Unsubscribe');
        const linkMatch = unsubscribeHeader.match(/<(https?:[^>]+)>/);
        const unsubscribeLink = linkMatch ? linkMatch[1] : undefined;

        emails.push({
          id: msg.id!,
          threadId: msg.threadId!,
          subject: getHeader('Subject'),
          from: getHeader('From'),
          snippet: msg.snippet || '',
          date: getHeader('Date'),
          labels: msg.labelIds || [],
          body: this.extractBody(msg.payload),
          unsubscribeLink,
        });
      } catch (error) {
        console.error(`Error fetching newsletter ${message.id}:`, error);
      }
    }

    return emails;
  }

  async archiveEmail(emailId: string, dryRun: boolean = false): Promise<void> {
    const gmail = this.ensureInitialized();
    if (dryRun) {
      console.log(`[DRY RUN] Would archive email ${emailId}`);
      return;
    }
    await gmail.users.messages.modify({
      userId: 'me',
      id: emailId,
      requestBody: { removeLabelIds: ['INBOX'], addLabelIds: [] },
    });
  }

  async trashEmail(emailId: string, dryRun: boolean = false): Promise<void> {
    const gmail = this.ensureInitialized();
    if (dryRun) {
      console.log(`[DRY RUN] Would trash email ${emailId}`);
      return;
    }
    await gmail.users.messages.trash({ userId: 'me', id: emailId });
  }

  async sendEmail(to: string, subject: string, htmlBody: string): Promise<void> {
    const gmail = this.ensureInitialized();

    // Email headers are ASCII-only. A subject with non-ASCII chars (e.g. emoji)
    // must use RFC 2047 encoded-word syntax, or clients render it as mojibake.
    const encodedSubject = /[^\x00-\x7F]/.test(subject)
      ? `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`
      : subject;

    const messageParts = [
      `To: ${to}`,
      'Content-Type: text/html; charset=utf-8',
      'MIME-Version: 1.0',
      `Subject: ${encodedSubject}`,
      '',
      htmlBody,
    ];

    const raw = Buffer.from(messageParts.join('\n'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });
  }

  async getEmailCount(): Promise<{ total: number; inbox: number; unread: number }> {
    const gmail = this.ensureInitialized();

    // resultSizeEstimate is an *estimate* Gmail does not stand behind — on a
    // maxResults:1 query it reported 201 for an inbox holding 12,992 messages.
    // Counting ids costs a handful of extra pages and is exact.
    const countLabel = async (labelId: string): Promise<number> => {
      let total = 0;
      let pageToken: string | undefined;
      do {
        const res = await gmail.users.messages.list({
          userId: 'me',
          labelIds: [labelId],
          maxResults: 500,
          pageToken,
        });
        total += (res.data.messages ?? []).length;
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
      return total;
    };

    const [inbox, unread, profile] = await Promise.all([
      countLabel('INBOX'),
      countLabel('UNREAD'),
      gmail.users.getProfile({ userId: 'me' }),
    ]);

    return {
      total: profile.data.messagesTotal || 0,
      inbox,
      unread,
    };
  }
}
