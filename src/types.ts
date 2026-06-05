export interface Profile {
  id?: string;
  fullName: string;
  education: string;
  graduationDate?: string;
  gpa?: number;
  workExperienceCount?: number;
  experienceBrief: string;
  targetRoles: string;
  preferredLocations?: string;
  salaryTargetMin?: number;
  salaryTargetMax?: number;
  portfolioWording?: string;
  cvTemplateDocumentId?: string;
  cvTemplateSourceUrl?: string;
  updatedAt: string;
}

export interface CVEvidence {
  id?: string;
  evidenceId: string; // CSA-01, XL-01, PORT-01, etc.
  category: string;
  title: string;
  organization?: string;
  description: string;
  isVerified: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface JobSearchRaw {
  id?: string;
  sourceUrl: string;
  applyLink?: string;
  jobText: string;
  company?: string;
  role?: string;
  location?: string;
  searchQuery?: string;
  sourceType?: string;
  discoveryStatus: 'Staged' | 'Processing' | 'Processed' | 'Rejected';
  dedupeKey?: string;
  createdAt: string;
  updatedAt: string;
}

export type DecisionType = 'Apply Now' | 'Apply After CV Adjustment' | 'Save for Later' | 'Skip' | 'Verify First';
export type RoleDirection =
  | 'Generalist Leadership Program'
  | 'Business / Operations'
  | 'Data / BI'
  | 'Procurement / Supply Chain'
  | 'Sales / Commercial'
  | 'Marketing / Brand'
  | 'Technical / IT'
  | 'Finance / Banking'
  | 'Consulting';
export type CvBaseVersion = 'MT / Generalist' | 'DATA' | 'OPS' | 'PROCUREMENT' | 'GENERAL';

export interface RoleDnaClassification {
  primaryDirection: RoleDirection;
  industrySignals: string[];
  functionSignals: string[];
  seniorityLevel: string;
  hardSkillSignals: string[];
  softSkillSignals: string[];
  eligibilitySignals: string[];
  avoidOverclaimRisks: string[];
}

export interface EvidenceRoleMapping {
  evidenceId: string;
  rawEvidence: string;
  businessMeaning: string;
  roleRelevantWording: string;
  targetCvSection: string;
}

export interface CvGenerationDebug {
  roleDna: RoleDnaClassification;
  cvBaseVersion: CvBaseVersion;
  evidenceMappings: EvidenceRoleMapping[];
  qualificationPromotions: {
    id?: string;
    cvSection?: string;
    editType?: string;
    sourceEvidence?: string;
    finalSuggestedText?: string;
    whyTheChangeMatters?: string;
    evidenceId?: string;
    priority?: string;
  }[];
  certificationPriority: string[];
  rawCertificationCandidates?: {
    evidenceId: string;
    title: string;
    organization?: string;
    category?: string;
    source: 'evidence_bank';
    status: 'accepted' | 'rejected';
    rejectionReason?: string;
    deduplicationKey: string;
    priority?: number;
    finalText?: string;
  }[];
  certificationEvidenceSelected?: {
    evidenceId: string;
    title: string;
    reason: string;
    priority: number;
    finalText: string;
  }[];
  finalSelectedCertificationList?: string[];
  finalCertificationStringLength?: number;
  onePageCompressionMode?: boolean;
  noiseReductionRules: string[];
  summarySource?: 'checklist' | 'application_pack' | 'fallback_generated';
  selectedSummary?: string;
  verifiedEvidenceCount: number;
  ignoredUnverifiedEvidenceIds: string[];
  readyChecklistRowsUsed: {
    id: string;
    cvSection: string;
    evidenceId: string;
    finalSuggestedText: string;
  }[];
  evidenceIdsUsed: string[];
  onePageRiskWarning?: string;
  englishEvidenceWarning?: string;
  qualityWarnings?: string[];
  templateWarnings?: string[];
  finalPlaceholderJson?: Record<string, string>;
}

export interface CareerRadarOpportunity {
  id?: string;
  company: string;
  role: string;
  location?: string;
  sourceUrl?: string;
  applyLink?: string;
  jobText?: string;
  fitScore: number;
  decision: DecisionType;
  analysisNotes?: string;
  roleDna?: string;
  educationFit?: string;
  experienceFit?: string;
  portfolioFit?: string;
  hasRedFlags?: boolean;
  redFlags?: string;
  isStretchRole?: boolean;
  roleDnaFramework?: RoleDnaClassification;
  cvBaseVersion?: CvBaseVersion;
  evidenceRoleMappings?: EvidenceRoleMapping[];
  evidenceIdsUsed?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationPack {
  id?: string;
  opportunityId: string;
  company: string;
  role: string;
  applicationEnergy: 'High' | 'Medium' | 'Lock' | 'None';
  cvAction?: string;
  cvAngle?: string;
  keywordsToEmphasize?: string;
  summaryRewrite?: string;
  bulletPrioritization?: string;
  coverMessage?: string;
  linkedinMessage?: string;
  portfolioEvidence?: string;
  reviewNotes?: string;
  hardSkills?: string;
  softSkills?: string;
  cvSectionActions?: string;
  cvReadyLink?: string;
  cvReadyStatus?: 'Draft' | 'Generating' | 'Generated' | 'Failed' | 'Reviewed' | 'Submitted';
  cvReadyAt?: string;
  cvReadyNotes?: string;
  cvGenerationDebug?: CvGenerationDebug;
  createdAt: string;
  updatedAt: string;
}

export interface CVEditChecklist {
  id?: string;
  opportunityId: string;
  company?: string;
  role?: string;
  cvSection: string;
  editType?: string;
  sourceEvidence?: string;
  finalSuggestedText: string;
  whyTheChangeMatters?: string;
  priority?: string;
  evidenceId?: string;
  groundingStatus?: 'Grounded' | 'Unverified' | 'Pending';
  isReadyToCopy: boolean;
  qualityNotes?: string;
  isStale: boolean;
  isDone: boolean;
  createdAt: string;
  updatedAt: string;
}

export type BriefStatus = 
  | 'Applied' 
  | 'Expired' 
  | 'Cancelled' 
  | 'Canceled' 
  | 'Closed' 
  | 'Skipped' 
  | 'Not Applied' 
  | 'Not Applied - Closed' 
  | 'Not Applied - Expired' 
  | 'Rejected' 
  | 'Withdrawn'
  | 'Queued'
  | 'Pending'
  | 'Review'
  | 'Retry Later';

export interface DailyApplyBrief {
  id?: string;
  opportunityId: string;
  company: string;
  role: string;
  fitScore: number;
  decision: string;
  applicationEnergy?: string;
  cvAction?: string;
  priority?: string;
  userActionNeeded?: string;
  briefDate?: string;
  status: BriefStatus;
  userNotes?: string;
  createdAt: string;
  updatedAt: string;
}
