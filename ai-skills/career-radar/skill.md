# Career Radar Skill

Use this skill when working on the Career Radar app, CV generation, evidence grounding, job-fit analysis, or application workflow reliability.

## Mission

Career Radar exists to help the user apply to jobs faster. Prefer reliability, traceability, and apply-readiness over polished wording debates.

## Operating Principles

- Do not invent CV facts.
- Prefer verified Evidence Bank data over generated language.
- Treat Application Pack content as phrasing support, not factual source of truth.
- Keep CV output one page unless the user explicitly asks otherwise.
- Optimize for daily use: save, update, generate, and apply with clear status.
- Avoid adding features that increase review burden unless they remove a real blocker.

## Engineering Priorities

1. Preserve the end-to-end apply workflow.
2. Keep Firestore paths under `/profiles/{userId}`.
3. Keep named Firestore database initialization intact.
4. Make server-read and permission failures visible.
5. Avoid cache-only success for critical reads.
6. Keep generated CV debug inspectable but collapsed by default.
7. Avoid rendering raw objects directly in React.

## AI Generation Boundaries

Gemini can rank, summarize, and reword, but deterministic planners should handle:

- source priority for professional summary
- verified evidence filtering
- certification selection and dedupe
- future skill selection and confidence
- one-page compression decisions

## Definition of Done

A change is not done until the user can continue the apply workflow without extra refreshes or hidden failure states. For code changes, run `npm run lint` and `npm run build`.
