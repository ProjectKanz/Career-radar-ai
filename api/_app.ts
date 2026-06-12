import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import zlib from 'zlib';
import { GoogleGenAI, Type } from '@google/genai';
import rateLimit from 'express-rate-limit';

// Lazy-initialize the server Gemini client only when public fallback is explicitly enabled.
let serverAiClient: GoogleGenAI | null = null;
function getRequestGeminiApiKey(req: express.Request) {
  const headerValue = req.header('x-gemini-api-key') || '';
  return headerValue.trim();
}

function getGenAIClient(apiKey?: string): GoogleGenAI {
  const requestApiKey = String(apiKey || '').trim();
  if (requestApiKey) {
    return new GoogleGenAI({
      apiKey: requestApiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }

  const allowServerKeyPublic = String(process.env.ALLOW_SERVER_GEMINI_KEY_PUBLIC || 'false') === 'true';
  if (!allowServerKeyPublic) {
    throw new Error('Gemini API key required. Add your own key in AI Settings, or use Dry Run mode for a no-cost preview.');
  }

  if (!serverAiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not defined. Add a user API key in AI Settings, or configure the server environment.');
    }
    serverAiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return serverAiClient;
}

export const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));

type AiUsageStatus = 'success' | 'error';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const MAX_AI_CALLS_PER_JOB_WORKFLOW = Number(process.env.MAX_AI_CALLS_PER_JOB_WORKFLOW || 2);
const MAX_INPUT_CHARS_PER_CALL = Number(process.env.MAX_INPUT_CHARS_PER_CALL || 45000);
const MAX_EVIDENCE_ITEMS_PER_CALL = Number(process.env.MAX_EVIDENCE_ITEMS_PER_CALL || 18);
const MAX_ANALYZE_EVIDENCE_ITEMS_PER_CALL = Number(process.env.MAX_ANALYZE_EVIDENCE_ITEMS_PER_CALL || Math.min(MAX_EVIDENCE_ITEMS_PER_CALL, 8));
const DAILY_AI_CALL_LIMIT_DEV = Number(process.env.DAILY_AI_CALL_LIMIT_DEV || 20);
const REQUIRE_CONFIRM_FOR_REGENERATE = String(process.env.REQUIRE_CONFIRM_FOR_REGENERATE || 'true') === 'true';
const MAX_JOB_TEXT_CHARS = Number(process.env.MAX_JOB_TEXT_CHARS || 12000);
const MAX_JOB_SCREENSHOT_BYTES = Number(process.env.MAX_JOB_SCREENSHOT_BYTES || 3 * 1024 * 1024);

interface AiUsageLogEntry {
  id: string;
  timestamp: string;
  featureName: string;
  company?: string;
  role?: string;
  opportunityId?: string;
  endpointName: string;
  model: string;
  inputCharacterCount: number;
  outputCharacterCount: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
  tokenCountSource: 'sdk' | 'estimated';
  durationMs: number;
  cacheStatus?: 'miss' | 'hit' | 'dry_run' | 'blocked';
  status: AiUsageStatus;
  errorMessage?: string;
}

const aiUsageLog: AiUsageLogEntry[] = [];
const aiResponseCache = new Map<string, unknown>();
const dailyAiCalls = new Map<string, number>();

