# Payload-First Security Specification

## 1. Core Data Invariants

For our AI Career Radar app, data must satisfy these absolute rules to prevent security vulnerabilities, bypass attempts, or relational inconsistencies:

1. **Strict User-Specific Path Isolation (Owner Principle)**:
   - Access to any document under `/users/{userId}/...` is strictly isolated. Read and write privileges are only granted if `request.auth.uid == userId`. There are NO shared databases, cross-tenant reads, or unauthenticated pathways.
2. **Email Verification Gate**:
   - Access to standard write operations is guarded. The user must be verified via their authenticated provider: `request.auth.token.email_verified == true`.
3. **Rigid Identifier Verification (Path Variable Hardening)**:
   - Any custom ID generated or referenced in the path variable (e.g. `evidenceId`, `rawId`, `radarId`, `briefId`, `packId`, `checklistId`) must meet standard regex parameters: `id.matches('^[a-zA-Z0-9_\\-]+$')` with a maximum boundary limit of 128 characters to prevent Denial of Wallet string injection attacks.
4. **Immutable Relational Links**:
   - Fields that establish relationships—like `opportunityId` in the ApplicationPack, CVEditChecklist, and DailyApplyBrief schemas—must be immutable once created (`incoming().opportunityId == existing().opportunityId`).
5. **State Machine Integrity**:
   - Status codes and decisions must adhere strictly to predefined enums.
6. **Temporal Integrity (Strict Server Timestamps)**:
   - Creation fields (`createdAt` / `updatedAt`) must equal the exact server timestamp rule: `request.time`. Clients cannot fake or provide past or future timestamps.
7. **Shadow Field Prevention (Validation Blueprints)**:
   - Write operations must explicitly require the exactly documented keys for creation to prevent "Ghost Fields" from being injected into schemas.

---

## 2. The "Dirty Dozen" Malicious Payloads

The following 12 payloads are designed to attack the system. Our security rules will guarantee that all of these attempts will fail with `PERMISSION_DENIED` :

### Payload 1: Profile Hijacking (Identity Spoofing)
- **Target**: `/users/victim_user_123`
- **Method**: Authenticated as `attacker_uid`, attempts to write a new profile description to another user's space.
- **Payload**:
  ```json
  {
    "fullName": "Malicious Attacker",
    "education": "None",
    "experienceBrief": "Hacked",
    "targetRoles": "Hacker",
    "updatedAt": "request.time"
  }
  ```

### Payload 2: Bypass Email Verification
- **Target**: `/users/attacker_uid`
- **Method**: Authed as `attacker_uid` but without a verified email (`request.auth.token.email_verified == false`), attempts to initialize a profile.
- **Payload**:
  ```json
  {
    "fullName": "Unverified User",
    "education": "Incomplete",
    "experienceBrief": "My Briefing",
    "targetRoles": "Product Manager",
    "updatedAt": "request.time"
  }
  ```

### Payload 3: Invalid Custom ID Injection (Resource Poisoning)
- **Target**: `/users/user_123/cvEvidenceBank/EXTREMELY_LONG_JUNK_CHARACTER_ID_THAT_IS_10KB_LONG_REPEATED_AAAAA...`
- **Method**: Injecting a monstrously large string into the document ID to pollute indices and deplete storage budget.
- **Payload**:
  ```json
  {
    "evidenceId": "MALFORMED_ID",
    "category": "Work Experience",
    "title": "Poisoner",
    "description": "Large Injection",
    "isVerified": true,
    "updatedAt": "request.time"
  }
  ```

### Payload 4: Overwriting Original Timestamp (Temporal Integrity Breach)
- **Target**: `/users/user_123/cvEvidenceBank/CSA-01`
- **Method**: Setting `createdAt` to a historical date to forge fake experience timestamps.
- **Payload**:
  ```json
  {
    "evidenceId": "CSA-01",
    "category": "Work Experience",
    "title": "Project Control",
    "organization": "PT CSA",
    "description": "Legitimate tracking of 120+ sites",
    "isVerified": true,
    "createdAt": "1999-01-01T00:00:00Z",
    "updatedAt": "request.time"
  }
  ```

