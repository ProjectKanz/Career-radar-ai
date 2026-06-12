# CareerRadar AI

Internal BYOK AI-assisted job-search workspace for matching role requirements against candidate profile context, CV evidence, and portfolio proof.

CareerRadar AI is currently an internal-use tool. Do not publish it as a public portfolio demo until privacy, data exposure, and deployment risks have been reviewed. Users can explore matching with Dry Run mode, add their own Gemini API key for AI-assisted onboarding/job matching, and generate tailored CV documents through local placeholder mapping.

## What It Does

Career Radar turns a job-search workflow into a repeatable operating system:

- Paste a job description and extract role requirements.
- Compare the role against candidate profile context and a CV evidence fact bank.
- Save target opportunities with match scores, status, company, role, and notes.
- Generate application-pack outputs such as summary rewrites, cover-message drafts, recruiter messages, and CV-ready framing.
- Generate CV placeholder JSON locally from verified evidence, then create a tailored Google Docs CV without spending a Gemini call for the CV mapping step.
- Track AI usage, cached outputs, dry-run checks, and Firestore diagnostics.
- Add your own Gemini API key in AI Settings for AI-assisted onboarding, screenshot extraction, and job matching.

## Internal Test Flow

Use this sequence when trying the app with test data:

1. Sign in with Google.
2. Open **AI Settings**.
3. Keep **Dry Run / No AI** on if you only want a free preview.
4. To run AI-assisted onboarding or job matching, create a Gemini API key from Google AI Studio and paste it into AI Settings.
5. Fill **Candidate Profile Context** with your education, target roles, and short experience background.
6. Add verified achievements, organizations, projects, skills, and certificates in **CV Evidence Bank**.
7. Paste a job description in **AI Match Radar**.
8. Review the match result, save the opportunity, then generate a tailored CV draft into your Google Drive. CV placeholder mapping is local and does not require a Gemini call.

### Getting a Gemini API Key

For AI-assisted onboarding, screenshot extraction, and job matching, each user should use their own Gemini API key:

1. Open Google AI Studio API Keys: <https://aistudio.google.com/app/apikey>
2. Sign in with your Google account.
3. Create or get an API key.
4. Copy the key that starts with `AIza`.
5. Paste it into **AI Settings** inside CareerRadar AI.

Official guide: <https://ai.google.dev/gemini-api/docs/api-key>

Google offers a Gemini API free tier for testing with limited quota. If billing is enabled, usage may become paid depending on model and quota settings.

## Why It Exists

Tailoring applications manually is slow and inconsistent. This app explores how AI can help structure the process while keeping claims grounded in evidence instead of generic self-description.

The project is being prepared as an internal case study for:

- AI workflow design
- React product UI
- Firebase authentication and Firestore data modeling
- Gemini-assisted analysis
- CV evidence grounding
- Job-search pipeline operations

## Internal Positioning

CareerRadar AI demonstrates a practical AI productivity system, but it should remain internal until privacy review is complete:

- Evidence-grounded resume tailoring instead of generic CV rewriting.
- Bring-your-own-key Gemini usage for safer internal testing.
- Dry-run request previews for cost awareness.
- Local CV placeholder mapping to avoid unnecessary Gemini spend during CV generation.
- Firestore-backed user workspaces.
- Google Drive / Docs CV generation for real application workflows.
- Recruiter-readable project framing for data, operations, business, and leadership-program applications.

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
GEMINI_API_KEY="optional_server_gemini_api_key"
ALLOW_SERVER_GEMINI_KEY_PUBLIC="false"
APP_URL="http://localhost:5173"
VITE_FIREBASE_API_KEY="your_firebase_api_key"
VITE_FIREBASE_AUTH_DOMAIN="your_project.firebaseapp.com"
VITE_FIREBASE_PROJECT_ID="your_project_id"
VITE_FIREBASE_STORAGE_BUCKET="your_project.appspot.com"
VITE_FIREBASE_MESSAGING_SENDER_ID="your_sender_id"
VITE_FIREBASE_APP_ID="your_firebase_app_id"
VITE_FIRESTORE_DATABASE_ID="your_firestore_database_id"
```

By default, users must provide their own Gemini API key in **AI Settings** for AI-assisted requests. Keep `ALLOW_SERVER_GEMINI_KEY_PUBLIC="false"` unless you intentionally want every signed-in user to consume the server key.

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

The live application may contain user-provided CV context, job notes, Drive links, and generated application materials. Use demo or sanitized data before screenshots, demos, or deployments.

Gemini API keys entered in **AI Settings** are stored in the user's browser local storage and sent only with AI requests. Do not paste keys on shared devices.