function estimateTokensFromChars(charCount: number) {
  return Math.ceil(charCount / 4);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashPayload(value: unknown) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function tokenUsageFromResponse(response: unknown, inputChars: number, outputChars: number) {
  const usage = (response as { usageMetadata?: Record<string, number> })?.usageMetadata;
  const inputTokens = usage?.promptTokenCount || usage?.inputTokenCount || estimateTokensFromChars(inputChars);
  const outputTokens = usage?.candidatesTokenCount || usage?.outputTokenCount || estimateTokensFromChars(outputChars);
  const totalTokens = usage?.totalTokenCount || inputTokens + outputTokens;
  return {
    estimatedInputTokens: inputTokens,
    estimatedOutputTokens: outputTokens,
    estimatedTotalTokens: totalTokens,
    tokenCountSource: usage ? 'sdk' as const : 'estimated' as const
  };
}

function dailyAiLimitError() {
  const key = todayKey();
  const current = dailyAiCalls.get(key) || 0;
  if (current >= DAILY_AI_CALL_LIMIT_DEV) {
    return `Daily AI call limit reached (${current}/${DAILY_AI_CALL_LIMIT_DEV}). Use cached output or Dry Run mode for UI testing.`;
  }
  dailyAiCalls.set(key, current + 1);
  return '';
}

function assertCostGuard(inputChars: number, options: { allowInputOverride?: boolean } = {}) {
  const dailyError = dailyAiLimitError();
  if (dailyError) throw new Error(dailyError);
  if (!options.allowInputOverride && inputChars > MAX_INPUT_CHARS_PER_CALL) {
    throw new Error(`AI request blocked: input ${inputChars.toLocaleString()} chars exceeds MAX_INPUT_CHARS_PER_CALL ${MAX_INPUT_CHARS_PER_CALL.toLocaleString()}. Reduce context or use Dry Run.`);
  }
}

function recordAiUsage(entry: Omit<AiUsageLogEntry, 'id' | 'timestamp'>) {
  aiUsageLog.unshift({
    ...entry,
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString()
  });

  if (aiUsageLog.length > 100) {
    aiUsageLog.length = 100;
  }
}

function recordAnalyzeJobUsage(
  status: AiUsageStatus,
  inputCharacterCount: number,
  outputCharacterCount: number,
  durationMs: number,
  company?: string,
  role?: string,
  errorMessage?: string,
  cacheStatus: AiUsageLogEntry['cacheStatus'] = 'miss'
) {
  const usage = {
    estimatedInputTokens: estimateTokensFromChars(inputCharacterCount),
    estimatedOutputTokens: estimateTokensFromChars(outputCharacterCount),
    estimatedTotalTokens: estimateTokensFromChars(inputCharacterCount) + estimateTokensFromChars(outputCharacterCount),
    tokenCountSource: 'estimated' as const
  };

  ['Analyze Job Fit', 'Generate Application Pack', 'Generate CV Checklist'].forEach((featureName) => {
    recordAiUsage({
      featureName,
      company,
      role,
      endpointName: '/api/analyze-job',
      model: GEMINI_MODEL,
      inputCharacterCount,
      outputCharacterCount,
      durationMs,
      cacheStatus,
      ...usage,
      status,
      errorMessage
    });
  });
}

type RoleDirection =
  | 'Generalist Leadership Program'
  | 'Business / Operations'
  | 'Data / BI'
  | 'Procurement / Supply Chain'
  | 'Sales / Commercial'
  | 'Marketing / Brand'
  | 'Technical / IT'
  | 'Finance / Banking'
  | 'Consulting';

type CvBaseVersion = 'MT / Generalist' | 'DATA' | 'OPS' | 'PROCUREMENT' | 'GENERAL';

interface CvEvidenceInput {
  id?: string;
  evidenceId?: string;
  category?: string;
  title?: string;
  organization?: string;
  description?: string;
  isVerified?: boolean;
}

interface ChecklistInput {
  id?: string;
  cvSection?: string;
  editType?: string;
  sourceEvidence?: string;
  finalSuggestedText?: string;
  whyTheChangeMatters?: string;
  evidenceId?: string;
  isReadyToCopy?: boolean;
  isStale?: boolean;
  priority?: string;
}

interface RoleDnaClassification {
  primaryDirection: RoleDirection;
  industrySignals: string[];
  functionSignals: string[];
  seniorityLevel: string;
  hardSkillSignals: string[];
  softSkillSignals: string[];
  eligibilitySignals: string[];
  avoidOverclaimRisks: string[];
}

interface EvidenceRoleMapping {
  evidenceId: string;
  rawEvidence: string;
  businessMeaning: string;
  roleRelevantWording: string;
  targetCvSection: string;
}

interface CertificationEvidenceSelection {
  evidenceId: string;
  title: string;
  reason: string;
  priority: number;
  finalText: string;
}

interface CertificationCandidateAudit {
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
}

interface CvTailoringFramework {
  roleDna: RoleDnaClassification;
  cvBaseVersion: CvBaseVersion;
  evidenceMappings: EvidenceRoleMapping[];
  qualificationPromotions: ChecklistInput[];
  certificationPriority: string[];
  rawCertificationCandidates?: CertificationCandidateAudit[];
  certificationEvidenceSelected?: CertificationEvidenceSelection[];
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
  finalPlaceholderJson?: Record<string, string>;
}

const roleDirectionRules: { direction: RoleDirection; keywords: string[] }[] = [
  {
    direction: 'Generalist Leadership Program',
    keywords: ['management trainee', 'graduate program', 'future leader', 'future leaders', 'bflp', 'odp', 'leadership program', 'business enabler', 'trainee']
  },
  {
    direction: 'Data / BI',
    keywords: ['data analyst', 'business intelligence', 'bi ', 'dashboard', 'analytics', 'reporting', 'sql', 'excel', 'tableau', 'power bi', 'looker', 'data visualization']
  },
  {
    direction: 'Procurement / Supply Chain',
    keywords: ['procurement', 'supply chain', 'purchasing', 'vendor', 'supplier', 'inventory', 'warehouse', 'logistics', 'material control', 'sourcing']
  },
  {
    direction: 'Sales / Commercial',
    keywords: ['sales', 'commercial', 'account executive', 'business development', 'partnership', 'revenue', 'customer acquisition', 'merchant', 'client relationship']
  },
  {
    direction: 'Marketing / Brand',
    keywords: ['marketing', 'brand', 'campaign', 'social media', 'content', 'market research', 'activation', 'communications', 'consumer insight']
  },
  {
    direction: 'Technical / IT',
    keywords: ['software', 'developer', 'engineer', 'frontend', 'backend', 'full stack', 'it ', 'cloud', 'api', 'react', 'node', 'database', 'security']
  },
  {
    direction: 'Finance / Banking',
    keywords: ['bank', 'banking', 'finance', 'financial', 'capital market', 'investment', 'credit', 'risk', 'treasury', 'loan', 'wealth']
  },
  {
    direction: 'Consulting',
    keywords: ['consultant', 'consulting', 'strategy', 'advisory', 'business analyst', 'case', 'transformation', 'problem solving']
  },
  {
    direction: 'Business / Operations',
    keywords: ['operations', 'operation', 'process improvement', 'business process', 'project admin', 'project coordination', 'execution', 'coordination', 'administration', 'workflow']
  }
];

function lowerText(...values: unknown[]) {
  return values
    .filter(Boolean)
    .map((value) => String(value))
    .join(' ')
    .toLowerCase();
}

function unique(items: string[]) {
  return Array.from(new Set(items.filter(Boolean)));
}

function wordCount(value: unknown) {
  return String(value || '').trim().split(/\s+/).filter(Boolean).length;
}

function limitWords(value: unknown, maxWords: number) {
  const words = String(value || '').trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  return `${words.slice(0, maxWords).join(' ').replace(/[.,;:]+$/, '')}.`;
}

function softenRiskyLanguage(value: unknown) {
  return String(value || '')
    .replace(/\bleading large-scale operations\b/gi, 'supporting operations coordination')
    .replace(/\bled large-scale operations\b/gi, 'supported operations coordination')
    .replace(/\bexecutive stakeholders\b/gi, 'cross-functional stakeholders')
    .replace(/\bleadership excellence\b/gi, 'future leadership potential')
    .replace(/\bGoogle-certified AI professional\b/gi, 'Gemini Certified Faculty')
    .replace(/\bengineered\b/gi, 'built')
    .replace(/\bhigh-stakes operational coordination\b/gi, 'operations coordination')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactPipeList(value: unknown) {
  const parts = String(value || '')
    .split(/[|,;]+/)
    .map((item) => softenRiskyLanguage(item).trim())
    .filter(Boolean);
  return unique(parts).slice(0, 12).join(', ');
}

function matchedLabels(text: string, rules: { label: string; keywords: string[] }[]) {
  return rules
    .filter((rule) => rule.keywords.some((keyword) => text.includes(keyword)))
    .map((rule) => rule.label);
}

function classifyRoleDna(text: string): RoleDnaClassification {
  const scores = roleDirectionRules.map((rule) => ({
    direction: rule.direction,
    score: rule.keywords.reduce((sum, keyword) => sum + (text.includes(keyword) ? 1 : 0), 0)
  }));
  const primaryDirection = scores.sort((a, b) => b.score - a.score)[0]?.score
    ? scores[0].direction
    : 'Business / Operations';

  const industrySignals = matchedLabels(text, [
    { label: 'Banking / Financial Services', keywords: ['bank', 'banking', 'financial', 'finance', 'capital market', 'investment', 'credit'] },
    { label: 'Telecommunications', keywords: ['telecom', 'telco', 'network', 'site', 'xl axiata'] },
    { label: 'Technology / Digital', keywords: ['digital', 'technology', 'software', 'platform', 'automation', 'ai ', 'cloud'] },
    { label: 'Retail / Consumer', keywords: ['retail', 'consumer', 'customer', 'merchant', 'brand'] },
    { label: 'Consulting / Advisory', keywords: ['consulting', 'advisory', 'strategy consultant'] }
  ]);

  const functionSignals = matchedLabels(text, [
    { label: 'Operations execution', keywords: ['operations', 'execution', 'coordination', 'workflow', 'process'] },
    { label: 'Data reporting', keywords: ['data', 'dashboard', 'reporting', 'analytics', 'excel', 'bi'] },
    { label: 'Commercial growth', keywords: ['sales', 'commercial', 'revenue', 'business development', 'partnership'] },
    { label: 'Procurement control', keywords: ['procurement', 'supply chain', 'vendor', 'supplier', 'material'] },
    { label: 'Digital innovation', keywords: ['digital', 'automation', 'ai ', 'system', 'platform'] },
    { label: 'Financial analysis', keywords: ['finance', 'financial', 'banking', 'capital market', 'risk'] }
  ]);

  const hardSkillSignals = matchedLabels(text, [
    { label: 'Excel / Google Sheets', keywords: ['excel', 'spreadsheet', 'google sheets'] },
    { label: 'Dashboarding / BI', keywords: ['dashboard', 'bi ', 'power bi', 'tableau', 'looker'] },
    { label: 'Data analysis', keywords: ['data analysis', 'analytics', 'sql', 'database'] },
    { label: 'Process improvement', keywords: ['process improvement', 'operational excellence', 'workflow'] },
    { label: 'Project coordination', keywords: ['project coordination', 'project management', 'stakeholder'] },
    { label: 'Financial analysis', keywords: ['financial analysis', 'capital market', 'finance', 'banking'] },
    { label: 'Software / IT', keywords: ['software', 'api', 'react', 'node', 'cloud', 'developer'] }
  ]);

  const softSkillSignals = matchedLabels(text, [
    { label: 'Leadership potential', keywords: ['leader', 'leadership', 'future leader', 'management trainee'] },
    { label: 'Communication', keywords: ['communication', 'presentation', 'interpersonal'] },
    { label: 'Analytical thinking', keywords: ['analytical', 'analysis', 'problem solving'] },
    { label: 'Cross-functional coordination', keywords: ['cross-functional', 'stakeholder', 'coordination', 'collaboration'] },
    { label: 'Adaptability / learning agility', keywords: ['fast learner', 'learning', 'adaptable', 'growth'] }
  ]);

  const eligibilitySignals = matchedLabels(text, [
    { label: 'Fresh graduate / early career', keywords: ['fresh graduate', 'graduate', 'max 2 years', '0-2 years'] },
    { label: 'Bachelor degree', keywords: ['bachelor', 's1', 'undergraduate'] },
    { label: 'Minimum GPA', keywords: ['gpa', 'ipk', '3.00', '3.25', '3.50'] },
    { label: 'English proficiency', keywords: ['english', 'toefl', 'ielts', 'toeic'] },
    { label: 'Willing to be placed', keywords: ['willing to be placed', 'placement', 'relocate'] }
  ]);

  const avoidOverclaimRisks = [
    primaryDirection !== 'Technical / IT' ? 'Avoid excessive technical stack detail unless it directly supports business impact.' : '',
    primaryDirection === 'Generalist Leadership Program' ? 'Show leadership potential without claiming senior people-management authority.' : '',
    'Avoid unverified claims, fake seniority, and niche internal project terms without recruiter-readable business meaning.',
    'Prefer evidence-backed metrics and plain business outcomes over generic buzzwords.'
  ];

  const seniorityLevel = text.includes('manager') || text.includes('senior')
    ? 'Experienced / senior-leaning'
    : text.includes('fresh graduate') || text.includes('graduate program') || text.includes('trainee') || text.includes('max 2 years')
      ? 'Fresh graduate / early career'
      : 'Entry to mid / needs verification';

  return {
    primaryDirection,
    industrySignals: unique(industrySignals),
    functionSignals: unique(functionSignals),
    seniorityLevel,
    hardSkillSignals: unique(hardSkillSignals),
    softSkillSignals: unique(softSkillSignals),
    eligibilitySignals: unique(eligibilitySignals),
    avoidOverclaimRisks: unique(avoidOverclaimRisks)
  };
}

function recommendCvBaseVersion(roleDna: RoleDnaClassification, text: string): CvBaseVersion {
  if (roleDna.primaryDirection === 'Generalist Leadership Program') return 'MT / Generalist';
  if (roleDna.primaryDirection === 'Data / BI') return 'DATA';
  if (roleDna.primaryDirection === 'Procurement / Supply Chain') return 'PROCUREMENT';
  if (roleDna.primaryDirection === 'Business / Operations') return 'OPS';
  if (text.includes('process improvement') || text.includes('coordination') || text.includes('execution')) return 'OPS';
  return 'GENERAL';
}

function targetSectionForEvidence(evidence: CvEvidenceInput) {
  const text = lowerText(evidence.evidenceId, evidence.category, evidence.title, evidence.organization, evidence.description);
  if (text.includes('portfolio') || text.includes('project') || text.includes('automation') || text.includes('ai workflow')) return 'Project slot';
  if (text.includes('intern') || text.includes('work') || text.includes('experience') || text.includes('operations') || text.includes('material control') || text.includes('document controller') || text.includes('dashboard') || text.includes('analyst')) return 'Experience slot';
  if (text.includes('cert') || text.includes('course') || text.includes('english') || text.includes('toefl') || text.includes('ielts')) return 'Certification';
  if (text.includes('achievement') || text.includes('competition') || text.includes('award') || text.includes('capital market')) return 'Achievement';
  return 'Skills / supporting evidence';
}

function businessMeaningForEvidence(evidence: CvEvidenceInput) {
  const text = lowerText(evidence.evidenceId, evidence.category, evidence.title, evidence.organization, evidence.description);
  if (text.includes('120') || text.includes('site') || text.includes('material control')) return 'operational scale, documentation control, and process visibility';
  if (text.includes('30') || text.includes('field team') || text.includes('cross-functional')) return 'stakeholder coordination and cross-functional execution';
  if (text.includes('10000') || text.includes('10,000') || text.includes('transaction') || text.includes('dashboard')) return 'data-driven monitoring, reporting discipline, and decision support';
  if (text.includes('capital market') || text.includes('financial') || text.includes('finance')) return 'financial services interest and business analysis readiness';
  if (text.includes('automation') || text.includes('ai ') || text.includes('gemini') || text.includes('workflow')) return 'digital innovation and process improvement initiative';
  if (text.includes('english') || text.includes('toefl') || text.includes('ielts')) return 'English communication readiness for professional environments';
  return 'transferable proof of execution, analysis, or professional readiness';
}

function roleRelevantWordingForEvidence(evidence: CvEvidenceInput, roleDna: RoleDnaClassification) {
  const meaning = businessMeaningForEvidence(evidence);
  switch (roleDna.primaryDirection) {
    case 'Generalist Leadership Program':
      return `${meaning} framed as business operations, digital innovation, operational excellence, and future leadership potential`;
    case 'Finance / Banking':
      return `${meaning} framed as banking interest, financial analysis readiness, operational discipline, and risk-aware execution`;
    case 'Data / BI':
      return `${meaning} framed as reporting, dashboarding, analytical monitoring, and decision support`;
    case 'Procurement / Supply Chain':
      return `${meaning} framed as procurement control, material visibility, vendor/process coordination, and supply continuity`;
    case 'Sales / Commercial':
      return `${meaning} framed as commercial execution, stakeholder communication, and customer/business growth support`;
    case 'Marketing / Brand':
      return `${meaning} framed as campaign coordination, audience insight, communication quality, and brand execution support`;
    case 'Technical / IT':
      return `${meaning} framed as systems thinking, workflow automation, data handling, and technical execution`;
    case 'Consulting':
      return `${meaning} framed as structured problem solving, process diagnosis, stakeholder alignment, and measurable business impact`;
    default:
      return `${meaning} framed as operations coordination, process improvement, and business execution`;
  }
}

function buildEvidenceMappings(evidences: CvEvidenceInput[], roleDna: RoleDnaClassification): EvidenceRoleMapping[] {
  return evidences.slice(0, 18).map((evidence) => ({
    evidenceId: evidence.evidenceId || evidence.id || 'UNKNOWN',
    rawEvidence: [evidence.title, evidence.organization, evidence.description].filter(Boolean).join(' | '),
    businessMeaning: businessMeaningForEvidence(evidence),
    roleRelevantWording: roleRelevantWordingForEvidence(evidence, roleDna),
    targetCvSection: targetSectionForEvidence(evidence)
  }));
}

function certificationPriority(roleDna: RoleDnaClassification, text: string) {
  const priorities: string[] = [];
  if (roleDna.primaryDirection === 'Generalist Leadership Program' && (text.includes('bflp') || text.includes('odp') || text.includes('future leader') || text.includes('management trainee') || text.includes('graduate program'))) {
    return [
      'English Proficiency Test Score Record',
      'Gemini Certified Faculty',
      'The Complete Financial Analyst Course',
      'Microsoft Excel Beginner & Advanced'
    ];
  }
  if (text.includes('english') || text.includes('toefl') || text.includes('ielts')) priorities.push('English score / certification');
  if (roleDna.primaryDirection === 'Finance / Banking' || text.includes('bank') || text.includes('finance')) priorities.push('Financial Analyst course', 'Capital Market achievements');
  if (roleDna.primaryDirection === 'Data / BI' || text.includes('dashboard') || text.includes('reporting')) priorities.push('Excel / Google Sheets / dashboarding');
  if (text.includes('digital') || text.includes('automation') || text.includes('ai ')) priorities.push('Gemini / AI workflow evidence');
  priorities.push('Most role-relevant verified certification first');
  return unique(priorities);
}

function evidenceIncludes(evidence: CvEvidenceInput, keywords: string[]) {
  const text = lowerText(evidence.evidenceId, evidence.category, evidence.title, evidence.organization, evidence.description);
  return keywords.some((keyword) => text.includes(keyword));
}

function compactProfile(profile: unknown) {
  const source = (profile && typeof profile === 'object') ? profile as Record<string, unknown> : {};
  return {
    fullName: source.fullName || '',
    education: source.education || '',
    graduationDate: source.graduationDate || '',
    gpa: source.gpa || '',
    workExperienceCount: source.workExperienceCount || '',
    experienceBrief: source.experienceBrief || '',
    targetRoles: source.targetRoles || '',
    preferredLocations: source.preferredLocations || '',
    portfolioWording: source.portfolioWording || ''
  };
}

function compactEvidence(evidence: CvEvidenceInput) {
  return {
    id: evidence.id || '',
    evidenceId: evidence.evidenceId || evidence.id || '',
    category: evidence.category || '',
    title: evidence.title || '',
    organization: evidence.organization || '',
    description: String(evidence.description || '').replace(/\s+/g, ' ').trim().slice(0, 420),
    isVerified: evidence.isVerified === true
  };
}

function scoreEvidenceForJob(evidence: CvEvidenceInput, jobText: string, roleDna: RoleDnaClassification) {
  const text = lowerText(evidence.evidenceId, evidence.category, evidence.title, evidence.organization, evidence.description);
  let score = evidence.isVerified === true ? 10 : -20;
  const mustKeep = /(english|toefl|ielts|toeic|gpa|ipk|degree|bachelor|cert|course|excel|gemini|financial analyst)/i;
  if (mustKeep.test(text)) score += 35;
  roleDna.hardSkillSignals.concat(roleDna.functionSignals, roleDna.industrySignals, roleDna.eligibilitySignals).forEach((signal) => {
    signal.toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length > 3).forEach((part) => {
      if (text.includes(part) || jobText.includes(part)) score += text.includes(part) ? 7 : 0;
    });
  });
  if (roleDna.primaryDirection === 'Generalist Leadership Program' && /(english|gemini|financial analyst|excel|operations|dashboard|automation)/i.test(text)) score += 18;
  if (roleDna.primaryDirection === 'Data / BI' && /(excel|dashboard|reporting|transaction|data|google sheets)/i.test(text)) score += 18;
  if (roleDna.primaryDirection === 'Finance / Banking' && /(financial|capital market|banking|english|excel)/i.test(text)) score += 18;
  if (roleDna.primaryDirection === 'Business / Operations' && /(operations|coordination|document|material|process|stakeholder)/i.test(text)) score += 18;
  return score;
}

function selectRelevantEvidencesForPrompt(evidences: CvEvidenceInput[], jobText: string, roleDna: RoleDnaClassification, maxItems = MAX_EVIDENCE_ITEMS_PER_CALL) {
  const deduped = new Map<string, CvEvidenceInput>();
  evidences.forEach((evidence) => {
    const key = lowerText(evidence.evidenceId || evidence.id, evidence.title, evidence.organization).replace(/\s+/g, ' ').trim();
    if (key && !deduped.has(key)) deduped.set(key, evidence);
  });

  return Array.from(deduped.values())
    .map((evidence) => ({ evidence, score: scoreEvidenceForJob(evidence, jobText, roleDna) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxItems)
    .map(({ evidence }) => compactEvidence(evidence));
}

function compactChecklistRows(checklists: ChecklistInput[] = [], maxItems = 10) {
  return checklists
    .filter((item) => item.isReadyToCopy !== false && item.isStale !== true && item.finalSuggestedText)
    .slice(0, maxItems)
    .map((item) => ({
      id: item.id || '',
      cvSection: item.cvSection || '',
      evidenceId: item.evidenceId || '',
      priority: item.priority || '',
      finalSuggestedText: String(item.finalSuggestedText || '').slice(0, 500)
    }));
}

function capJobText(jobText: unknown, maxChars = MAX_JOB_TEXT_CHARS) {
  return String(jobText || '').slice(0, maxChars);
}

function compactCvTailoringFrameworkForPrompt(framework: CvTailoringFramework, mode: 'standard' | 'compact') {
  const mappingLimit = mode === 'compact' ? 8 : 14;
  return {
    roleDna: {
      direction: framework.roleDna.primaryDirection,
      level: framework.roleDna.seniorityLevel,
      risks: framework.roleDna.avoidOverclaimRisks
    },
    cvBaseVersion: framework.cvBaseVersion,
    evidenceMappings: framework.evidenceMappings.slice(0, mappingLimit).map((item) => ({
      evidenceId: item.evidenceId,
      targetCvSection: item.targetCvSection
    })),
    certificationPriority: framework.certificationPriority
  };
}

function profileText(profile: unknown) {
  if (!profile || typeof profile !== 'object') return '';
  return lowerText(...Object.values(profile as Record<string, unknown>));
}

function detectEligibilityRequirementLabels(text: string) {
  const labels: string[] = [];
  if (/(toefl|ielts|toeic|english|bahasa inggris)/i.test(text)) labels.push('English score / TOEFL');
  if (/(gpa|ipk|grade point|minimum\s+3\.)/i.test(text)) labels.push('GPA');
  if (/(bachelor|s1|degree|major|jurusan|management|business|finance|engineering)/i.test(text)) labels.push('Degree / major');
  if (/(age|usia|max(?:imum)?\s+\d{2}\s+years)/i.test(text)) labels.push('Age');
  if (/(placement|relocate|willing to be placed|bersedia ditempatkan)/i.test(text)) labels.push('Placement willingness');
  if (/(certification|certificate|sertifikat|certified)/i.test(text)) labels.push('Certifications');
  if (/(excel|google sheets|dashboard|reporting|analytics|sql|power bi|tableau|ai|automation|gemini)/i.test(text)) labels.push('Required tools / skills');
  return unique(labels);
}

function formatEvidenceLabel(evidence: CvEvidenceInput) {
  return [evidence.title, evidence.organization, evidence.description]
    .filter(Boolean)
    .join(' - ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildPromotionRow(input: {
  requirement: string;
  evidence: CvEvidenceInput;
  cvSection: string;
  finalSuggestedText: string;
  reason: string;
}): ChecklistInput {
  return {
    id: `promotion-${input.requirement.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${input.evidence.evidenceId || input.evidence.id || 'unknown'}`,
    cvSection: input.cvSection,
    editType: `Add/promote ${input.requirement}`,
    sourceEvidence: formatEvidenceLabel(input.evidence),
    finalSuggestedText: input.finalSuggestedText,
    whyTheChangeMatters: input.reason,
    priority: 'High',
    evidenceId: input.evidence.evidenceId || input.evidence.id || '',
    isReadyToCopy: true,
    isStale: false
  };
}

function buildQualificationPromotions(input: {
  profile?: unknown;
  jobText: string;
  roleDna: RoleDnaClassification;
  verifiedEvidences: CvEvidenceInput[];
}) {
  const text = input.jobText;
  const profile = profileText(input.profile);
  const promotions: ChecklistInput[] = [];

  const englishEvidence = input.verifiedEvidences.find((evidence) =>
    evidenceIncludes(evidence, ['english', 'toefl', 'ielts', 'toeic', 'proficiency'])
  );
  if (detectEligibilityRequirementLabels(text).includes('English score / TOEFL') && englishEvidence) {
    promotions.push(buildPromotionRow({
      requirement: 'English score / TOEFL',
      evidence: englishEvidence,
      cvSection: 'Certifications',
      finalSuggestedText: `${englishEvidence.title}${englishEvidence.description ? ` - ${englishEvidence.description}` : ''}`,
      reason: 'Directly satisfies an English proficiency eligibility requirement, so it should be placed first in Certifications.'
    }));
  }

  if (detectEligibilityRequirementLabels(text).includes('GPA') && /gpa|ipk|3\.\d+/.test(profile)) {
    const profileEvidence: CvEvidenceInput = {
      evidenceId: 'PROFILE-GPA',
      title: 'Academic GPA',
      description: String((input.profile as Record<string, unknown> | undefined)?.gpa || 'GPA recorded in profile'),
      isVerified: true
    };
    promotions.push(buildPromotionRow({
      requirement: 'GPA',
      evidence: profileEvidence,
      cvSection: 'Education',
      finalSuggestedText: `Include GPA ${profileEvidence.description} clearly in the Education section.`,
      reason: 'Directly satisfies an academic eligibility requirement.'
    }));
  }

  if (detectEligibilityRequirementLabels(text).includes('Degree / major') && profile) {
    const profileEvidence: CvEvidenceInput = {
      evidenceId: 'PROFILE-EDU',
      title: 'Degree / Major',
      description: String((input.profile as Record<string, unknown> | undefined)?.education || 'Education recorded in profile'),
      isVerified: true
    };
    promotions.push(buildPromotionRow({
      requirement: 'Degree / major',
      evidence: profileEvidence,
      cvSection: 'Education',
      finalSuggestedText: `Keep degree and major visible in Education: ${profileEvidence.description}.`,
      reason: 'Directly addresses degree or major eligibility screening.'
    }));
  }

  const financeEvidence = input.verifiedEvidences.find((evidence) =>
    evidenceIncludes(evidence, ['financial analyst', 'capital market', 'finance', 'banking'])
  );
  if ((input.roleDna.primaryDirection === 'Finance / Banking' || lowerText(text).includes('bank') || lowerText(text).includes('finance')) && financeEvidence) {
    promotions.push(buildPromotionRow({
      requirement: 'Finance / banking relevance',
      evidence: financeEvidence,
      cvSection: evidenceIncludes(financeEvidence, ['course', 'certification', 'certificate']) ? 'Certifications' : 'Achievements',
      finalSuggestedText: `${financeEvidence.title}${financeEvidence.description ? ` - ${financeEvidence.description}` : ''}`,
      reason: 'Strengthens financial services interest and business analysis readiness for banking or finance screening.'
    }));
  }

  const dataEvidence = input.verifiedEvidences.find((evidence) =>
    evidenceIncludes(evidence, ['excel', 'google sheets', 'dashboard', 'reporting', 'analytics', 'transaction'])
  );
  if ((input.roleDna.primaryDirection === 'Data / BI' || /data|dashboard|reporting|analytics|excel|google sheets/i.test(text)) && dataEvidence) {
    promotions.push(buildPromotionRow({
      requirement: 'Data / reporting capability',
      evidence: dataEvidence,
      cvSection: evidenceIncludes(dataEvidence, ['course', 'certification', 'certificate']) ? 'Certifications' : 'Work Experience',
      finalSuggestedText: `${dataEvidence.title}${dataEvidence.description ? ` - ${dataEvidence.description}` : ''}`,
      reason: 'Directly supports reporting, dashboarding, and data-driven monitoring requirements.'
    }));
  }

  const aiEvidence = input.verifiedEvidences.find((evidence) =>
    evidenceIncludes(evidence, ['ai workflow', 'automation', 'gemini', 'artificial intelligence'])
  );
  if (/ai|digital|automation|innovation|transformation/i.test(text) && aiEvidence) {
    promotions.push(buildPromotionRow({
      requirement: 'AI / digital innovation',
      evidence: aiEvidence,
      cvSection: evidenceIncludes(aiEvidence, ['course', 'certification', 'certificate']) ? 'Certifications' : 'Project / Portfolio',
      finalSuggestedText: `${aiEvidence.title}${aiEvidence.description ? ` - ${aiEvidence.description}` : ''}`,
      reason: 'Shows digital innovation and process improvement evidence while keeping wording business-readable for non-technical roles.'
    }));
  }

  return Array.from(new Map(promotions.map((item) => [`${item.cvSection}-${item.evidenceId}`, item])).values());
}

function isProfessionalSummaryRow(item: ChecklistInput) {
  const section = lowerText(item.cvSection, item.editType);
  return section.includes('professional summary') || section.includes('profile summary') || section === 'summary';
}

function isGroundedSummary(value: string | undefined, profile: unknown, verifiedEvidences: CvEvidenceInput[]) {
  const text = String(value || '').trim();
  if (text.length < 45 || text.includes('[Needs verified input]')) return false;
  const groundingTokens = [
    ...String((profile as Record<string, unknown> | undefined)?.education || '').split(/\W+/),
    ...verifiedEvidences.flatMap((evidence) => [
      evidence.evidenceId || '',
      evidence.organization || '',
      evidence.title || ''
    ].join(' ').split(/\W+/))
  ]
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 4);
  return /\d/.test(text) || groundingTokens.some((token) => text.toLowerCase().includes(token));
}

function selectProfessionalSummarySource(input: {
  profile?: unknown;
  pack?: { summaryRewrite?: string };
  checklists?: ChecklistInput[];
  verifiedEvidences: CvEvidenceInput[];
}) {
  const readySummary = (Array.isArray(input.checklists) ? input.checklists : [])
    .filter((item) => item.isReadyToCopy !== false && item.isStale !== true && item.finalSuggestedText && isProfessionalSummaryRow(item))
    .sort((a, b) => (a.priority === 'High' ? -1 : 1) - (b.priority === 'High' ? -1 : 1))[0];

  if (readySummary?.finalSuggestedText) {
    return {
      summarySource: 'checklist' as const,
      selectedSummary: readySummary.finalSuggestedText
    };
  }

  if (isGroundedSummary(input.pack?.summaryRewrite, input.profile, input.verifiedEvidences)) {
    return {
      summarySource: 'application_pack' as const,
      selectedSummary: input.pack?.summaryRewrite?.trim()
    };
  }

  return {
    summarySource: 'fallback_generated' as const,
    selectedSummary: ''
  };
}

function evidenceScore(value: string) {
  return value.match(/\b(5\d{2}|6\d{2}|7\d{2}|8\d{2}|9\d{2})\b/)?.[1] || '';
}

function evidenceYear(value: string) {
  return value.match(/\b(20\d{2})\b/)?.[1] || '';
}

function normalizeKeyPart(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function certificationKind(evidence: CvEvidenceInput) {
  const text = lowerText(evidence.evidenceId, evidence.category, evidence.title, evidence.organization, evidence.description);
  if (/(english|toefl|ielts|toeic|proficiency)/i.test(text)) return 'english';
  if (text.includes('gemini') || text.includes('google certified faculty')) return 'gemini';
  if (text.includes('financial analyst')) return 'financial_analyst';
  if (text.includes('excel')) return 'excel';
  if (isTrueCredentialEvidence(evidence)) return 'credential';
  return 'unknown';
}

function certificationText(evidence: CvEvidenceInput, compressed = false) {
  const kind = certificationKind(evidence);
  const title = String(evidence.title || '').trim();
  const org = String(evidence.organization || '').trim();
  const description = String(evidence.description || '').replace(/\s+/g, ' ').trim();
  const source = [title, org, description].filter(Boolean).join(' ');
  const year = evidenceYear(source);

  if (kind === 'english') {
    const score = evidenceScore(source) || '527';
    const level = /advanced/i.test(source) ? ' / Advanced' : '';
    const issuer = org || 'Universitas Negeri Malang';
    if (compressed) return `English Proficiency Test ${score}${level} – ${issuer}`;
    return `English Proficiency Test Score Record – ${score}${level}, ${issuer}${year ? ` – ${year}` : ''}`;
  }

  if (kind === 'gemini') {
    if (compressed) return 'Gemini Certified Faculty – Google';
    return `Gemini Certified Faculty, Google${year ? ` – ${year}` : ''}`;
  }

  if (kind === 'financial_analyst') {
    if (compressed) return 'Financial Analyst Course – Udemy';
    return `The Complete Financial Analyst Course, Udemy${year ? ` – ${year}` : ''}`;
  }

  if (kind === 'excel') {
    if (compressed) return 'Microsoft Excel – Coursera';
    return `Microsoft Excel (Beginner & Advanced), Coursera${year ? ` – ${year}` : ''}`;
  }

  if (compressed) return [title, org].filter(Boolean).join(' – ').replace(/\s+/g, ' ').trim();
  return [title, org || description].filter(Boolean).join(', ').replace(/\s+/g, ' ').trim();
}

function findEvidenceByKeywords(evidences: CvEvidenceInput[], keywords: string[]) {
  return evidences.find((evidence) => evidenceIncludes(evidence, keywords));
}

function isRejectedCertificationSection(evidence: CvEvidenceInput) {
  return evidenceIncludes(evidence, [
    'competition',
    'achievement',
    'award',
    'winner',
    'finalist',
    'project',
    'portfolio',
    'work experience',
    'internship',
    'employment',
    'job',
    'case competition',
    'capital market competition'
  ]);
}

function isTrueCredentialEvidence(evidence: CvEvidenceInput) {
  const category = normalizeKeyPart(evidence.category);
  const text = lowerText(evidence.evidenceId, evidence.title, evidence.organization, evidence.description);
  const categoryLooksCredential = /(cert|course|language|credential|license|training)/i.test(category);
  const textLooksCredential = [
    'cert',
    'certificate',
    'certification',
    'course',
    'training',
    'license',
    'credential',
    'toefl',
    'ielts',
    'toeic',
    'english proficiency',
    'excel',
    'gemini',
    'financial analyst'
  ].some((keyword) => text.includes(keyword));

  return (categoryLooksCredential || textLooksCredential) && !isRejectedCertificationSection(evidence);
}

function certificationDedupeKey(evidence: CvEvidenceInput) {
  const source = [evidence.title, evidence.organization, evidence.description].filter(Boolean).join(' ');
  const kind = certificationKind(evidence);
  const score = evidenceScore(source);
  const year = evidenceYear(source);
  const org = normalizeKeyPart(evidence.organization);
  if (['english', 'gemini', 'financial_analyst', 'excel'].includes(kind)) {
    return [kind, org, score, year].filter(Boolean).join('|');
  }
  const title = normalizeKeyPart(evidence.title)
    .replace(/\bscore record\b/g, '')
    .replace(/\bbeginner advanced\b/g, 'beginner and advanced')
    .replace(/\bthe complete\b/g, '')
    .trim();

  return [kind, title, org, score, year].filter(Boolean).join('|');
}

function certificationPriorityForKind(kind: string, roleDna: RoleDnaClassification, jobText: string) {
  const isMtLike = roleDna.primaryDirection === 'Generalist Leadership Program'
    || /bflp|odp|management trainee|future leader|graduate program|business enabler/i.test(jobText);
  const hasEnglishRequirement = /english|toefl|ielts|toeic/i.test(jobText);
  const hasDigitalSignal = /ai|digital|automation|gemini/i.test(jobText);
  const hasFinanceSignal = roleDna.primaryDirection === 'Finance / Banking' || /bank|finance|financial/i.test(jobText);
  const hasDataSignal = roleDna.primaryDirection === 'Data / BI' || /excel|google sheets|dashboard|reporting|business analysis|data/i.test(jobText);

  if (kind === 'english') return hasEnglishRequirement || isMtLike ? 10 : 65;
  if (kind === 'gemini') return hasDigitalSignal || isMtLike ? 20 : 70;
  if (kind === 'financial_analyst') return hasFinanceSignal || isMtLike ? 30 : 75;
  if (kind === 'excel') return hasDataSignal || isMtLike ? 40 : 80;
  return 90;
}

function certificationSelectionReason(kind: string, priority: number) {
  if (kind === 'english') {
    return priority <= 10
      ? 'Directly satisfies English/TOEFL eligibility or MT/BFLP screening requirement.'
      : 'Verified English credential retained as supporting proof.';
  }
  if (kind === 'gemini') return 'Supports digital, AI, or automation readiness without over-technical wording.';
  if (kind === 'financial_analyst') return 'Supports finance/banking relevance and analytical business readiness.';
  if (kind === 'excel') return 'Supports reporting, dashboarding, and business analysis requirements.';
  return 'Verified certification retained as supporting credential.';
}

function planCertificationEvidence(
  roleDna: RoleDnaClassification,
  jobText: string,
  verifiedEvidences: CvEvidenceInput[]
): {
  candidates: CertificationCandidateAudit[];
  selected: CertificationEvidenceSelection[];
  finalList: string[];
  finalString: string;
  compressionMode: boolean;
} {
  const acceptedByKey = new Map<string, CertificationCandidateAudit>();
  const candidates: CertificationCandidateAudit[] = [];

  verifiedEvidences.forEach((evidence) => {
    const kind = certificationKind(evidence);
    const key = certificationDedupeKey(evidence);
    const baseCandidate: CertificationCandidateAudit = {
      evidenceId: evidence.evidenceId || evidence.id || 'UNKNOWN',
      title: String(evidence.title || ''),
      organization: evidence.organization,
      category: evidence.category,
      source: 'evidence_bank',
      status: 'rejected',
      deduplicationKey: key
    };

    if (isRejectedCertificationSection(evidence)) {
      candidates.push({
        ...baseCandidate,
        rejectionReason: 'Evidence is an achievement, competition, project, portfolio item, or work experience; route to Achievements/Experience instead.'
      });
      return;
    }

    if (!isTrueCredentialEvidence(evidence)) {
      candidates.push({
        ...baseCandidate,
        rejectionReason: 'Evidence is not a true certification, course, language credential, license, or training record.'
      });
      return;
    }

    const priority = certificationPriorityForKind(kind, roleDna, jobText);
    const accepted: CertificationCandidateAudit = {
      ...baseCandidate,
      status: 'accepted',
      priority,
      finalText: certificationText(evidence)
    };
    const existing = acceptedByKey.get(key);
    if (existing) {
      candidates.push({
        ...baseCandidate,
        rejectionReason: `Duplicate certification evidence already accepted from ${existing.evidenceId}.`
      });
      return;
    }

    acceptedByKey.set(key, accepted);
    candidates.push(accepted);
  });

  const accepted = Array.from(acceptedByKey.values())
    .sort((a, b) => (a.priority || 99) - (b.priority || 99))
    .slice(0, 8);
  const longList = accepted.map((item) => item.finalText || '').filter(Boolean);
  const longString = longList.join(' | ');
  const compressionMode = longString.length > 210 || wordCount(longString) > 30;
  const finalList = accepted
    .map((item) => {
      const evidence = verifiedEvidences.find((candidate) => (candidate.evidenceId || candidate.id || 'UNKNOWN') === item.evidenceId);
      return evidence ? certificationText(evidence, compressionMode) : item.finalText || '';
    })
    .filter(Boolean);

  return {
    candidates,
    selected: accepted.map((item, index) => ({
      evidenceId: item.evidenceId,
      title: item.title,
      reason: certificationSelectionReason(certificationKind(verifiedEvidences.find((candidate) => (candidate.evidenceId || candidate.id || 'UNKNOWN') === item.evidenceId) || {}), item.priority || 99),
      priority: item.priority || 99,
      finalText: finalList[index] || item.finalText || ''
    })),
    finalList,
    finalString: finalList.join(' | '),
    compressionMode
  };
}

function recommendedCertificationBullets(roleDna: RoleDnaClassification, jobText: string, verifiedEvidences: CvEvidenceInput[]) {
  return planCertificationEvidence(roleDna, jobText, verifiedEvidences).finalList;
}

function buildCvTailoringFramework(input: {
  profile?: unknown;
  pack?: { summaryRewrite?: string };
  opportunity?: { company?: string; role?: string; jobText?: string; roleDna?: string };
  jobText?: string;
  evidences?: CvEvidenceInput[];
  checklists?: ChecklistInput[];
}) {
  const text = lowerText(input.opportunity?.company, input.opportunity?.role, input.opportunity?.jobText, input.opportunity?.roleDna, input.jobText);
  const allEvidences = Array.isArray(input.evidences) ? input.evidences : [];
  const verifiedEvidences = allEvidences.filter((evidence) => evidence.isVerified === true);
  const ignoredUnverifiedEvidenceIds = allEvidences
    .filter((evidence) => evidence.isVerified !== true)
    .map((evidence) => evidence.evidenceId || evidence.id || 'UNKNOWN');
  const roleDna = classifyRoleDna(text);
  const evidenceMappings = buildEvidenceMappings(verifiedEvidences, roleDna);
  const qualificationPromotions = buildQualificationPromotions({
    profile: input.profile,
    jobText: text,
    roleDna,
    verifiedEvidences
  });
  const summarySelection = selectProfessionalSummarySource({
    profile: input.profile,
    pack: input.pack,
    checklists: input.checklists,
    verifiedEvidences
  });
  const certificationPlan = planCertificationEvidence(roleDna, text, verifiedEvidences);
  const checklistPool = [...qualificationPromotions, ...(Array.isArray(input.checklists) ? input.checklists : [])];
  const readyChecklistRowsUsed = checklistPool
    .filter((item) => item.isReadyToCopy !== false && item.isStale !== true && item.finalSuggestedText)
    .slice(0, 12)
    .map((item) => ({
      id: item.id || '',
      cvSection: item.cvSection || '',
      evidenceId: item.evidenceId || '',
      finalSuggestedText: item.finalSuggestedText || ''
    }));
  const hasEnglishRequirement = detectEligibilityRequirementLabels(text).includes('English score / TOEFL');
  const englishEvidence = findEvidenceByKeywords(verifiedEvidences, ['english', 'toefl', 'ielts', 'toeic', 'proficiency']);

  return {
    roleDna,
    cvBaseVersion: recommendCvBaseVersion(roleDna, text),
    evidenceMappings,
    qualificationPromotions,
    certificationPriority: certificationPriority(roleDna, text),
    rawCertificationCandidates: certificationPlan.candidates,
    certificationEvidenceSelected: certificationPlan.selected,
    finalSelectedCertificationList: certificationPlan.finalList,
    finalCertificationStringLength: certificationPlan.finalString.length,
    onePageCompressionMode: certificationPlan.compressionMode,
    noiseReductionRules: roleDna.avoidOverclaimRisks,
    summarySource: summarySelection.summarySource,
    selectedSummary: summarySelection.selectedSummary,
    verifiedEvidenceCount: verifiedEvidences.length,
    ignoredUnverifiedEvidenceIds,
    readyChecklistRowsUsed,
    evidenceIdsUsed: unique(evidenceMappings.map((item) => item.evidenceId)),
    englishEvidenceWarning: hasEnglishRequirement && !englishEvidence
      ? 'English score evidence not found. Add it to Evidence Bank to satisfy TOEFL requirement.'
      : undefined,
    qualityWarnings: [
      'One-page CV target enabled: keep summary, bullets, certifications, and skills compact.',
      'Fresh-graduate risk guard enabled: avoid seniority, executive stakeholder, or overclaimed leadership wording.'
    ]
  } satisfies CvTailoringFramework;
}

const cvFieldLimits: Record<string, number> = {
  professionalSummary: 85,
  workExperienceSection: 220,
  organizationalExperienceSection: 160,
  projectSection: 160,
  certificationSection: 70,
  achievementSection: 80,
  skillsSection: 70,
  experience1Title: 12,
  experience1Organization: 12,
  experience1Date: 10,
  experience1Bullet1: 28,
  experience1Bullet2: 28,
  experience1Bullet3: 28,
  experience2Title: 12,
  experience2Organization: 12,
  experience2Date: 10,
  experience2Bullet1: 28,
  experience2Bullet2: 28,
  experience2Bullet3: 28,
  project1Title: 12,
  project1Bullet1: 32,
  project2Title: 12,
  project2Bullet1: 32,
  project3Title: 12,
  project3Bullet1: 32,
  certifications: 80,
  achievementBullet1: 22,
  achievementBullet2: 22,
  achievementBullet3: 22,
  hardSkills: 45,
  softSkills: 30,
  languages: 18
};

function usableCvValue(value: unknown, warning: string) {
  const cleaned = String(value || '').trim();
  return cleaned && cleaned !== warning;
}

function sectionLinesFromNumberedFields(
  fields: Record<string, string>,
  prefix: string,
  slotCount: number,
  bulletCount: number,
  warning: string
) {
  const lines: string[] = [];
  for (let slot = 1; slot <= slotCount; slot += 1) {
    const title = fields[`${prefix}${slot}Title`];
    const organization = fields[`${prefix}${slot}Organization`];
    const date = fields[`${prefix}${slot}Date`];
    const heading = [title, organization, date].filter((item) => usableCvValue(item, warning)).join(' | ');
    const bullets: string[] = [];
    for (let bulletIndex = 1; bulletIndex <= bulletCount; bulletIndex += 1) {
      const bullet = fields[`${prefix}${slot}Bullet${bulletIndex}`];
      if (usableCvValue(bullet, warning)) bullets.push(`- ${bullet}`);
    }
    if (heading || bullets.length > 0) {
      if (heading) lines.push(heading);
      lines.push(...bullets);
      lines.push('');
    }
  }
  return lines.join('\n').trim();
}

function sectionLinesFromBullets(fields: Record<string, string>, prefix: string, count: number, warning: string) {
  const lines: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    const value = fields[`${prefix}${index}`];
    if (usableCvValue(value, warning)) lines.push(`- ${value}`);
  }
  return lines.join('\n').trim();
}

function estimateOnePageRisk(fields: Record<string, string>) {
  const totalWords = Object.values(fields).reduce((sum, value) => sum + wordCount(value), 0);
  const longFields = Object.entries(fields)
    .filter(([key, value]) => (cvFieldLimits[key] || 32) < wordCount(value))
    .map(([key]) => key);

  if (totalWords > 430 || longFields.length > 0) {
    return `Likely over one page: ${totalWords} estimated words${longFields.length ? `; long fields: ${longFields.join(', ')}` : ''}.`;
  }

  return '';
}

function normalizeGeneratedCvFields(
  input: Record<string, string>,
  certificationBullets: string[],
  warning: string
) {
  const normalized: Record<string, string> = {};
  Object.entries(input).forEach(([key, value]) => {
    let nextValue = softenRiskyLanguage(value);

    if (key === 'professionalSummary') {
      nextValue = limitWords(nextValue, 85);
    } else if (key.startsWith('project') && key.includes('Bullet')) {
      nextValue = limitWords(nextValue, 32);
    } else if (key.startsWith('experience') && key.includes('Bullet')) {
      nextValue = limitWords(nextValue, 28);
    } else if (key.startsWith('experience') || key.startsWith('project')) {
      nextValue = limitWords(nextValue, cvFieldLimits[key] || 12);
    } else if (key.startsWith('achievementBullet')) {
      nextValue = limitWords(nextValue, 22);
    } else if (key === 'hardSkills' || key === 'softSkills' || key === 'languages') {
      nextValue = compactPipeList(nextValue);
    }

    normalized[key] = nextValue || warning;
  });

  const dynamicCertifications = certificationBullets
    .map((item) => softenRiskyLanguage(item))
    .filter(Boolean)
    .join(' | ');
  normalized.certifications = dynamicCertifications || normalized.certifications || warning;

  certificationBullets.slice(0, 8).forEach((item, index) => {
    if (item) {
      normalized[`certificationBullet${index + 1}`] = softenRiskyLanguage(item);
    }
  });

  normalized.workExperienceSection = usableCvValue(normalized.workExperienceSection, warning)
    ? normalized.workExperienceSection
    : sectionLinesFromNumberedFields(normalized, 'experience', 4, 5, warning) || warning;
  normalized.organizationalExperienceSection = usableCvValue(normalized.organizationalExperienceSection, warning)
    ? normalized.organizationalExperienceSection
    : sectionLinesFromNumberedFields(normalized, 'organization', 3, 5, warning) || warning;
  normalized.projectSection = usableCvValue(normalized.projectSection, warning)
    ? normalized.projectSection
    : sectionLinesFromNumberedFields(normalized, 'project', 4, 5, warning) || warning;
  normalized.certificationSection = usableCvValue(normalized.certificationSection, warning)
    ? normalized.certificationSection
    : (certificationBullets.length ? certificationBullets.map((item) => `- ${softenRiskyLanguage(item)}`).join('\n') : sectionLinesFromBullets(normalized, 'certificationBullet', 8, warning)) || warning;
  normalized.achievementSection = usableCvValue(normalized.achievementSection, warning)
    ? normalized.achievementSection
    : sectionLinesFromBullets(normalized, 'achievementBullet', 5, warning) || warning;
  normalized.skillsSection = usableCvValue(normalized.skillsSection, warning)
    ? normalized.skillsSection
    : [
      usableCvValue(normalized.hardSkills, warning) ? `Hard Skills: ${normalized.hardSkills}` : '',
      usableCvValue(normalized.softSkills, warning) ? `Soft Skills: ${normalized.softSkills}` : '',
      usableCvValue(normalized.languages, warning) ? `Languages: ${normalized.languages}` : ''
    ].filter(Boolean).join('\n') || warning;

  return normalized;
}

// Health Check API
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/api/ai-usage-log', (req, res) => {
  res.json({ entries: aiUsageLog });
});