### Payload 5: Splicing Related Parent Links (Immutable Opportunity ID Bypass)
- **Target**: `/users/user_123/cvEditChecklist/checklist_abc`
- **Method**: Updating a checklist entry to change its parent `opportunityId` to hijack data or cause orphan reference loops.
- **Payload**:
  ```json
  {
    "opportunityId": "stolen_opportunity_id_123",
    "cvSection": "Summary",
    "finalSuggestedText": "Hackedsuggested",
    "isReadyToCopy": true,
    "isStale": false,
    "isDone": false,
    "updatedAt": "request.time"
  }
  ```

### Payload 6: Shadow Update (Ghost Field Injection)
- **Target**: `/users/user_123/jobSearchRaw/raw_999`
- **Method**: Injected fields that do not exist in the official model (e.g. `isAdminPrivilege`), bypassing size validation checks.
- **Payload**:
  ```json
  {
    "jobText": "Unstructured search row...",
    "sourceUrl": "https://linkedin.com/jobs/99",
    "discoveryStatus": "Staged",
    "isAdminPrivilege": true,
    "ghostSecret": "shadow_field_bypass_val",
    "createdAt": "request.time",
    "updatedAt": "request.time"
  }
  ```

### Payload 7: Value Poisoning of Decision Enum
- **Target**: `/users/user_123/careerRadar/radar_888`
- **Method**: Overwriting the `decision` column with a non-enum premium or mock string to crash client rendering engines.
- **Payload**:
  ```json
  {
    "company": "PT Cahaya Inti",
    "role": "Management Trainee",
    "fitScore": 95,
    "decision": "AUTOMATICALLY_HIRE_NO_INTERVIEW",
    "createdAt": "request.time",
    "updatedAt": "request.time"
  }
  ```

### Payload 8: Blanket Unauthorized Listing Queries (PII Scraping)
- **Target**: `/users/victim_user_123/cvEvidenceBank`
- **Method**: Attempting to fetch all records of a victim user via client-side query without proper isolation logic.
- **Result**: Denied at the rules layer because client credentials do not align with `userId` of the requested root path.

### Payload 9: Hijacking Sibling Document Attributes (Identity Integrity)
- **Target**: `/users/user_123/applicationPack/pack_888`
- **Method**: Submitting auth token belonging to UID `user_123` but injecting `opportunityId` claiming affinity with a victim's document.
- **Payload**:
  ```json
  {
    "opportunityId": "victim_opportunity_777",
    "company": "Unrelated PT",
    "role": "Ops Analyst",
    "applicationEnergy": "High",
    "createdAt": "request.time",
    "updatedAt": "request.time"
  }
  ```

### Payload 10: State Shortcutting to Invalid Daily Brief Statuses
- **Target**: `/users/user_123/dailyApplyBrief/brief_111`
- **Method**: Submitting an unauthorized status string that does not belong to the standard enum.
- **Payload**:
  ```json
  {
    "opportunityId": "opp_999",
    "company": "XL Axiata",
    "role": "Data Analyst",
    "fitScore": 92,
    "decision": "Apply Now",
    "status": "OFFER_GRANTED_BY_CEO",
    "createdAt": "request.time",
    "updatedAt": "request.time"
  }
  ```

### Payload 11: Modifying Terminal-Locked Status Columns
- **Target**: `/users/user_123/dailyApplyBrief/brief_111`
- **Method**: Attempting to update core variables (like score) or notes after a brief has officially been marked with terminal status `Closed`.
- **Payload**:
  ```json
  {
    "fitScore": 100,
    "userNotes": "Cheat code updated score",
    "updatedAt": "request.time"
  }
  ```

### Payload 12: Fraudulent Unverified Evidentiary Grounding
- **Target**: `/users/user_123/cvEditChecklist/checklist_222`
- **Method**: Forcing `groundingStatus = "Grounded"` for completely unverified or fictional portfolio items.
- **Payload**:
  ```json
  {
    "opportunityId": "opp_999",
    "cvSection": "Summary",
    "finalSuggestedText": "Super manager with 10 years experience",
    "isReadyToCopy": true,
    "isStale": false,
    "isDone": false,
    "evidenceId": "FICTION-01",
    "groundingStatus": "Grounded",
    "createdAt": "request.time",
    "updatedAt": "request.time"
  }
  ```

---

## 3. Test Verification Blueprint

The file `firestore.rules.test.ts` will verify that:
1. Valid payloads from authorized, verified users succeed for create, read, update, and delete actions.
2. Every single one of these "Dirty Dozen" malicious payloads is blocked instantly with `PERMISSION_DENIED` errors.
3. Path variables are strictly checked against hijacking, poisoning, and shadow updating.
