# Career Radar CV Rules

## Source Priority

Professional summary source order:

1. Ready-to-copy checklist row for Professional Summary.
2. Grounded Application Pack `summaryRewrite`.
3. Fallback generated summary.

Fallback summary formula for MT, BFLP, ODP, and Future Leader roles:

Candidate identity + relevant capabilities + quantified proof + target industry/function interest + role identity.

## Evidence Grounding

Allowed CV claims:

- verified profile fields
- verified Evidence Bank records
- ready checklist rows grounded to verified evidence
- deterministic planner outputs based on verified evidence

Disallowed CV claims:

- job-description-only skills
- unverified certifications
- invented tools
- inflated seniority
- unsupported outcomes

## Certifications

Use dynamic placeholder:

`{{CERTIFICATIONS}}`

Certification section should include only true credentials:

- certifications
- courses
- language proficiency credentials
- licenses
- formal training records

Reject from Certifications:

- competitions
- achievements
- awards
- work experience
- projects
- portfolio items

For MT/BFLP/ODP/Future Leader roles, preferred order when verified and relevant:

1. English proficiency or TOEFL/IELTS/TOEIC.
2. Gemini Certified Faculty or AI/digital credential.
3. Financial Analyst Course for finance/banking relevance.
4. Excel certification for reporting/data/business analysis.

Compact certification format:

`English Proficiency Test 527 / Advanced - Universitas Negeri Malang | Gemini Certified Faculty - Google | Financial Analyst Course - Udemy | Microsoft Excel - Coursera`

## Achievements

Achievements should include competitions, awards, and measurable extracurricular outcomes. Capital Market Competition belongs in Achievements, not Certifications.

## Skills

Skills should eventually be produced by a Skill Planner.

Primary source:

- verified evidence skill tags when available
- verified evidence title and description
- profile fields with explicit skills

Allowed inference:

- only when strongly supported by verified evidence

Rejected:

- job-description-only skill keywords
- trendy keywords with no evidence
- over-technical stacks for business roles

## One-Page Compression

Trigger compression when:

- certification string is long
- total placeholder word count risks exceeding one page
- skills are too broad
- bullets exceed section limits

Compression actions:

- use compact certification names
- cap certification list to the most relevant four items
- reduce skills to high-confidence items
- keep work bullets one sentence
- avoid explanatory notes inside CV fields