app.get('/api/ai-cost-config', (req, res) => {
  const today = todayKey();
  res.json({
    model: GEMINI_MODEL,
    maxAiCallsPerJobWorkflow: MAX_AI_CALLS_PER_JOB_WORKFLOW,
    maxInputCharsPerCall: MAX_INPUT_CHARS_PER_CALL,
    maxEvidenceItemsPerCall: MAX_EVIDENCE_ITEMS_PER_CALL,
    maxAnalyzeEvidenceItemsPerCall: MAX_ANALYZE_EVIDENCE_ITEMS_PER_CALL,
    dailyAiCallLimitDev: DAILY_AI_CALL_LIMIT_DEV,
    dailyAiCallsUsed: dailyAiCalls.get(today) || 0,
    requireConfirmForRegenerate: REQUIRE_CONFIRM_FOR_REGENERATE,
    requiresUserGeminiApiKey: String(process.env.ALLOW_SERVER_GEMINI_KEY_PUBLIC || 'false') !== 'true',
    maxJobTextChars: MAX_JOB_TEXT_CHARS,
    tokenEstimateRule: 'chars / 4 when SDK token usage is unavailable'
  });
});

type CvSourceType = 'google_docs' | 'pdf' | 'docx';
const MAX_CV_UPLOAD_BYTES = Number(process.env.MAX_CV_UPLOAD_BYTES || 4 * 1024 * 1024);
const MAX_CV_TEXT_CHARS = Number(process.env.MAX_CV_TEXT_CHARS || 22000);

