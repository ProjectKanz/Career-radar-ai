# Career Radar AI

AI-assisted job-search workspace for matching role requirements against candidate profile context, CV evidence, and portfolio proof.

## What It Does

Career Radar turns a job-search workflow into a repeatable operating system:

- Paste a job description and extract role requirements.
- Compare the role against candidate profile context and a CV evidence fact bank.
- Save target opportunities with match scores, status, company, role, and notes.
- Generate application-pack outputs such as summary rewrites, cover-message drafts, recruiter messages, and CV-ready framing.
- Track AI usage, cached outputs, dry-run checks, and Firestore diagnostics.

## Why It Exists

Tailoring applications manually is slow and inconsistent. This app explores how AI can help structure the process while keeping claims grounded in evidence instead of generic self-description.

The project is shared as a portfolio case study for:

- AI workflow design
- React product UI
- Firebase authentication and Firestore data modeling
- Gemini-assisted analysis
- CV evidence grounding
- Job-search pipeline operations

## Tech Stack

- React
- TypeScript
- Vite
- Express
- Firebase Auth
- Firestore
- Gemini API
- Google Drive / Docs APIs

## Local Setup

Install dependencies:

```bash
npm install
```

Create a local `.env` file:

```bash
GEMINI_API_KEY="your_gemini_api_key"
APP_URL="http://localhost:5173"
VITE_FIREBASE_API_KEY="your_firebase_api_key"
VITE_FIREBASE_AUTH_DOMAIN="your_project.firebaseapp.com"
VITE_FIREBASE_PROJECT_ID="your_project_id"
VITE_FIREBASE_STORAGE_BUCKET="your_project.appspot.com"
VITE_FIREBASE_MESSAGING_SENDER_ID="your_sender_id"
VITE_FIREBASE_APP_ID="your_firebase_app_id"
VITE_FIRESTORE_DATABASE_ID="your_firestore_database_id"
```

Run locally:

```bash
npm run dev
```

Build:

```bash
npm run build
```

Type-check:

```bash
npm run lint
```

## Privacy Notes

This repository intentionally excludes:

- `.env` files and API keys
- local build output
- `node_modules`
- actual Firebase config JSON
- legacy job-search import exports
- private handoff notes

The live application may contain user-provided CV context, job notes, Drive links, and generated application materials. Use demo or sanitized data before public screenshots, demos, or deployments.

