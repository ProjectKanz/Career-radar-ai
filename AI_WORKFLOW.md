# Career Radar AI Workflow

This document is the source of truth for making Career Radar usable for daily job applications. The product goal is not perfect prose; it is a reliable apply-ready loop that helps the user decide, tailor, generate, and submit without manual refresh or repeated debugging.

## Daily Apply Workflow

The intended workflow is:

1. Paste job description and links in AI Match Radar.
2. Run fit analysis.
3. Use the fit score and gate decision:
   - Apply Now: generate materials and apply today.
   - Apply After CV Adjustment: generate materials, review high-priority checklist rows, then apply.
   - Verify First: check missing hard requirement before spending time.
   - Save for Later: keep as backlog.
   - Skip: do not polish.
4. Save opportunity once.
5. App writes opportunity, application pack, CV checklist, and submission pipeline entry.
6. Target Opportunities opens automatically and reflects the saved data without page refresh.
7. Generate CV to Drive.
8. Use Open Generated CV and apply link.
9. Update Submission Pipeline status.

## Grounding Rules

Career Radar must treat the Evidence Bank as the factual source of truth.

- Verified evidence may be used in CV output.
- Unverified evidence may be ignored or flagged, but must not become a CV claim.
- Job description keywords may guide emphasis, but must not create new skills, credentials, employers, dates, or results.
- Application Pack text may be used as wording guidance, not factual truth.
- Ready-to-copy checklist rows can override CV wording when grounded and current.

## Output Rules

Generated CV output should be recruiter-readable and application-ready:

- One page by default.
- Summary is concise, role-aware, and grounded.
- Bullets use action, scope or method, and outcome.
- Certifications are true credentials only.
- Achievements are not certifications.
- Skills come from verified evidence or strongly supported inferred capabilities.
- Avoid inflated fresh-graduate language such as executive stakeholder ownership, senior leadership claims, or over-technical business-role wording.

## Reliability Expectations

The app should not require manual refresh during normal use.

- Save Opportunity should update Target Opportunities, CV Checklist, and Submission Pipeline.
- CV generation should show progress, failure, and success states.
- Firestore server read failures should be visible.
- One bad opportunity or debug payload should not crash the app.
- Google Drive OAuth should be initiated from a direct user action and failures should be shown clearly.

## Current Readiness

Current readiness for daily applying is usable but not fully hardened. Use the system for applications, but keep manual checks for generated CV and final submission status until the roadmap in the handover response is completed.