function normalizeExtractedText(value: unknown) {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_CV_TEXT_CHARS);
}

function stripXml(value: string) {
  return value
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractDocxText(buffer: Buffer) {
  const eocdSignature = 0x06054b50;
  let eocdOffset = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 66000); index -= 1) {
    if (buffer.readUInt32LE(index) === eocdSignature) {
      eocdOffset = index;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('DOCX parser could not find ZIP directory.');

  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  let offset = centralDirectoryOffset;
  const end = centralDirectoryOffset + centralDirectorySize;

  while (offset < end) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.slice(offset + 46, offset + 46 + fileNameLength).toString('utf8');

    if (fileName === 'word/document.xml') {
      const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.slice(dataStart, dataStart + compressedSize);
      const xmlBuffer = compressionMethod === 8
        ? zlib.inflateRawSync(compressed)
        : compressionMethod === 0
          ? compressed
          : Buffer.alloc(uncompressedSize);
      return normalizeExtractedText(stripXml(xmlBuffer.toString('utf8')));
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  throw new Error('DOCX parser could not find word/document.xml.');
}

function extractPdfText(buffer: Buffer) {
  const latin = buffer.toString('latin1');
  const strings = Array.from(latin.matchAll(/\(([^()]{2,300})\)/g))
    .map((match) => match[1])
    .join('\n');
  const readableRuns = latin
    .replace(/[^\x20-\x7E\n\r\t]+/g, ' ')
    .split(/\s{2,}/)
    .filter((item) => /[A-Za-z]{3,}/.test(item) && item.length < 500)
    .join('\n');
  const text = normalizeExtractedText(`${strings}\n${readableRuns}`);
  if (text.length < 80) {
    throw new Error('PDF text could not be extracted. Try exporting the CV to DOCX or Google Docs.');
  }
  return text;
}

function extractGoogleDocText(document: Record<string, unknown>) {
  const parts: string[] = [];

  function walk(node: unknown) {
    if (!node || typeof node !== 'object') return;
    const item = node as Record<string, unknown>;

    const textRun = item.textRun as { content?: string } | undefined;
    if (textRun?.content) parts.push(textRun.content);

    const paragraph = item.paragraph as { elements?: unknown[] } | undefined;
    paragraph?.elements?.forEach(walk);

    const table = item.table as { tableRows?: unknown[] } | undefined;
    table?.tableRows?.forEach(walk);

    const tableRow = item.tableRow as { tableCells?: unknown[] } | undefined;
    tableRow?.tableCells?.forEach(walk);

    const tableCell = item.tableCell as { content?: unknown[] } | undefined;
    tableCell?.content?.forEach(walk);

    const header = item.header as { content?: unknown[] } | undefined;
    header?.content?.forEach(walk);

    const footer = item.footer as { content?: unknown[] } | undefined;
    footer?.content?.forEach(walk);

    const content = item.content as unknown[] | undefined;
    content?.forEach(walk);
  }

  walk((document.body as { content?: unknown[] } | undefined) || {});
  const headers = document.headers as Record<string, unknown> | undefined;
  Object.values(headers || {}).forEach(walk);
  const footers = document.footers as Record<string, unknown> | undefined;
  Object.values(footers || {}).forEach(walk);

  return normalizeExtractedText(parts.join(''));
}

const ONBOARDING_CATEGORIES = [
  'Work Achievement',
  'Academic Honor',
  'Organizational Experience',
  'Side Project / Portfolio',
  'Certification',
  'Hard Skill / Technical Fact',
  'Other Highlight'
];

function normalizeEvidenceCategory(value: unknown) {
  const raw = String(value || '').toLowerCase();
  if (/cert|toefl|license|licence|course|training/.test(raw)) return 'Certification';
  if (/academic|award|honou?r|competition|finalist|winner|place|rank/.test(raw)) return 'Academic Honor';
  if (/organization|organisational|organizational|committee|club|student leadership|bem|senat|himpunan|osis|panitia|campus leadership/.test(raw)) return 'Organizational Experience';
  if (/project|portfolio|volunteer|community/.test(raw)) return 'Side Project / Portfolio';
  if (/skill|technical|tool|software|language/.test(raw)) return 'Hard Skill / Technical Fact';
  if (/work|intern|job|employee|business|sales|operation/.test(raw)) return 'Work Achievement';
  return ONBOARDING_CATEGORIES.includes(String(value || '')) ? String(value) : 'Other Highlight';
}

function evidenceDraftKey(value: Record<string, unknown>) {
  return [
    normalizeEvidenceCategory(value.category),
    value.sourceGroup,
    value.title,
    value.organization,
    value.sourceSection,
    value.description
  ].map((item) => String(item || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).join('|');
}

function normalizeOnboardingResult(value: Record<string, unknown>) {
  const seen = new Set<string>();
  const evidenceDrafts = Array.isArray(value.evidenceDrafts) ? value.evidenceDrafts : [];
  return {
    ...value,
    evidenceDrafts: evidenceDrafts
      .map((draft) => {
        const item = (draft || {}) as Record<string, unknown>;
        return {
          ...item,
          category: normalizeEvidenceCategory(item.category),
      title: String(item.title || '').trim(),
      organization: String(item.organization || '').trim(),
      description: String(item.description || '').trim(),
      sourceGroup: String(item.sourceGroup || '').trim(),
      sourceSection: String(item.sourceSection || '').trim(),
      confidence: Number(item.confidence || 0),
          inferredSkillTags: Array.isArray(item.inferredSkillTags)
            ? item.inferredSkillTags.map((tag) => String(tag || '').trim()).filter(Boolean).slice(0, 8)
            : []
        };
      })
      .filter((draft) => draft.title && draft.description)
      .filter((draft) => {
        const key = evidenceDraftKey(draft);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
  };
}

async function googleFetchJson(url: string, accessToken: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  });
  if (!response.ok) {
    const message = await response.text().catch(() => '');
    throw new Error(`Google API request failed (${response.status}): ${message || response.statusText}`);
  }
  return response.json();
}

function placeholderTemplateText(fields: Record<string, string>, sourceName: string) {
  return `{{FULL_NAME}}
{{CONTACT_LINE}}
{{TARGET_TITLE}}
{{PROFESSIONAL_SUMMARY}}

EDUCATION
{{EDUCATION}}

WORK EXPERIENCE
{{WORK_EXPERIENCE_SECTION}}

ORGANIZATIONAL EXPERIENCE
{{ORGANIZATIONAL_EXPERIENCE_SECTION}}

PROJECT / PORTFOLIO / VOLUNTEERING
{{PROJECT_SECTION}}

CERTIFICATIONS
{{CERTIFICATION_SECTION}}

ACHIEVEMENTS
{{ACHIEVEMENT_SECTION}}

SKILLS & LANGUAGES
{{SKILLS_SECTION}}

NUMBERED PLACEHOLDERS FOR CUSTOM LAYOUTS
Work: {{EXPERIENCE_1_TITLE}} | {{EXPERIENCE_1_ORGANIZATION}} | {{EXPERIENCE_1_DATE}} | {{EXPERIENCE_1_BULLET_1}} | {{EXPERIENCE_1_BULLET_2}} | {{EXPERIENCE_1_BULLET_3}} | {{EXPERIENCE_1_BULLET_4}} | {{EXPERIENCE_1_BULLET_5}}
Organization: {{ORGANIZATION_1_TITLE}} | {{ORGANIZATION_1_ORGANIZATION}} | {{ORGANIZATION_1_DATE}} | {{ORGANIZATION_1_BULLET_1}} | {{ORGANIZATION_1_BULLET_2}} | {{ORGANIZATION_1_BULLET_3}} | {{ORGANIZATION_1_BULLET_4}} | {{ORGANIZATION_1_BULLET_5}}
Project: {{PROJECT_1_TITLE}} | {{PROJECT_1_BULLET_1}} | {{PROJECT_1_BULLET_2}} | {{PROJECT_1_BULLET_3}} | {{PROJECT_1_BULLET_4}} | {{PROJECT_1_BULLET_5}}
Certification bullets: {{CERTIFICATION_BULLET_1}} | {{CERTIFICATION_BULLET_2}} | {{CERTIFICATION_BULLET_3}} | {{CERTIFICATION_BULLET_4}} | {{CERTIFICATION_BULLET_5}} | {{CERTIFICATION_BULLET_6}} | {{CERTIFICATION_BULLET_7}} | {{CERTIFICATION_BULLET_8}}
Achievement bullets: {{ACHIEVEMENT_BULLET_1}} | {{ACHIEVEMENT_BULLET_2}} | {{ACHIEVEMENT_BULLET_3}} | {{ACHIEVEMENT_BULLET_4}} | {{ACHIEVEMENT_BULLET_5}}

Source: ${sourceName || 'CareerRadar CV onboarding'}`;
}

function placeholderTemplateRequests(fields: Record<string, string>, sourceName: string) {
  return [{
    insertText: {
      location: { index: 1 },
      text: placeholderTemplateText(fields, sourceName || '')
    }
  }];
}

function isPreserveSourceFormattingRequested(value: unknown) {
  return value === true || value === 'true' || value === 'preserve';
}

function onboardingSchema() {
  const evidenceDraft = {
    type: Type.OBJECT,
    properties: {
      category: { type: Type.STRING },
      title: { type: Type.STRING },
      organization: { type: Type.STRING },
      description: { type: Type.STRING },
      sourceGroup: { type: Type.STRING },
      sourceSection: { type: Type.STRING },
      confidence: { type: Type.NUMBER },
      inferredSkillTags: {
        type: Type.ARRAY,
        items: { type: Type.STRING }
      }
    },
    required: ['category', 'title', 'organization', 'description', 'sourceGroup', 'sourceSection', 'confidence', 'inferredSkillTags']
  };
  const stringField = { type: Type.STRING } as const;
  const templateFieldProperties: Record<string, { type: Type.STRING }> = {
    fullName: stringField,
    contactLine: stringField,
    targetTitle: stringField,
    professionalSummary: stringField,
    education: stringField,
    workExperienceSection: stringField,
    organizationalExperienceSection: stringField,
    projectSection: stringField,
    certificationSection: stringField,
    achievementSection: stringField,
    skillsSection: stringField,
    certifications: stringField,
    hardSkills: stringField,
    softSkills: stringField,
    languages: stringField
  };
  for (let slot = 1; slot <= 4; slot += 1) {
    templateFieldProperties[`experience${slot}Title`] = stringField;
    templateFieldProperties[`experience${slot}Organization`] = stringField;
    templateFieldProperties[`experience${slot}Date`] = stringField;
    for (let bullet = 1; bullet <= 5; bullet += 1) {
      templateFieldProperties[`experience${slot}Bullet${bullet}`] = stringField;
    }
  }
  for (let slot = 1; slot <= 3; slot += 1) {
    templateFieldProperties[`organization${slot}Title`] = stringField;
    templateFieldProperties[`organization${slot}Organization`] = stringField;
    templateFieldProperties[`organization${slot}Date`] = stringField;
    for (let bullet = 1; bullet <= 5; bullet += 1) {
      templateFieldProperties[`organization${slot}Bullet${bullet}`] = stringField;
    }
  }
  for (let slot = 1; slot <= 4; slot += 1) {
    templateFieldProperties[`project${slot}Title`] = stringField;
    for (let bullet = 1; bullet <= 5; bullet += 1) {
      templateFieldProperties[`project${slot}Bullet${bullet}`] = stringField;
    }
  }
  for (let bullet = 1; bullet <= 8; bullet += 1) {
    templateFieldProperties[`certificationBullet${bullet}`] = stringField;
  }
  for (let bullet = 1; bullet <= 5; bullet += 1) {
    templateFieldProperties[`achievementBullet${bullet}`] = stringField;
  }

  return {
    type: Type.OBJECT,
    properties: {
      profileDraft: {
        type: Type.OBJECT,
        properties: {
          fullName: { type: Type.STRING },
          contactLine: { type: Type.STRING },
          education: { type: Type.STRING },
          professionalSummary: { type: Type.STRING },
          hardSkills: { type: Type.STRING },
          softSkills: { type: Type.STRING },
          languages: { type: Type.STRING }
        },
        required: ['fullName', 'contactLine', 'education', 'professionalSummary', 'hardSkills', 'softSkills', 'languages']
      },
      templateFields: {
        type: Type.OBJECT,
        properties: templateFieldProperties,
        required: ['fullName', 'contactLine', 'targetTitle', 'professionalSummary', 'education', 'workExperienceSection', 'organizationalExperienceSection', 'projectSection', 'certificationSection', 'achievementSection', 'skillsSection', 'hardSkills', 'softSkills', 'languages']
      },
      evidenceDrafts: {
        type: Type.ARRAY,
        items: evidenceDraft
      },
      mappingWarnings: {
        type: Type.ARRAY,
        items: { type: Type.STRING }
      }
    },
    required: ['profileDraft', 'templateFields', 'evidenceDrafts', 'mappingWarnings']
  };
}

// Cost Protection Rate Limiter: Max 3 requests per minute per IP for cost-intensive matching
const analyzeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 3, // Limit each IP to 3 requests per minute
  standardHeaders: true, // Return rate limit info in standard headers
  legacyHeaders: false, // Turn off X-RateLimit legacy headers
  message: {
    error: 'Batas kuota terlampaui. Anda hanya dapat melakukan analisis lowongan maksimal 3 kali per menit untuk mengamankan kuota gratis Anda.'
  }
});

app.post('/api/parse-cv-source', analyzeLimiter, async (req, res) => {
  try {
    const {
      sourceType,
      accessToken,
      googleDocUrl,
      documentId,
      fileName,
      mimeType,
      fileBase64
    } = req.body || {};
    const resolvedSourceType = sourceType as CvSourceType;

    if (resolvedSourceType === 'google_docs') {
      const docId = String(documentId || googleDocUrl || '').match(/\/document\/d\/([a-zA-Z0-9_-]+)/)?.[1]
        || String(documentId || googleDocUrl || '').match(/[?&]id=([a-zA-Z0-9_-]+)/)?.[1]
        || String(documentId || googleDocUrl || '').trim();
      if (!accessToken || !docId) {
        res.status(400).json({ error: 'Google Docs source requires Drive/Docs access and a document link.' });
        return;
      }
      const document = await googleFetchJson(`https://docs.googleapis.com/v1/documents/${docId}`, accessToken);
      const parsedText = extractGoogleDocText(document);
      if (!parsedText) throw new Error('No readable text found in Google Docs CV.');
      res.json({
        sourceType: resolvedSourceType,
        sourceName: document.title || fileName || 'Google Docs CV',
        sourceDocumentId: docId,
        parsedText,
        parsedTextCharacterCount: parsedText.length,
        warnings: []
      });
      return;
    }

    if (resolvedSourceType === 'pdf' || resolvedSourceType === 'docx') {
      if (!fileBase64) {
        res.status(400).json({ error: 'Uploaded CV file payload is required.' });
        return;
      }
      const buffer = Buffer.from(String(fileBase64), 'base64');
      if (buffer.length > MAX_CV_UPLOAD_BYTES) {
        res.status(400).json({ error: `CV file is too large. Max ${Math.round(MAX_CV_UPLOAD_BYTES / 1024 / 1024)}MB.` });
        return;
      }
      const parsedText = resolvedSourceType === 'docx'
        ? extractDocxText(buffer)
        : extractPdfText(buffer);
      res.json({
        sourceType: resolvedSourceType,
        sourceName: fileName || (resolvedSourceType === 'pdf' ? 'Uploaded CV.pdf' : 'Uploaded CV.docx'),
        mimeType: mimeType || '',
        parsedText,
        parsedTextCharacterCount: parsedText.length,
        warnings: resolvedSourceType === 'pdf'
          ? ['PDF extraction is best-effort. If text looks incomplete, use DOCX or Google Docs.']
          : []
      });
      return;
    }

    res.status(400).json({ error: 'Unsupported CV source type.' });
  } catch (error) {
    console.error('CV source parse error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/generate-cv-onboarding', analyzeLimiter, async (req, res) => {
  const startedAt = Date.now();
  let inputCharacterCount = JSON.stringify(req.body || {}).length;

  try {
    const { parsedText, sourceName } = req.body || {};
    const text = normalizeExtractedText(parsedText);
    if (text.length < 80) {
      res.status(400).json({ error: 'CV text is too short to analyze. Try another file or Google Docs source.' });
      return;
    }

    const prompt = `
You are a strict CV onboarding parser for CareerRadar AI. Return JSON only.

Task:
- Convert the user's existing CV text into generic CareerRadar placeholders.
- Extract evidence suggestions as DRAFTS for user review.
- Extract name and contact line exactly as present. If contact is split across phone/email/linkedin, join with " | ".
- Do not invent facts, metrics, dates, employers, education, certifications, or skills.
- If a value is missing or unclear, return "[Needs verified input]".
- Evidence drafts must be based only on text present in the CV.
- Evidence drafts are not verified. Use conservative wording and confidence 0-1.
- Evidence draft category must be one of: Work Achievement, Academic Honor, Organizational Experience, Side Project / Portfolio, Certification, Hard Skill / Technical Fact, Other Highlight.
- Each evidence draft must represent exactly one CV claim or one CV bullet.
- Do not combine multiple bullets, responsibilities, metrics, tools, awards, certificates, or outcomes in one evidence draft.
- If one role has three useful bullets, return three evidence drafts with the same organization but different claim titles and descriptions.
- For sourceGroup, use the source CV item that groups related claims, such as "Rima Synergy Global - Social Media Specialist" or "Meraciklatte - Marketing Officer". Keep the same sourceGroup for multiple bullets from the same role/project/certificate.
- For sourceSection, use the broader CV section name, such as "Work Experience", "Education", "Organization", or "Skills".
- Do not create evidence drafts only for job title, organization, or date unless that field itself is a verifiable qualification.
- Use general claim titles that a non-technical user can understand, such as "Monthly content production" or "E-commerce campaign monitoring".
- Do not infer business impact. If the CV says "closed IDR 12 million in deals", do not add "contributed to revenue growth" unless that exact causal claim appears.
- Prefer wording that stays close to the original CV text, with light cleanup only.
- Avoid creating two evidence drafts for the same exact fact, certificate, award, or bullet. Multiple different bullets from the same role are allowed and expected.

Source name: ${sourceName || 'Uploaded CV'}

Generic placeholder rules:
- Use experience1 through experience4 for formal work or internship items when the source CV has them.
- Use organization1 through organization3 for student organizations, committees, clubs, campus leadership, and non-employment leadership.
- Use project1/project2/project3/project4 for strongest project, portfolio, volunteering, community, or event items.
- Also return dynamic plain-text sections when enough evidence exists: workExperienceSection, organizationalExperienceSection, projectSection, certificationSection, achievementSection, and skillsSection.
- Keep bullets one sentence and concise.
- Certifications must contain only real certificates, courses, licenses, or language scores.
- Achievements contain awards, competitions, and measurable extracurricular outcomes.
- If the original CV has bullet-list certifications, split them into certificationBullet1 through certificationBullet8 and certificationSection. Do not collapse distinct credentials into one certification bullet.

CV text:
${text}
`;
    inputCharacterCount = prompt.length;
    assertCostGuard(inputCharacterCount, { allowInputOverride: true });
    const ai = getGenAIClient(getRequestGeminiApiKey(req));
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: onboardingSchema()
      }
    });

    const parsedData = normalizeOnboardingResult(JSON.parse(response.text || '{}')) as Record<string, any>;
    const templateFieldCount = Object.values(parsedData.templateFields || {})
      .filter((value) => String(value || '').trim())
      .length;
    const evidenceDraftCount = Array.isArray(parsedData.evidenceDrafts) ? parsedData.evidenceDrafts.length : 0;
    if (templateFieldCount === 0 && evidenceDraftCount === 0) {
      throw new Error('Gemini returned an empty CV onboarding mapping. Please retry Generate mapping, or use DOCX/PDF source if the Google Docs text extraction looks unusual.');
    }
    const outputCharacterCount = response.text?.length || JSON.stringify(parsedData).length;
    recordAiUsage({
      featureName: 'Generate CV Onboarding',
      endpointName: '/api/generate-cv-onboarding',
      model: GEMINI_MODEL,
      inputCharacterCount,
      outputCharacterCount,
      durationMs: Date.now() - startedAt,
      cacheStatus: 'miss',
      ...tokenUsageFromResponse(response, inputCharacterCount, outputCharacterCount),
      status: 'success'
    });
    res.json(parsedData);
  } catch (error) {
    console.error('CV onboarding generation error:', error);
    recordAiUsage({
      featureName: 'Generate CV Onboarding',
      endpointName: '/api/generate-cv-onboarding',
      model: GEMINI_MODEL,
      inputCharacterCount,
      outputCharacterCount: 0,
      estimatedInputTokens: estimateTokensFromChars(inputCharacterCount),
      estimatedOutputTokens: 0,
      estimatedTotalTokens: estimateTokensFromChars(inputCharacterCount),
      tokenCountSource: 'estimated',
      durationMs: Date.now() - startedAt,
      cacheStatus: 'blocked',
      status: 'error',
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

function fieldKeyToPlaceholder(key: string) {
  return `{{${key.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/([a-zA-Z])(\d)/g, '$1_$2').toUpperCase()}}}`;
}

function sourceValuePlaceholderPairs(templateFields: Record<string, string>) {
  const pairs: [string, string][] = Object.entries(templateFields || {})
    .map(([key, value]) => [String(value || ''), fieldKeyToPlaceholder(key)] as [string, string]);
  const seen = new Set<string>();
  return pairs
    .map(([value, placeholder]) => [String(value || '').trim(), placeholder] as [string, string])
    .filter(([value]) => value && value !== '[Needs verified input]' && value.length >= 8)
    .sort((a, b) => b[0].length - a[0].length)
    .filter(([value]) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

app.post('/api/create-placeholder-template', analyzeLimiter, async (req, res) => {
  try {
    const { accessToken, sourceType, sourceDocumentId, sourceName, templateFields, preserveSourceFormatting } = req.body || {};
    if (!accessToken || !templateFields) {
      res.status(400).json({ error: 'Google Drive access and template fields are required.' });
      return;
    }

    let documentId = '';
    let name = `CareerRadar Placeholder Template - ${sourceName || 'CV'}`;
    let webViewLink = '';
    const usePreserveSourceFormatting = sourceType === 'google_docs'
      && sourceDocumentId
      && isPreserveSourceFormattingRequested(preserveSourceFormatting);

    if (usePreserveSourceFormatting) {
      const copied = await googleFetchJson(
        `https://www.googleapis.com/drive/v3/files/${sourceDocumentId}/copy?fields=id,name,webViewLink`,
        accessToken,
        {
          method: 'POST',
          body: JSON.stringify({ name })
        }
      ) as { id: string; name: string; webViewLink?: string };
      documentId = copied.id;
      name = copied.name;
      webViewLink = copied.webViewLink || `https://docs.google.com/document/d/${documentId}/edit`;

      const pairs = sourceValuePlaceholderPairs(templateFields);
      if (pairs.length > 0) {
        await googleFetchJson(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, accessToken, {
          method: 'POST',
          body: JSON.stringify({
            requests: pairs.map(([text, placeholder]) => ({
              replaceAllText: {
                containsText: { text, matchCase: false },
                replaceText: placeholder
              }
            }))
          })
        });
      }
    } else {
      const created = await googleFetchJson('https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink', accessToken, {
        method: 'POST',
        body: JSON.stringify({
          name,
          mimeType: 'application/vnd.google-apps.document'
        })
      }) as { id: string; name: string; webViewLink?: string };
      documentId = created.id;
      name = created.name;
      webViewLink = created.webViewLink || `https://docs.google.com/document/d/${documentId}/edit`;

      await googleFetchJson(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, accessToken, {
        method: 'POST',
        body: JSON.stringify({
          requests: placeholderTemplateRequests(templateFields, sourceName || '')
        })
      });
    }

    res.json({
      id: documentId,
      name,
      webViewLink,
      templateMode: usePreserveSourceFormatting ? 'preserve_source_best_effort' : 'normalized_ats',
      warnings: usePreserveSourceFormatting
        ? ['Source formatting preservation is best-effort and may miss text split across Google Docs elements.']
        : ['Created a normalized ATS placeholder template so every required placeholder is present.']
    });
  } catch (error) {
    console.error('Create placeholder template error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/extract-job-screenshot', analyzeLimiter, async (req, res) => {
  let inputCharacterCount = JSON.stringify(req.body || {}).length;
  const startedAt = Date.now();

  try {
    const { imageBase64, mimeType, fileName } = req.body || {};
    const resolvedMimeType = String(mimeType || '').trim().toLowerCase();
    if (!imageBase64 || !/^image\/(png|jpe?g|webp)$/.test(resolvedMimeType)) {
      res.status(400).json({ error: 'Upload a PNG, JPG, JPEG, or WEBP job description screenshot.' });
      return;
    }

    const normalizedBase64 = String(imageBase64).replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '').trim();
    const imageBuffer = Buffer.from(normalizedBase64, 'base64');
    if (!imageBuffer.length) {
      res.status(400).json({ error: 'Screenshot image payload is empty or unreadable.' });
      return;
    }
    if (imageBuffer.length > MAX_JOB_SCREENSHOT_BYTES) {
      res.status(400).json({ error: `Screenshot is too large. Max ${Math.round(MAX_JOB_SCREENSHOT_BYTES / 1024 / 1024)}MB.` });
      return;
    }
    const requestGeminiApiKey = getRequestGeminiApiKey(req);
    if (!requestGeminiApiKey) {
      res.status(400).json({ error: 'Gemini API key required. Add your own key in AI Settings before extracting a job screenshot.' });
      return;
    }

    const prompt = `Extract the job posting text from this screenshot for a job-search assistant.

Rules:
- Return only visible text from the screenshot.
- Preserve role requirements, qualifications, responsibilities, company, location, deadline, and application instructions when visible.
- Do not invent missing text.
- If the screenshot is cropped or unclear, include that in sourceNotes.
- If company or role is not visible, return an empty string for that field.
- Keep jobText readable for a human to review before analysis.

File name: ${String(fileName || 'job-screenshot').slice(0, 120)}`;

    // Replace base64 string character count with static charge of 258 tokens (equivalent to 1032 characters)
    inputCharacterCount = prompt.length + 1032;
    assertCostGuard(prompt.length, { allowInputOverride: true });
    const ai = getGenAIClient(requestGeminiApiKey);
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        { text: prompt },
        {
          inlineData: {
            data: normalizedBase64,
            mimeType: resolvedMimeType
          }
        }
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            jobText: { type: Type.STRING, description: 'Readable job posting text extracted from the screenshot.' },
            company: { type: Type.STRING, description: 'Company name visible in the screenshot, or empty string.' },
            role: { type: Type.STRING, description: 'Role title visible in the screenshot, or empty string.' },
            sourceNotes: { type: Type.STRING, description: 'Short note about OCR quality, cropped content, or missing visible fields.' },
            confidence: { type: Type.NUMBER, description: 'Extraction confidence from 0 to 1.' }
          },
          required: ['jobText', 'company', 'role', 'sourceNotes', 'confidence']
        }
      }
    });

    const parsedData = JSON.parse(response.text || '{}');
    const outputCharacterCount = response.text?.length || JSON.stringify(parsedData).length;
    recordAiUsage({
      featureName: 'Extract Job Screenshot',
      endpointName: '/api/extract-job-screenshot',
      model: GEMINI_MODEL,
      inputCharacterCount,
      outputCharacterCount,
      durationMs: Date.now() - startedAt,
      cacheStatus: 'miss',
      ...tokenUsageFromResponse(response, inputCharacterCount, outputCharacterCount),
      status: 'success'
    });
    res.json({
      jobText: String(parsedData.jobText || '').slice(0, MAX_JOB_TEXT_CHARS),
      company: String(parsedData.company || ''),
      role: String(parsedData.role || ''),
      sourceNotes: String(parsedData.sourceNotes || ''),
      confidence: Number(parsedData.confidence || 0),
      fileName: fileName || 'job-screenshot',
      imageBytes: imageBuffer.length,
      jobTextWasTruncated: String(parsedData.jobText || '').length > MAX_JOB_TEXT_CHARS
    });
  } catch (error) {
    console.error('Job screenshot extraction error:', error);
    recordAiUsage({
      featureName: 'Extract Job Screenshot',
      endpointName: '/api/extract-job-screenshot',
      model: GEMINI_MODEL,
      inputCharacterCount,
      outputCharacterCount: 0,
      estimatedInputTokens: estimateTokensFromChars(inputCharacterCount),
      estimatedOutputTokens: 0,
      estimatedTotalTokens: estimateTokensFromChars(inputCharacterCount),
      tokenCountSource: 'estimated',
      durationMs: Date.now() - startedAt,
      cacheStatus: 'blocked',
      status: 'error',
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

interface AnalyzePromptDiagnostics {
  inputCharacterCount: number;
  jobTextChars: number;
  profileContextChars: number;
  selectedEvidenceChars: number;
  frameworkChars: number;
  instructionTemplateChars: number;
  totalPromptChars: number;
  selectedEvidenceCount: number;
  selectedEvidenceIds: string[];
  fullEvidenceBankCount: number;
  jobTextWasTruncated: boolean;
  maxInputCharsPerCall: number;
  maxEvidenceItemsPerCall: number;
  promptBudgetStatus: 'ok' | 'over_limit';
  largestSections: { label: string; chars: number }[];
}

function buildAnalyzeJobPrompt(jobText: unknown, profile: unknown, evidences: unknown) {
  const cappedJobText = capJobText(jobText);
  const allEvidences = Array.isArray(evidences) ? evidences : [];
  const preRoleDna = classifyRoleDna(lowerText(cappedJobText));
  const promptEvidences = selectRelevantEvidencesForPrompt(
    allEvidences,
    lowerText(cappedJobText),
    preRoleDna,
    MAX_ANALYZE_EVIDENCE_ITEMS_PER_CALL
  );
  const compactRequestContext = {
    jobText: cappedJobText,
    profile: compactProfile(profile),
    evidences: promptEvidences
  };
  const cacheKey = `analyze:${hashPayload(compactRequestContext)}`;
  const cvTailoringFramework = compactCvTailoringFrameworkForPrompt(
    buildCvTailoringFramework({ jobText: cappedJobText, profile, evidences: allEvidences }),
    'compact'
  );

  const profileJson = JSON.stringify(compactRequestContext.profile);
  const evidenceJson = JSON.stringify(promptEvidences);
  const frameworkJson = JSON.stringify(cvTailoringFramework);
  const instructionTemplate = `You are a highly analytical AI talent matcher and strategic resume advisor. Your task is to perform an exhaustive, objective comparison between a candidate's portfolio/evidence bank (the ground truth facts) and a specific job description.

Candidate Profile:
${profileJson}

Top Relevant Candidate CV Evidence Bank (compact, deduped, capped at ${MAX_ANALYZE_EVIDENCE_ITEMS_PER_CALL} items):
${evidenceJson}

Target Job Description:
${cappedJobText}

Reusable CV Tailoring Framework:
${frameworkJson}

INSTRUCTIONS:
0. Extract the target company name and role/title from the job description when present.
1. Conduct a rigorous, human-grade, zero-inflation gap analysis. Evaluate the alignment of education, academic score, years of experience, core technologies, and specialized achievements.
2. Formulate a final "match quality" score (fitScore) between 0 and 100 based on criteria fulfillment, and choose an actionable recommendation decision:
   - "Apply Now": Highly optimized match (fitScore >= 85).
   - "Apply After CV Adjustment": Strong baseline match, but custom section overrides are critical to show exact grounding (fitScore 65-84).
   - "Save for Later": Decent peripheral alignment or stretch role (fitScore 50-64).
   - "Skip": Fatal mismatch/red flag triggers present (fitScore < 50).
   - "Verify First": Ambiguous details or requires verifying certification/gaps.
3. Align CV Checklist suggestions STRICTLY with the candidate's existing background. If a checklist item is suggested, it MUST show how to contextualize, reword, or rewrite a section using actual evidence item IDs from the database, or generic optimization when no specific evidence matches. DO NOT invent entirely fake credentials or skills the candidate does not have.
4. Draft a highly compelling Application Pack tailored to the target role:
   - Write a refined summary introduction ("summaryRewrite") specific to the hiring firm.
   - Compose a brilliant, tailored outreach pitch / cover letter ("coverMessage").
   - Compose a modern, highly targeted cold LinkedIn recruiter message ("linkedinMessage").
5. Use the framework's role DNA, CV base version, evidence-to-role mappings, certification priority, and noise reduction rules when generating checklist and application pack content.
6. When writing work-experience checklist text, use this bullet formula: action verb + scope/scale + method + business outcome.
7. For non-technical business roles, translate technical work into business meaning instead of listing excessive tool stacks.`;

  const prompt = `\n${instructionTemplate}\n`;
  const sectionCounts = [
    { label: 'job description', chars: cappedJobText.length },
    { label: 'compact candidate profile', chars: profileJson.length },
    { label: 'selected evidence', chars: evidenceJson.length },
    { label: 'compact CV tailoring framework', chars: frameworkJson.length },
    {
      label: 'prompt instructions/template',
      chars: Math.max(0, prompt.length - cappedJobText.length - profileJson.length - evidenceJson.length - frameworkJson.length)
    }
  ];
  const diagnostics: AnalyzePromptDiagnostics = {
    inputCharacterCount: prompt.length,
    jobTextChars: cappedJobText.length,
    profileContextChars: profileJson.length,
    selectedEvidenceChars: evidenceJson.length,
    frameworkChars: frameworkJson.length,
    instructionTemplateChars: sectionCounts[4].chars,
    totalPromptChars: prompt.length,
    selectedEvidenceCount: promptEvidences.length,
    selectedEvidenceIds: promptEvidences
      .map((evidence) => evidence.evidenceId || evidence.id || evidence.title)
      .filter((value): value is string => Boolean(value)),
    fullEvidenceBankCount: allEvidences.length,
    jobTextWasTruncated: String(jobText || '').length > cappedJobText.length,
    maxInputCharsPerCall: MAX_INPUT_CHARS_PER_CALL,
    maxEvidenceItemsPerCall: MAX_ANALYZE_EVIDENCE_ITEMS_PER_CALL,
    promptBudgetStatus: prompt.length > MAX_INPUT_CHARS_PER_CALL ? 'over_limit' : 'ok',
    largestSections: sectionCounts.sort((a, b) => b.chars - a.chars)
  };

  return {
    prompt,
    cappedJobText,
    allEvidences,
    promptEvidences,
    compactRequestContext,
    cacheKey,
    cvTailoringFramework,
    diagnostics
  };
}

// Career Radar Job Match Analyzer Endpoint
app.post('/api/analyze-job', analyzeLimiter, async (req, res) => {
  let inputCharacterCount = JSON.stringify(req.body || {}).length;
  let logCompany = '';
  let logRole = '';
  let analyzeDiagnostics: AnalyzePromptDiagnostics | null = null;
  const startedAt = Date.now();

  try {
    const { jobText, profile, evidences, dryRun, useCachedOutput } = req.body;

    if (!jobText) {
      res.status(400).json({ error: 'Job description text is required' });
      return;
    }

    const promptBundle = buildAnalyzeJobPrompt(jobText, profile, evidences);
    const {
      prompt,
      cappedJobText,
      allEvidences,
      promptEvidences,
      compactRequestContext,
      cacheKey,
      diagnostics
    } = promptBundle;
    inputCharacterCount = diagnostics.inputCharacterCount;
    analyzeDiagnostics = diagnostics;
    const cachedOutputExists = aiResponseCache.has(cacheKey);

    if (!dryRun && useCachedOutput && cachedOutputExists) {
      const cached = aiResponseCache.get(cacheKey);
      recordAnalyzeJobUsage(
        'success',
        JSON.stringify(compactRequestContext).length,
        JSON.stringify(cached || {}).length,
        Date.now() - startedAt,
        (cached as { company?: string })?.company,
        (cached as { role?: string })?.role,
        undefined,
        'hit'
      );
      res.json({ ...(cached as object), cacheStatus: 'hit' });
      return;
    }

    const dryRunPayload = {
      dryRun: true,
      endpointName: '/api/analyze-job',
      featureNames: ['Analyze Job Fit', 'Generate Application Pack', 'Generate CV Checklist'],
      expectedAiCalls: useCachedOutput && cachedOutputExists ? 0 : 1,
      model: GEMINI_MODEL,
      inputCharacterCount,
      estimatedInputTokens: estimateTokensFromChars(inputCharacterCount),
      selectedEvidenceCount: promptEvidences.length,
      selectedEvidenceIds: promptEvidences.map((evidence) => evidence.evidenceId || evidence.id || evidence.title).filter(Boolean),
      maxEvidenceItemsPerCall: MAX_ANALYZE_EVIDENCE_ITEMS_PER_CALL,
      fullEvidenceBankCount: allEvidences.length,
      jobTextWasTruncated: String(jobText).length > cappedJobText.length,
      payloadDiagnostics: diagnostics,
      cachedOutputExists,
      cacheStatus: cachedOutputExists ? 'hit' : 'miss',
      dryRunEnabled: Boolean(dryRun),
      useCachedOutputEnabled: Boolean(useCachedOutput),
      contextSent: [
        'capped job description',
        'compact candidate profile',
        `top ${promptEvidences.length} ranked evidence items`,
        'compact role DNA and CV section rules',
        'application pack/checklist generation instructions'
      ],
      contextExcludedOrReduced: [
        String(jobText).length > cappedJobText.length ? 'job description truncated to configured cap' : 'full job description kept within cap',
        allEvidences.length > promptEvidences.length ? `${allEvidences.length - promptEvidences.length} lower-ranked evidence items excluded` : 'no evidence items excluded by cap',
        'CV tailoring framework compacted before prompt',
        'Firestore debug/status data excluded',
        'existing generated application packs/checklists excluded from job analysis prompt'
      ],
      warning: cachedOutputExists && useCachedOutput
        ? 'No AI call will be made if you run with cached output enabled.'
        : diagnostics.promptBudgetStatus === 'over_limit'
          ? `Preview mode only. This prompt would be blocked because ${diagnostics.inputCharacterCount.toLocaleString()} chars exceeds ${MAX_INPUT_CHARS_PER_CALL.toLocaleString()}.`
          : 'Preview mode only. No Gemini call was made.',
      cacheKey,
      promptPreview: prompt.slice(0, 6000)
    };

    if (dryRun) {
      recordAnalyzeJobUsage(
        'success',
        inputCharacterCount,
        JSON.stringify(dryRunPayload).length,
        Date.now() - startedAt,
        logCompany,
        logRole,
        undefined,
        'dry_run'
      );
      res.json(dryRunPayload);
      return;
    }

    const ai = getGenAIClient(getRequestGeminiApiKey(req));
    assertCostGuard(inputCharacterCount);
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            company: { type: Type.STRING, description: 'Target company name extracted from the job description, or Unknown Company.' },
            role: { type: Type.STRING, description: 'Target role/title extracted from the job description, or Tailored Opportunity.' },
            fitScore: { type: Type.INTEGER, description: 'Match score between 0 and 100 based on profile and evidence alignment.' },
            decision: {
              type: Type.STRING,
              enum: ['Apply Now', 'Apply After CV Adjustment', 'Save for Later', 'Skip', 'Verify First'],
              description: 'Operational action decision.'
            },
            analysisNotes: { type: Type.STRING, description: 'Synthesis of alignment, gaps, strengths, and rationale.' },
            roleDna: { type: Type.STRING, description: 'Core requirements extracted from job text (technologies, experience, level).' },
            educationFit: { type: Type.STRING, description: 'Candidate education compared to requirements.' },
            experienceFit: { type: Type.STRING, description: 'Years / context profile of candidate experience against expectations.' },
            portfolioFit: { type: Type.STRING, description: 'Matching of specific items from the candidate evidence bank.' },
            hasRedFlags: { type: Type.BOOLEAN, description: 'Whether significant gaps or explicit dealbreakers were found.' },
            redFlags: { type: Type.STRING, description: 'Details of any found red flags or missing hard criteria.' },
            isStretchRole: { type: Type.BOOLEAN, description: 'Whether the role is a highly competitive career-growth stretch.' },
            suggestedChecklists: {
              type: Type.ARRAY,
              description: 'List of specific customization checklists to update CV/resume sections prior to submitting.',
              items: {
                type: Type.OBJECT,
                properties: {
                  cvSection: { type: Type.STRING, description: 'Target section on resume (e.g. Work History, Projects, Skills).' },
                  editType: { type: Type.STRING, description: 'Type of change needed (e.g., Target metric, Insert tech keywords).' },
                  sourceEvidence: { type: Type.STRING, description: 'How to map the existing candidate evidence (e.g. WRK-001-001 work claim) into the rewrite.' },
                  finalSuggestedText: { type: Type.STRING, description: 'Complete high-quality tailored text block suggested for copy-pasting.' },
                  whyTheChangeMatters: { type: Type.STRING, description: 'Explanation of strategic advantage or why this keyword gets past ATS screens.' },
                  priority: { type: Type.STRING, enum: ['High', 'Medium', 'Low'], description: 'Urgency of item.' },
                  evidenceId: { type: Type.STRING, description: 'Corresponding evidenceId if mapped, or empty.' }
                },
                required: ['cvSection', 'editType', 'finalSuggestedText', 'whyTheChangeMatters', 'priority']
              }
            },
            applicationPack: {
              type: Type.OBJECT,
              properties: {
                applicationEnergy: { type: Type.STRING, enum: ['High', 'Medium', 'Lock', 'None'] },
                cvAction: { type: Type.STRING, description: 'Customization level recommendation (e.g. Core rewrite, Section adjustment).' },
                cvAngle: { type: Type.STRING, description: 'Strategic thematic hook' },
                keywordsToEmphasize: { type: Type.STRING, description: 'Comma separated list of keywords to highlight.' },
                summaryRewrite: { type: Type.STRING, description: 'Specific written tailor summary section for candidate application.' },
                bulletPrioritization: { type: Type.STRING, description: 'Detailed instruction on which bullet elements or metrics to showcase.' },
                coverMessage: { type: Type.STRING, description: 'Highly personalized pitch letter (150-250 words).' },
                linkedinMessage: { type: Type.STRING, description: 'Short custom outreach / pitch under 300 characters.' },
                portfolioEvidence: { type: Type.STRING, description: 'A brief list of evidence bank tags recommended for referencing.' }
              },
              required: ['applicationEnergy', 'cvAction', 'cvAngle', 'keywordsToEmphasize', 'summaryRewrite', 'coverMessage', 'linkedinMessage']
            }
          },
          required: [
            'company',
            'role',
            'fitScore',
            'decision',
            'analysisNotes',
            'roleDna',
            'educationFit',
            'experienceFit',
            'portfolioFit',
            'hasRedFlags',
            'isStretchRole',
            'suggestedChecklists',
            'applicationPack'
          ]
        }
      }
    });

    const parsedData = JSON.parse(response.text || '{}');
    const outputCharacterCount = response.text?.length || JSON.stringify(parsedData).length;
    logCompany = parsedData.company || '';
    logRole = parsedData.role || '';
    const finalFramework = buildCvTailoringFramework({
      jobText: cappedJobText,
      profile,
      pack: parsedData.applicationPack,
      evidences: allEvidences,
      opportunity: {
        company: logCompany,
        role: logRole,
        jobText: cappedJobText,
        roleDna: parsedData.roleDna
      },
      checklists: parsedData.suggestedChecklists || []
    });
    const existingChecklistKeys = new Set((parsedData.suggestedChecklists || []).map((item: ChecklistInput) => `${item.cvSection}-${item.evidenceId}-${item.finalSuggestedText}`));
    const promotionRows = finalFramework.qualificationPromotions.filter((item) => !existingChecklistKeys.has(`${item.cvSection}-${item.evidenceId}-${item.finalSuggestedText}`));
    parsedData.suggestedChecklists = [...promotionRows, ...(parsedData.suggestedChecklists || [])];
    parsedData.roleDnaFramework = finalFramework.roleDna;
    parsedData.cvBaseVersion = finalFramework.cvBaseVersion;
    parsedData.evidenceRoleMappings = finalFramework.evidenceMappings;
    parsedData.evidenceIdsUsed = finalFramework.evidenceIdsUsed;
    parsedData.aiCacheKey = cacheKey;
    aiResponseCache.set(cacheKey, parsedData);
    const usage = tokenUsageFromResponse(response, inputCharacterCount, outputCharacterCount);
    ['Analyze Job Fit', 'Generate Application Pack', 'Generate CV Checklist'].forEach((featureName) => {
      recordAiUsage({
        featureName,
        company: logCompany,
        role: logRole,
        endpointName: '/api/analyze-job',
        model: GEMINI_MODEL,
        inputCharacterCount,
        outputCharacterCount,
        durationMs: Date.now() - startedAt,
        cacheStatus: 'miss',
        ...usage,
        status: 'success'
      });
    });
    res.json({ ...parsedData, cacheStatus: 'miss' });
  } catch (error) {
    console.error('API Career Radar Analysis Error:', error);
    const rawErrorMessage = error instanceof Error ? error.message : String(error);
    const largestSection = analyzeDiagnostics?.largestSections?.[0];
    const errorMessage = rawErrorMessage.includes('MAX_INPUT_CHARS_PER_CALL') && largestSection
      ? `${rawErrorMessage} Largest prompt section: ${largestSection.label} (${largestSection.chars.toLocaleString()} chars). Run Dry Run to inspect the payload breakdown.`
      : rawErrorMessage;
    recordAnalyzeJobUsage(
      'error',
      inputCharacterCount,
      0,
      Date.now() - startedAt,
      logCompany,
      logRole,
      errorMessage
    );
    res.status(500).json({ error: errorMessage, payloadDiagnostics: analyzeDiagnostics || undefined });
  }
});

function classifyEvidenceSection(evidence: CvEvidenceInput): 'experience' | 'organization' | 'project' | 'certification' | 'achievement' {
  const category = evidence.category || '';
  const normalizedCategory = String(category).trim().toLowerCase();
  const title = evidence.title || '';
  const organization = evidence.organization || '';
  const description = evidence.description || '';
  const text = `${category} ${title} ${organization} ${description}`;

  if (normalizedCategory === 'work achievement') {
    return 'experience';
  }
  if (normalizedCategory === 'organizational experience') {
    return 'organization';
  }
  if (normalizedCategory === 'side project / portfolio') {
    return 'project';
  }
  if (normalizedCategory === 'academic honor') {
    return 'achievement';
  }
  if (normalizedCategory === 'certification') {
    return 'certification';
  }

  const certRegex = /cert|course|training|license|credential|toefl|ielts|toeic|proficiency/i;
  const certExcludeRegex = /competition|achievement|award|winner|finalist|project|portfolio|work experience|internship|employment|job|case competition/i;

  const achievementRegex = /achievement|competition|award|winner|finalist|champion|place|rank|pemenang|juara|lomba/i;

  const experienceRegex = /intern|work|experience|employment|job|internship|asisten|assistant|freelance|analyst|developer|engineer|staff|contract|officer/i;
  const experienceExcludeRegex = /himpunan|bem|senat|panitia|committee|club|student association|campus|university|school|osis/i;

  const orgRegex = /organization|organisational|organizational|committee|club|student leadership|bem|senat|himpunan|osis|panitia|liaison|governance|volunteer/i;

  if (certRegex.test(text) && !certExcludeRegex.test(text)) {
    return 'certification';
  }
  if (achievementRegex.test(text)) {
    return 'achievement';
  }
  if (experienceRegex.test(text) && !experienceExcludeRegex.test(text)) {
    return 'experience';
  }
  if (orgRegex.test(text)) {
    return 'organization';
  }

  // Fallbacks
  return 'project';
}

function extractDateFromText(text: string): string {
  if (!text) return '';
  const monthNames = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
  const monthNum = '(?:0[1-9]|1[0-2])';
  const month = `(?:${monthNames}|${monthNum})`;
  const year = '(?:20\\d{2}|19\\d{2}|\\d{2})';
  const monthYear = `(?:${month}\\s*[/.-]?\\s*${year})`;

  // Month-year ranges, year ranges
  const rangeRegex = new RegExp(`(${monthYear}|${year})\\s*(?:-|–|to|until|s/d|s\\.d\\.)\\s*(${monthYear}|${year}|[Pp]present|[Aa]ctive|[Cc]urrent)`, 'i');
  const matchRange = text.match(rangeRegex);
  if (matchRange) {
    return matchRange[0].trim();
  }

  // Single month-year
  const singleMonthYearRegex = new RegExp(monthYear, 'i');
  const matchSingleMonthYear = text.match(singleMonthYearRegex);
  if (matchSingleMonthYear) {
    return matchSingleMonthYear[0].trim();
  }

  // Single year
  const singleYearRegex = new RegExp(`\\b${year}\\b`);
  const matchSingleYear = text.match(singleYearRegex);
  if (matchSingleYear) {
    return matchSingleYear[0].trim();
  }

  return '';
}

function extractDateFromEvidence(evidence: CvEvidenceInput): string {
  let date = extractDateFromText(evidence.description || '');
  if (date) return date;

  date = extractDateFromText(evidence.title || '');
  if (date) return date;

  date = extractDateFromText(evidence.organization || '');
  if (date) return date;

  return '';
}

function splitIntoSentences(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const sentences: string[] = [];

  for (const line of lines) {
    let cleanedLine = line.trim();
    if (!cleanedLine) continue;

    // Ignore list bullet characters at start
    cleanedLine = cleanedLine.replace(/^[-*•\u2022\d+[.)]\]\s]+/, '').trim();
    if (!cleanedLine) continue;

    // Split by sentence boundary punctuation [.!?]
    const parts = cleanedLine.split(/[.!?]+(?:\s+|$)/);
    for (const part of parts) {
      const trimmedPart = part.trim();
      if (trimmedPart) {
        sentences.push(trimmedPart);
      }
    }
  }

  return sentences;
}

function getEvidenceBulletText(evidence: CvEvidenceInput, checklists: ChecklistInput[]): string {
  const evId = evidence.evidenceId || evidence.id;
  if (evId && Array.isArray(checklists)) {
    const matched = checklists.find(
      (item) =>
        item.evidenceId === evId &&
        item.isReadyToCopy !== false &&
        item.isStale !== true &&
        item.finalSuggestedText
    );
    if (matched) {
      return matched.finalSuggestedText || '';
    }
  }
  return evidence.description || '';
}

function buildFallbackSummary(
  profile: any,
  opportunity: any,
  hardSkills: string,
  verifiedEvidences: CvEvidenceInput[]
): string {
  const company = opportunity?.company || 'Target Company';
  const role = opportunity?.role || 'Target Role';
  const education = profile?.education || 'Relevant Fields';
  const skillsText = hardSkills ? hardSkills.split('|').map(s => s.trim()).slice(0, 4).join(', ') : 'core domain areas';

  const expCount = verifiedEvidences.filter(e => classifyEvidenceSection(e) === 'experience').length;
  const projCount = verifiedEvidences.filter(e => classifyEvidenceSection(e) === 'project').length;

  let proofPhrase = 'proven project execution';
  if (expCount > 0 && projCount > 0) {
    proofPhrase = `hands-on experience across ${expCount} professional roles and ${projCount} projects`;
  } else if (expCount > 0) {
    proofPhrase = `demonstrated professional capabilities across ${expCount} key work roles`;
  } else if (projCount > 0) {
    proofPhrase = `practical execution across ${projCount} portfolio projects`;
  }

  const summary = `A highly motivated and results-driven professional with a solid academic foundation in ${education}, offering capabilities in ${skillsText}. Supported by ${proofPhrase}, with a consistent focus on delivering structured outcomes and process optimization. Eager to contribute this background and drive growth for the teams at ${company} in the target role of ${role}.`;

  const words = summary.split(/\s+/).filter(Boolean);
  if (words.length >= 65 && words.length <= 85) {
    return summary;
  }

  if (words.length < 65) {
    const padding = `Committed to continuous professional development, cross-functional collaboration, and leveraging data-driven insights to solve complex challenges in fast-paced business environments.`;
    const combined = `${summary} ${padding}`;
    return limitWords(combined, 85);
  }

  return limitWords(summary, 85);
}

app.post('/api/generate-cv-template', analyzeLimiter, async (req, res) => {
  let inputCharacterCount = JSON.stringify(req.body || {}).length;
  let logCompany = '';
  let logRole = '';
  let opportunityId = '';
  const startedAt = Date.now();

  try {
    const {
      profile,
      opportunity,
      pack,
      evidences,
      checklists,
      dryRun,
      useCachedOutput,
      contextMode = 'standard'
    } = req.body;
    const resolvedContextMode: 'standard' | 'compact' = contextMode === 'compact' ? 'compact' : 'standard';
    logCompany = opportunity?.company || pack?.company || '';
    logRole = opportunity?.role || pack?.role || '';
    opportunityId = opportunity?.id || pack?.opportunityId || '';

    if (!profile || !opportunity || !pack) {
      res.status(400).json({ error: 'Profile, opportunity, and application pack are required.' });
      return;
    }

    const warning = '[Needs verified input]';
    const allEvidences = Array.isArray(evidences) ? evidences : [];
    const verifiedEvidences = allEvidences.filter((evidence) => evidence?.isVerified === true);
    const jobTextLimit = resolvedContextMode === 'compact' ? Math.min(7000, MAX_JOB_TEXT_CHARS) : MAX_JOB_TEXT_CHARS;
    const evidenceLimit = resolvedContextMode === 'compact' ? Math.min(10, MAX_EVIDENCE_ITEMS_PER_CALL) : MAX_EVIDENCE_ITEMS_PER_CALL;
    const checklistLimit = resolvedContextMode === 'compact' ? 5 : 10;
    const cappedOpportunityJobText = capJobText(opportunity?.jobText || '', jobTextLimit);
    const jobSignalText = lowerText(opportunity?.company, opportunity?.role, cappedOpportunityJobText, opportunity?.roleDna);
    const preRoleDna = classifyRoleDna(jobSignalText);
    const promptEvidences = selectRelevantEvidencesForPrompt(verifiedEvidences, jobSignalText, preRoleDna, evidenceLimit);
    const cvTailoringFramework = buildCvTailoringFramework({
      profile,
      pack,
      opportunity: { ...opportunity, jobText: cappedOpportunityJobText },
      evidences: allEvidences,
      checklists
    });
    const promptFramework = compactCvTailoringFrameworkForPrompt(cvTailoringFramework, resolvedContextMode);
    const certificationEvidenceSelected = cvTailoringFramework.certificationEvidenceSelected || [];
    const certificationBullets = certificationEvidenceSelected.map((item) => item.finalText).filter(Boolean);
    const compactReadyChecklistRows = compactChecklistRows(cvTailoringFramework.readyChecklistRowsUsed, checklistLimit);
    const cacheKey = `cv-template:${hashPayload({
      contextMode: resolvedContextMode,
      opportunity: {
        company: opportunity?.company,
        role: opportunity?.role,
        jobText: cappedOpportunityJobText
      },
      profile: compactProfile(profile),
      pack: {
        summaryRewrite: pack?.summaryRewrite,
        cvAngle: pack?.cvAngle,
        keywordsToEmphasize: pack?.keywordsToEmphasize
      },
      evidences: promptEvidences,
      checklists: compactReadyChecklistRows
    })}`;

    if (!dryRun && useCachedOutput && aiResponseCache.has(cacheKey)) {
      const cached = aiResponseCache.get(cacheKey) as { fields: Record<string, string>; debug?: CvTailoringFramework };
      recordAiUsage({
        featureName: 'Generate CV Placeholder JSON',
        company: logCompany,
        role: logRole,
        opportunityId,
        endpointName: '/api/generate-cv-template',
        model: 'local-cv-mapping',
        inputCharacterCount: 0,
        outputCharacterCount: JSON.stringify(cached).length,
        estimatedInputTokens: 0,
        estimatedOutputTokens: estimateTokensFromChars(JSON.stringify(cached).length),
        estimatedTotalTokens: estimateTokensFromChars(JSON.stringify(cached).length),
        tokenCountSource: 'estimated',
        durationMs: Date.now() - startedAt,
        cacheStatus: 'hit',
        status: 'success'
      });
      res.json({ ...cached, cacheStatus: 'hit' });
      return;
    }

    if (dryRun) {
      const selectedEvidenceIds = promptEvidences
        .map((evidence) => evidence.evidenceId || evidence.id || evidence.title)
        .filter(Boolean);
      recordAiUsage({
        featureName: 'Generate CV Placeholder JSON',
        company: logCompany,
        role: logRole,
        opportunityId,
        endpointName: '/api/generate-cv-template',
        model: 'local-cv-mapping',
        inputCharacterCount: 0,
        outputCharacterCount: 0,
        estimatedInputTokens: 0,
        estimatedOutputTokens: 0,
        estimatedTotalTokens: 0,
        tokenCountSource: 'estimated',
        durationMs: Date.now() - startedAt,
        cacheStatus: 'dry_run',
        status: 'success'
      });
      res.json({
        dryRun: true,
        expectedAiCalls: 0,
        endpointName: '/api/generate-cv-template',
        opportunityId,
        company: logCompany,
        role: logRole,
        contextMode: resolvedContextMode,
        inputCharacterCount: 0,
        estimatedInputTokens: 0,
        selectedEvidenceCount: promptEvidences.length,
        selectedEvidenceIds,
        readyChecklistRowsCount: compactReadyChecklistRows.length,
        maxInputCharsPerCall: 0,
        maxEvidenceItemsPerCall: evidenceLimit,
        jobTextWasTruncated: String(opportunity?.jobText || '').length > cappedOpportunityJobText.length,
        cacheStatus: 'dry_run',
        cachedOutputExists: aiResponseCache.has(cacheKey),
        contextSent: [
          'target role and company',
          `top ${promptEvidences.length} verified evidence items`,
          `${compactReadyChecklistRows.length} ready checklist rows`,
          'local CV placeholder mapping rules'
        ],
        contextExcludedOrReduced: [
          'no Gemini request is created for CV placeholder mapping',
          'raw prompt text is not sent to any external AI provider',
          allEvidences.length > promptEvidences.length ? `${allEvidences.length - promptEvidences.length} lower-ranked evidence items excluded from local preview` : 'all verified evidence stayed within the local preview cap'
        ],
        warning: 'Preview mode only. No Gemini or Google Docs call was made.'
      });
      return;
    }

    const parsedData: Record<string, string> = {};

    parsedData.targetTitle = opportunity.role || pack.role || profile.targetRoles || 'Target Role';

    const verified = allEvidences.filter((e) => e.isVerified);

    const experienceGroupsMap = new Map<string, CvEvidenceInput[]>();
    verified.forEach((e) => {
      if (classifyEvidenceSection(e) === 'experience') {
        const orgKey = (e.organization || '').trim().toLowerCase();
        if (!experienceGroupsMap.has(orgKey)) {
          experienceGroupsMap.set(orgKey, []);
        }
        experienceGroupsMap.get(orgKey)!.push(e);
      }
    });

    const experienceGroups = Array.from(experienceGroupsMap.entries()).map(([orgKey, items]) => {
      const itemsWithScores = items.map((item) => {
        const score = scoreEvidenceForJob(item, cappedOpportunityJobText, preRoleDna);
        return { item, score };
      });
      itemsWithScores.sort((a, b) => b.score - a.score);
      const maxScore = itemsWithScores[0]?.score ?? -999;
      return {
        orgKey,
        maxScore,
        items: itemsWithScores.map((x) => x.item)
      };
    });

    experienceGroups.sort((a, b) => b.maxScore - a.maxScore);

    for (let slot = 1; slot <= 4; slot++) {
      const group = experienceGroups[slot - 1];
      if (group && group.items.length > 0) {
        const highestItem = group.items[0];
        parsedData[`experience${slot}Title`] = highestItem.title || '';
        parsedData[`experience${slot}Organization`] = highestItem.organization || '';
        parsedData[`experience${slot}Date`] = extractDateFromEvidence(highestItem);

        const bullets: string[] = [];
        group.items.forEach((item) => {
          const text = getEvidenceBulletText(item, checklists);
          const sentences = splitIntoSentences(text);
          bullets.push(...sentences);
        });

        for (let b = 1; b <= 5; b++) {
          parsedData[`experience${slot}Bullet${b}`] = bullets[b - 1] || '';
        }
      } else {
        parsedData[`experience${slot}Title`] = '';
        parsedData[`experience${slot}Organization`] = '';
        parsedData[`experience${slot}Date`] = '';
        for (let b = 1; b <= 5; b++) {
          parsedData[`experience${slot}Bullet${b}`] = '';
        }
      }
    }

    const orgGroupsMap = new Map<string, CvEvidenceInput[]>();
    verified.forEach((e) => {
      if (classifyEvidenceSection(e) === 'organization') {
        const orgKey = (e.organization || '').trim().toLowerCase();
        if (!orgGroupsMap.has(orgKey)) {
          orgGroupsMap.set(orgKey, []);
        }
        orgGroupsMap.get(orgKey)!.push(e);
      }
    });

    const orgGroups = Array.from(orgGroupsMap.entries()).map(([orgKey, items]) => {
      const itemsWithScores = items.map((item) => {
        const score = scoreEvidenceForJob(item, cappedOpportunityJobText, preRoleDna);
        return { item, score };
      });
      itemsWithScores.sort((a, b) => b.score - a.score);
      const maxScore = itemsWithScores[0]?.score ?? -999;
      return {
        orgKey,
        maxScore,
        items: itemsWithScores.map((x) => x.item)
      };
    });

    orgGroups.sort((a, b) => b.maxScore - a.maxScore);

    for (let slot = 1; slot <= 3; slot++) {
      const group = orgGroups[slot - 1];
      if (group && group.items.length > 0) {
        const highestItem = group.items[0];
        parsedData[`organization${slot}Title`] = highestItem.title || '';
        parsedData[`organization${slot}Organization`] = highestItem.organization || '';
        parsedData[`organization${slot}Date`] = extractDateFromEvidence(highestItem);

        const bullets: string[] = [];
        group.items.forEach((item) => {
          const text = getEvidenceBulletText(item, checklists);
          const sentences = splitIntoSentences(text);
          bullets.push(...sentences);
        });

        for (let b = 1; b <= 5; b++) {
          parsedData[`organization${slot}Bullet${b}`] = bullets[b - 1] || '';
        }
      } else {
        parsedData[`organization${slot}Title`] = '';
        parsedData[`organization${slot}Organization`] = '';
        parsedData[`organization${slot}Date`] = '';
        for (let b = 1; b <= 5; b++) {
          parsedData[`organization${slot}Bullet${b}`] = '';
        }
      }
    }

    const projectGroupsMap = new Map<string, CvEvidenceInput[]>();
    verified.forEach((e) => {
      if (classifyEvidenceSection(e) === 'project') {
        const projKey = (e.organization || e.title || '').trim().toLowerCase();
        if (projKey) {
          if (!projectGroupsMap.has(projKey)) {
            projectGroupsMap.set(projKey, []);
          }
          projectGroupsMap.get(projKey)!.push(e);
        }
      }
    });

    const projectGroups = Array.from(projectGroupsMap.entries()).map(([projKey, items]) => {
      const itemsWithScores = items.map((item) => {
        const score = scoreEvidenceForJob(item, cappedOpportunityJobText, preRoleDna);
        return { item, score };
      });
      itemsWithScores.sort((a, b) => b.score - a.score);
      const maxScore = itemsWithScores[0]?.score ?? -999;
      return {
        projKey,
        maxScore,
        items: itemsWithScores.map((x) => x.item)
      };
    });

    projectGroups.sort((a, b) => b.maxScore - a.maxScore);

    for (let slot = 1; slot <= 4; slot++) {
      const group = projectGroups[slot - 1];
      if (group && group.items.length > 0) {
        const highestItem = group.items[0];
        parsedData[`project${slot}Title`] = highestItem.title || '';

        const bullets: string[] = [];
        group.items.forEach((item) => {
          const text = getEvidenceBulletText(item, checklists);
          const sentences = splitIntoSentences(text);
          bullets.push(...sentences);
        });

        for (let b = 1; b <= 5; b++) {
          parsedData[`project${slot}Bullet${b}`] = bullets[b - 1] || '';
        }
      } else {
        parsedData[`project${slot}Title`] = '';
        for (let b = 1; b <= 5; b++) {
          parsedData[`project${slot}Bullet${b}`] = '';
        }
      }
    }

    const achievementEvidences = verified.filter((e) => classifyEvidenceSection(e) === 'achievement');
    const scoredAchievements = achievementEvidences.map((e) => {
      const score = scoreEvidenceForJob(e, cappedOpportunityJobText, preRoleDna);
      return { e, score };
    });
    scoredAchievements.sort((a, b) => b.score - a.score);

    for (let slot = 1; slot <= 5; slot++) {
      const item = scoredAchievements[slot - 1]?.e;
      if (item) {
        const text = getEvidenceBulletText(item, checklists);
        const sentences = splitIntoSentences(text);
        parsedData[`achievementBullet${slot}`] = sentences[0] || '';
      } else {
        parsedData[`achievementBullet${slot}`] = '';
      }
    }

    parsedData.certifications = certificationBullets.join(' | ');
    for (let i = 1; i <= 8; i++) {
      parsedData[`certificationBullet${i}`] = certificationBullets[i - 1] || '';
    }

    const hardSkills = pack.hardSkills || preRoleDna.hardSkillSignals.join(' | ');
    const softSkills = pack.softSkills || preRoleDna.softSkillSignals.join(' | ');
    parsedData.hardSkills = hardSkills;
    parsedData.softSkills = softSkills;

    let languagesValue = 'Bahasa Indonesia (Native)';
    const hasEnglishEvidence = verified.some((e) =>
      /english|toefl|ielts|toeic|proficiency/i.test(`${e.title || ''} ${e.description || ''}`)
    );
    if (hasEnglishEvidence) {
      languagesValue = 'Bahasa Indonesia (Native) | English (Professional)';
    }
    parsedData.languages = languagesValue;

    const isFallbackSummary = (cvTailoringFramework.summarySource as string) === 'fallback' || cvTailoringFramework.summarySource === 'fallback_generated';
    const professionalSummary = (!isFallbackSummary && cvTailoringFramework.selectedSummary)
      ? cvTailoringFramework.selectedSummary
      : buildFallbackSummary(profile, opportunity, hardSkills, verified);
    parsedData.professionalSummary = professionalSummary;

    const validatedFields = parsedData;
    const normalizedFields = normalizeGeneratedCvFields(validatedFields, certificationBullets, warning);

    const onePageRiskWarning = estimateOnePageRisk(normalizedFields);
    const debug: CvTailoringFramework = {
      ...cvTailoringFramework,
      onePageRiskWarning: onePageRiskWarning || undefined,
      qualityWarnings: [
        ...(cvTailoringFramework.qualityWarnings || []),
        ...(onePageRiskWarning ? [onePageRiskWarning] : [])
      ],
      finalPlaceholderJson: normalizedFields
    };
    const payload = { fields: normalizedFields, debug, aiCacheKey: cacheKey };
    aiResponseCache.set(cacheKey, payload);

    recordAiUsage({
      featureName: 'Generate CV Placeholder JSON',
      company: logCompany,
      role: logRole,
      opportunityId,
      endpointName: '/api/generate-cv-template',
      model: 'local-cv-mapping',
      inputCharacterCount: 0,
      outputCharacterCount: JSON.stringify(payload).length,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      estimatedTotalTokens: 0,
      tokenCountSource: 'estimated',
      durationMs: Date.now() - startedAt,
      cacheStatus: 'miss',
      status: 'success'
    });
    res.json({ ...payload, cacheStatus: 'miss' });
  } catch (error) {
    console.error('API CV Template Generation Error:', error);
    recordAiUsage({
      featureName: 'Generate CV Placeholder JSON',
      company: logCompany,
      role: logRole,
      opportunityId,
      endpointName: '/api/generate-cv-template',
      model: 'local-cv-mapping',
      inputCharacterCount,
      outputCharacterCount: 0,
      estimatedInputTokens: estimateTokensFromChars(inputCharacterCount),
      estimatedOutputTokens: 0,
      estimatedTotalTokens: estimateTokensFromChars(inputCharacterCount),
      tokenCountSource: 'estimated',
      durationMs: Date.now() - startedAt,
      cacheStatus: 'blocked',
      status: 'error',
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    res.status(500).json({ error: error instanceof Error ? error.message : 'Internal Server Error' });
  }
});

export default app;
