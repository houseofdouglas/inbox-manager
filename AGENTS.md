# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

Inbox Manager is an AI-powered Gmail automation tool that classifies and organizes emails using Codex or Gemini AI. It processes large inboxes (30k+ emails) by categorizing emails as marketing, transactional, or personal, then moves them to appropriate Gmail labels.

## Development Commands

```bash
# Install dependencies
npm install

# Development mode (with auto-reload)
npm run dev [command]

# Build TypeScript to JavaScript
npm run build

# Run production build
npm start [command]

# Type checking
npm run type-check

# Linting
npm run lint
```

## Available Commands

- `npm run dev stats` - Show email count statistics (total, inbox, unread)
- `npm run classify` - Classify emails without organizing (preview mode)
- `npm run organize` - Classify and organize emails based on configuration
- `npm run dev fix-unread` - Mark any marketing email still sitting unread as read (backfill)

## Architecture

### High-Level Structure

The application follows a service-oriented architecture with three main components:

1. **Gmail Service** ([src/services/gmail.ts](src/services/gmail.ts))
   - Handles OAuth2 authentication via local callback server (port 3000)
   - Manages Gmail API operations (list, get, modify messages)
   - Creates and manages labels (nested labels like `marketing/Amazon`)
   - All Gmail operations use labels, not folders (Gmail's label-based system)

2. **Email Classifier** ([src/services/classifier.ts](src/services/classifier.ts) and [src/services/gemini-classifier.ts](src/services/gemini-classifier.ts))
   - Two implementations: Codex (Anthropic) and Gemini (Google)
   - Both implement the same `IClassifier` interface for interchangeability
   - Codex models: Opus (most accurate), Sonnet (balanced), Haiku (fastest)
   - Gemini models: 2.0-flash-exp (recommended, free tier), 1.5-flash, 1.5-pro
   - Processes emails in parallel batches with concurrency limits (5 concurrent requests)
   - Extracts structured JSON from AI responses

3. **Main Orchestrator** ([src/index.ts](src/index.ts))
   - Coordinates Gmail and Classifier services
   - Implements three command modes: stats, classify, organize
   - Handles batch processing with configurable batch sizes
   - Supports dry-run mode for testing

### Email Classification Logic

The classifier prompts the AI (Codex or Gemini) to categorize emails into three types:

- **Marketing**: Promotional emails, newsletters → `marketing/{companyName}` label, marked read
- **Transactional**: Receipts, confirmations, notifications → `transactional/{companyName}` label, kept unread
- **Personal**: Friend/family emails → `personal` label, kept unread

Company name extraction is automatic for marketing and transactional emails.

Marking marketing read is an invariant, not a per-command choice: *every* path that
puts a message under a `marketing/` label must also strip `UNREAD`. That means
`organizeEmail`, `applyLabelOnly` (both honour `shouldMarkAsRead` from `labelFor`),
the `merge-labels` batch move, and the `fix-unknown` batch move. `npm run dev
fix-unread` is the backfill that repairs any marketing mail an older path left
unread.

### Authentication Flow

1. On first run, reads `credentials.json` (OAuth2 client credentials from Google Cloud Console)
2. Launches local HTTP server on port 3000
3. Opens browser for user authorization
4. Receives OAuth callback and exchanges code for tokens
5. Saves `token.json` for future authenticated requests
6. Subsequent runs reuse `token.json`

### Gmail API Label System

- Gmail uses labels, not folders - moving emails means adding/removing labels
- Removing `INBOX` label = moving out of inbox
- Removing `UNREAD` label = marking as read
- Nested labels use `/` separator (e.g., `marketing/Amazon`)
- Labels are created on-demand if they don't exist

## Configuration

All configuration is in [.env](.env) file:

**AI Provider Selection:**
- `AI_PROVIDER` - Choose: `Codex` or `gemini` (default: `gemini`)

**Gemini Configuration (when AI_PROVIDER=gemini):**
- `GEMINI_API_KEY` - Required for Google AI access (get from https://aistudio.google.com/apikey)
- `GEMINI_MODEL` - Choose: `gemini-2.0-flash-exp`, `gemini-1.5-flash`, or `gemini-1.5-pro`

**Codex Configuration (when AI_PROVIDER=Codex):**
- `ANTHROPIC_API_KEY` - Required for Codex API access
- `CLAUDE_MODEL` - Choose: `opus`, `sonnet`, or `haiku`

**General Settings:**
- `BATCH_SIZE` - Number of emails to process per run (default: 50)
- `DRY_RUN` - Set `true` to preview without changes, `false` to actually organize

Model ID mapping in [src/config.ts](src/config.ts):
- Codex: `opus` → `Codex-opus-4-5-20251101`, `sonnet` → `Codex-sonnet-4-5-20250929`, `haiku` → `Codex-3-5-haiku-20241022`
- Gemini models use their full IDs directly

## Required Setup Files

- `credentials.json` - OAuth2 credentials from Google Cloud Console for Gmail API (not in git)
- `token.json` - Auto-generated after first Gmail authentication (not in git)
- `.env` - Environment configuration (not in git, copy from `.env.example`)

## AI Provider Strategy

The codebase supports both Codex and Gemini through a unified interface:
- Factory function `createClassifier()` in [src/index.ts](src/index.ts) returns appropriate classifier based on `AI_PROVIDER`
- Both classifiers implement the same interface with `classify()` and `classifyBatch()` methods
- Default is Gemini due to generous free tier (15 req/min, 1500 req/day)
- Easy to switch providers by changing `AI_PROVIDER` in `.env`

## Gmail API Scopes

The application requests these scopes:
- `https://www.googleapis.com/auth/gmail.modify` - Modify emails (labels, read status)
- `https://www.googleapis.com/auth/gmail.labels` - Create and manage labels
