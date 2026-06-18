# Setup Guide

## Prerequisites

- An AI coding CLI — [Claude Code](https://claude.ai/code), Gemini CLI, Codex, Qwen Code, OpenCode or GitHub Copilot CLI
- [Node.js](https://nodejs.org) 18+ and `git` (`npx` ships with Node — the installer refuses to run without them) — note: the Gemini CLI integration requires Node.js 20+
- (Optional) Go 1.21+ (for the dashboard TUI)

## Quick Start

### Recommended — one command

```bash
npx @santifer/career-ops init
```

`npx` ships with Node.js — it runs the installer once without installing anything globally. This clones the latest release into `./career-ops` and installs dependencies. Then move into the workspace and open your AI CLI:

```bash
cd career-ops
claude   # or gemini / codex / qwen / opencode
```

**On first launch, career-ops walks you through setup by chatting** — it asks for your CV, your details (name, target roles, salary), and sets up the job scanner with pre-configured companies. Nothing to edit by hand: just answer its questions. Then paste a job offer URL or description and it evaluates it, writes a report, generates a tailored PDF, and tracks it.

### Advanced — clone manually

<details>
<summary>Prefer to clone the repo yourself?</summary>

```bash
git clone https://github.com/santifer/career-ops.git
cd career-ops
npm install
```

Then open your AI CLI in the folder — the same first-run onboarding applies. Use this path if you want to track a specific branch, contribute, or audit the code before installing dependencies.

</details>

### PDF rendering (one-time)

PDFs are rendered with a headless Chromium. Install it once per machine:

```bash
npx playwright install chromium
```

## Available Commands

| Action | How |
|--------|-----|
| Evaluate an offer | Paste a URL or JD text |
| Search for offers | `/career-ops scan` |
| Process pending URLs | `/career-ops pipeline` |
| Generate a PDF | `/career-ops pdf` |
| Batch evaluate | `/career-ops batch` |
| Check tracker status | `/career-ops tracker` |
| Fill application form | `/career-ops apply` |

## Verify Setup

```bash
node cv-sync-check.mjs      # Check configuration
node verify-pipeline.mjs     # Check pipeline integrity
```

## Build Dashboard (Optional)

```bash
cd dashboard
go build -o career-dashboard .
./career-dashboard --path ..  # Opens TUI pipeline viewer
```

## Korean Market Setup (대한민국 구직자용)

### JobKorea (잡코리아)

Playwright-based scanner. No API key needed, but requires Chromium:

```bash
npx playwright install chromium
```

Enable in `portals.yml`:
```yaml
- name: JobKorea
  provider: jobkorea
  search_keywords:
    - "AI 엔지니어"
    - "머신러닝"
  location_filter:
    - "서울"
    - "경기"
  enabled: true
```

### Saramin (사람인)

Official REST API — fully legal, no scraping:

1. Register for free access key: https://oapi.saramin.co.kr/join
2. Configure in `portals.yml`:
```yaml
- name: Saramin
  provider: saramin
  access_key: "YOUR_KEY"
  search_keywords:
    - "AI 엔지니어"
  enabled: true
```

### Auto-Apply (자동 지원)

For JobKorea auto-apply, create your profile:
```bash
cp config/jobkorea-profile.yml.example config/jobkorea-profile.yml
# Edit with your: JobKorea ID/PW, name, phone, education, career
```

Then fill your CV (required for all evaluations):
```bash
# Create cv.md with your CV in markdown format
```

### Scan + Apply Workflow

```bash
node scan.mjs --company "JobKorea"     # Scan listings
node scan.mjs --company "Saramin"      # Scan listings
node jobkorea-apply.mjs --report 42 --dry-run  # Preview
node jobkorea-apply.mjs --report 42 --headless=false  # Apply
```

### Legal Note

- **Saramin**: Official API — fully legal, zero risk
- **JobKorea**: Playwright scraping — personal use only. JobKorea has successfully sued competitors for scraping (120억원 settlement). Use responsibly: limited frequency, personal job search only, never commercial.
