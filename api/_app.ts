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
const DAILY_AI_CALL_LIMIT_DEV = Number(process.env.DAILY_AI_CALL_LIMIT_DEV || 20);
const REQUIRE_CONFIRM_FOR_REGENERATE = String(process.env.REQUIRE_CONFIRM_FOR_REGENERATE || 'true') === 'true';
const MAX_JOB_TEXT_CHARS = Number(process.env.MAX_JOB_TEXT_CHARS || 12000);

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
  const promotionLimit = mode === 'compact' ? 6 : 10;
  const checklistLimit = mode === 'compact' ? 5 : 10;
  return {
    roleDna: framework.roleDna,
    cvBaseVersion: framework.cvBaseVersion,
    evidenceIdsUsed: framework.evidenceIdsUsed,
    evidenceMappings: framework.evidenceMappings.slice(0, mappingLimit).map((item) => ({
      evidenceId: item.evidenceId,
      targetCvSection: item.targetCvSection,
      businessMeaning: String(item.businessMeaning || '').slice(0, 220)
    })),
    qualificationPromotions: framework.qualificationPromotions.slice(0, promotionLimit).map((item) => ({
      cvSection: item.cvSection,
      evidenceId: item.evidenceId,
      priority: item.priority,
      finalSuggestedText: String(item.finalSuggestedText || '').slice(0, 260)
    })),
    certificationPriority: framework.certificationPriority,
    certificationEvidenceSelected: framework.certificationEvidenceSelected,
    finalSelectedCertificationList: framework.finalSelectedCertificationList,
    finalCertificationStringLength: framework.finalCertificationStringLength,
    onePageCompressionMode: framework.onePageCompressionMode,
    summarySource: framework.summarySource,
    selectedSummary: String(framework.selectedSummary || '').slice(0, 700),
    verifiedEvidenceCount: framework.verifiedEvidenceCount,
    ignoredUnverifiedEvidenceIds: framework.ignoredUnverifiedEvidenceIds,
    readyChecklistRowsUsed: framework.readyChecklistRowsUsed.slice(0, checklistLimit),
    englishEvidenceWarning: framework.englishEvidenceWarning,
    qualityWarnings: framework.qualityWarnings
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
    .slice(0, 4);
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
  certifications: 60,
  achievementBullet1: 22,
  achievementBullet2: 22,
  achievementBullet3: 22,
  hardSkills: 45,
  softSkills: 30,
  languages: 18
};

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

  certificationBullets.slice(0, 4).forEach((item, index) => {
    if (item) {
      normalized[`certificationBullet${index + 1}`] = softenRiskyLanguage(item);
    }
  });

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
  const body = document.body as { content?: unknown[] } | undefined;
  const parts: string[] = [];
  (body?.content || []).forEach((block) => {
    const paragraph = (block as { paragraph?: { elements?: unknown[] } }).paragraph;
    paragraph?.elements?.forEach((element) => {
      const textRun = (element as { textRun?: { content?: string } }).textRun;
      if (textRun?.content) parts.push(textRun.content);
    });
  });
  return normalizeExtractedText(parts.join(''));
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
  const fullName = fields.fullName || '[Candidate Name]';
  return `${fullName}
{{TARGET_TITLE}}
{{PROFESSIONAL_SUMMARY}}

EDUCATION
{{EDUCATION}}

WORK EXPERIENCE
{{EXPERIENCE_1_TITLE}} - {{EXPERIENCE_1_ORGANIZATION}}
{{EXPERIENCE_1_DATE}}
- {{EXPERIENCE_1_BULLET_1}}
- {{EXPERIENCE_1_BULLET_2}}
- {{EXPERIENCE_1_BULLET_3}}

{{EXPERIENCE_2_TITLE}} - {{EXPERIENCE_2_ORGANIZATION}}
{{EXPERIENCE_2_DATE}}
- {{EXPERIENCE_2_BULLET_1}}
- {{EXPERIENCE_2_BULLET_2}}
- {{EXPERIENCE_2_BULLET_3}}

PROJECT / PORTFOLIO
{{PROJECT_1_TITLE}}
- {{PROJECT_1_BULLET_1}}

{{PROJECT_2_TITLE}}
- {{PROJECT_2_BULLET_1}}

{{PROJECT_3_TITLE}}
- {{PROJECT_3_BULLET_1}}

CERTIFICATIONS
{{CERTIFICATIONS}}

ACHIEVEMENTS
- {{ACHIEVEMENT_BULLET_1}}
- {{ACHIEVEMENT_BULLET_2}}
- {{ACHIEVEMENT_BULLET_3}}

SKILLS & LANGUAGES
Hard Skills: {{HARD_SKILLS}}
Soft Skills: {{SOFT_SKILLS}}
Languages: {{LANGUAGES}}

Source: ${sourceName || 'CareerRadar CV onboarding'}`;
}

function onboardingSchema() {
  const evidenceDraft = {
    type: Type.OBJECT,
    properties: {
      category: { type: Type.STRING },
      title: { type: Type.STRING },
      organization: { type: Type.STRING },
      description: { type: Type.STRING },
      sourceSection: { type: Type.STRING },
      confidence: { type: Type.NUMBER },
      inferredSkillTags: {
        type: Type.ARRAY,
        items: { type: Type.STRING }
      }
    },
    required: ['category', 'title', 'organization', 'description', 'sourceSection', 'confidence', 'inferredSkillTags']
  };

  return {
    type: Type.OBJECT,
    properties: {
      profileDraft: {
        type: Type.OBJECT,
        properties: {
          fullName: { type: Type.STRING },
          education: { type: Type.STRING },
          professionalSummary: { type: Type.STRING },
          hardSkills: { type: Type.STRING },
          softSkills: { type: Type.STRING },
          languages: { type: Type.STRING }
        },
        required: ['fullName', 'education', 'professionalSummary', 'hardSkills', 'softSkills', 'languages']
      },
      templateFields: {
        type: Type.OBJECT,
        properties: {
          fullName: { type: Type.STRING },
          targetTitle: { type: Type.STRING },
          professionalSummary: { type: Type.STRING },
          education: { type: Type.STRING },
          experience1Title: { type: Type.STRING },
          experience1Organization: { type: Type.STRING },
          experience1Date: { type: Type.STRING },
          experience1Bullet1: { type: Type.STRING },
          experience1Bullet2: { type: Type.STRING },
          experience1Bullet3: { type: Type.STRING },
          experience2Title: { type: Type.STRING },
          experience2Organization: { type: Type.STRING },
          experience2Date: { type: Type.STRING },
          experience2Bullet1: { type: Type.STRING },
          experience2Bullet2: { type: Type.STRING },
          experience2Bullet3: { type: Type.STRING },
          project1Title: { type: Type.STRING },
          project1Bullet1: { type: Type.STRING },
          project2Title: { type: Type.STRING },
          project2Bullet1: { type: Type.STRING },
          project3Title: { type: Type.STRING },
          project3Bullet1: { type: Type.STRING },
          certifications: { type: Type.STRING },
          achievementBullet1: { type: Type.STRING },
          achievementBullet2: { type: Type.STRING },
          achievementBullet3: { type: Type.STRING },
          hardSkills: { type: Type.STRING },
          softSkills: { type: Type.STRING },
          languages: { type: Type.STRING }
        },
        required: ['fullName', 'targetTitle', 'professionalSummary', 'education', 'experience1Title', 'experience1Organization', 'experience1Date', 'experience1Bullet1', 'experience1Bullet2', 'experience1Bullet3', 'experience2Title', 'experience2Organization', 'experience2Date', 'experience2Bullet1', 'experience2Bullet2', 'experience2Bullet3', 'project1Title', 'project1Bullet1', 'project2Title', 'project2Bullet1', 'project3Title', 'project3Bullet1', 'certifications', 'achievementBullet1', 'achievementBullet2', 'achievementBullet3', 'hardSkills', 'softSkills', 'languages']
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
- Do not invent facts, metrics, dates, employers, education, certifications, or skills.
- If a value is missing or unclear, return "[Needs verified input]".
- Evidence drafts must be based only on text present in the CV.
- Evidence drafts are not verified. Use conservative wording and confidence 0-1.
- Evidence draft category must be one of: Work Achievement, Academic Honor, Side Project / Portfolio, Certification, Hard Skill / Technical Fact, Other Highlight.

Source name: ${sourceName || 'Uploaded CV'}

Generic placeholder rules:
- Use experience1/experience2 for strongest work or internship items.
- Use project1/project2/project3 for strongest project or portfolio items.
- Keep bullets one sentence and concise.
- Certifications must contain only real certificates, courses, licenses, or language scores.
- Achievements contain awards, competitions, and measurable extracurricular outcomes.

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

    const parsedData = JSON.parse(response.text || '{}');
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

function sourceValuePlaceholderPairs(templateFields: Record<string, string>) {
  const pairs: [string, string][] = [
    [templateFields.targetTitle, '{{TARGET_TITLE}}'],
    [templateFields.professionalSummary, '{{PROFESSIONAL_SUMMARY}}'],
    [templateFields.education, '{{EDUCATION}}'],
    [templateFields.experience1Title, '{{EXPERIENCE_1_TITLE}}'],
    [templateFields.experience1Organization, '{{EXPERIENCE_1_ORGANIZATION}}'],
    [templateFields.experience1Date, '{{EXPERIENCE_1_DATE}}'],
    [templateFields.experience1Bullet1, '{{EXPERIENCE_1_BULLET_1}}'],
    [templateFields.experience1Bullet2, '{{EXPERIENCE_1_BULLET_2}}'],
    [templateFields.experience1Bullet3, '{{EXPERIENCE_1_BULLET_3}}'],
    [templateFields.experience2Title, '{{EXPERIENCE_2_TITLE}}'],
    [templateFields.experience2Organization, '{{EXPERIENCE_2_ORGANIZATION}}'],
    [templateFields.experience2Date, '{{EXPERIENCE_2_DATE}}'],
    [templateFields.experience2Bullet1, '{{EXPERIENCE_2_BULLET_1}}'],
    [templateFields.experience2Bullet2, '{{EXPERIENCE_2_BULLET_2}}'],
    [templateFields.experience2Bullet3, '{{EXPERIENCE_2_BULLET_3}}'],
    [templateFields.project1Title, '{{PROJECT_1_TITLE}}'],
    [templateFields.project1Bullet1, '{{PROJECT_1_BULLET_1}}'],
    [templateFields.project2Title, '{{PROJECT_2_TITLE}}'],
    [templateFields.project2Bullet1, '{{PROJECT_2_BULLET_1}}'],
    [templateFields.project3Title, '{{PROJECT_3_TITLE}}'],
    [templateFields.project3Bullet1, '{{PROJECT_3_BULLET_1}}'],
    [templateFields.certifications, '{{CERTIFICATIONS}}'],
    [templateFields.achievementBullet1, '{{ACHIEVEMENT_BULLET_1}}'],
    [templateFields.achievementBullet2, '{{ACHIEVEMENT_BULLET_2}}'],
    [templateFields.achievementBullet3, '{{ACHIEVEMENT_BULLET_3}}'],
    [templateFields.hardSkills, '{{HARD_SKILLS}}'],
    [templateFields.softSkills, '{{SOFT_SKILLS}}'],
    [templateFields.languages, '{{LANGUAGES}}']
  ];
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
    const { accessToken, sourceType, sourceDocumentId, sourceName, templateFields } = req.body || {};
    if (!accessToken || !templateFields) {
      res.status(400).json({ error: 'Google Drive access and template fields are required.' });
      return;
    }

    let documentId = '';
    let name = `CareerRadar Placeholder Template - ${sourceName || 'CV'}`;
    let webViewLink = '';

    if (sourceType === 'google_docs' && sourceDocumentId) {
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
          requests: [{
            insertText: {
              location: { index: 1 },
              text: placeholderTemplateText(templateFields, sourceName || '')
            }
          }]
        })
      });
    }

    res.json({ id: documentId, name, webViewLink });
  } catch (error) {
    console.error('Create placeholder template error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Career Radar Job Match Analyzer Endpoint
app.post('/api/analyze-job', analyzeLimiter, async (req, res) => {
  let inputCharacterCount = JSON.stringify(req.body || {}).length;
  let logCompany = '';
  let logRole = '';
  const startedAt = Date.now();

  try {
    const { jobText, profile, evidences, dryRun, useCachedOutput } = req.body;

    if (!jobText) {
      res.status(400).json({ error: 'Job description text is required' });
      return;
    }

    const cappedJobText = capJobText(jobText);
    const allEvidences = Array.isArray(evidences) ? evidences : [];
    const preRoleDna = classifyRoleDna(lowerText(cappedJobText));
    const promptEvidences = selectRelevantEvidencesForPrompt(allEvidences, lowerText(cappedJobText), preRoleDna);
    const compactRequestContext = {
      jobText: cappedJobText,
      profile: compactProfile(profile),
      evidences: promptEvidences
    };
    const cacheKey = `analyze:${hashPayload(compactRequestContext)}`;

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

    const cvTailoringFramework = buildCvTailoringFramework({ jobText: cappedJobText, profile, evidences: allEvidences });

    // Construct the structured analysis prompt for the configured Gemini model.
    const prompt = `
You are a highly analytical AI talent matcher and strategic resume advisor. Your task is to perform an exhaustive, objective comparison between a candidate's portfolio/evidence bank (the ground truth facts) and a specific job description.

Candidate Profile:
${JSON.stringify(compactRequestContext.profile, null, 2)}

Top Relevant Candidate CV Evidence Bank (compact, deduped, capped at ${MAX_EVIDENCE_ITEMS_PER_CALL} items):
${JSON.stringify(promptEvidences, null, 2)}

Target Job Description:
${cappedJobText}

Reusable CV Tailoring Framework:
${JSON.stringify(cvTailoringFramework, null, 2)}

INSTRUCTIONS:
0. Extract the target company name and role/title from the job description when present.
1. Conduct a rigorous, human-grade, zero-inflation gap analysis. Evaluate the alignment of education, academic score, years of experience, core technologies, and specialized achievements.
2. Formulate a final "match quality" score (fitScore) between 0 and 100 based on criteria fulfillment, and choose an actionable recommendation decision:
   - "Apply Now": Highly optimized match (fitScore >= 85).
   - "Apply After CV Adjustment": Strong baseline match, but custom section overrides are critical to show exact grounding (fitScore 65-84).
   - "Save for Later": Decent peripheral alignment or stretch role (fitScore 50-64).
   - "Skip": Fatal mismatch/red flag triggers present (fitScore < 50).
   - "Verify First": Ambiguous details or requires verifying certification/gaps.
3. Align CV Checklist suggestions STRICTLY with the candidate's existing background. If a checklist item is suggested, it MUST show how to contextualize, reword, or rewrite a section using actual evidence item IDs (e.g. CSA-01) from the database, or generic optimization (when no specific evidence matches). DO NOT invent entirely fake credentials or skills the candidate does not have.
4. Draft a highly compelling Application Pack tailored to the target role:
   - Write a refined summary introduction ("summaryRewrite") specific to the hiring firm.
   - Compose a brilliant, tailored outreach pitch / cover letter ("coverMessage").
   - Compose a modern, highly targeted cold LinkedIn recruiter message ("linkedinMessage").
5. Use the framework's role DNA, CV base version, evidence-to-role mappings, certification priority, and noise reduction rules when generating checklist and application pack content.
6. When writing work-experience checklist text, use this bullet formula: action verb + scope/scale + method + business outcome.
7. For non-technical business roles, translate technical work into business meaning instead of listing excessive tool stacks.
`;

    inputCharacterCount = prompt.length;
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
      maxEvidenceItemsPerCall: MAX_EVIDENCE_ITEMS_PER_CALL,
      fullEvidenceBankCount: allEvidences.length,
      jobTextWasTruncated: String(jobText).length > cappedJobText.length,
      cachedOutputExists,
      cacheStatus: cachedOutputExists ? 'hit' : 'miss',
      dryRunEnabled: Boolean(dryRun),
      useCachedOutputEnabled: Boolean(useCachedOutput),
      contextSent: [
        'capped job description',
        'compact candidate profile',
        `top ${promptEvidences.length} ranked evidence items`,
        'role DNA and CV section rules',
        'application pack/checklist generation instructions'
      ],
      contextExcludedOrReduced: [
        String(jobText).length > cappedJobText.length ? 'job description truncated to configured cap' : 'full job description kept within cap',
        allEvidences.length > promptEvidences.length ? `${allEvidences.length - promptEvidences.length} lower-ranked evidence items excluded` : 'no evidence items excluded by cap',
        'Firestore debug/status data excluded',
        'existing generated application packs/checklists excluded from job analysis prompt'
      ],
      warning: cachedOutputExists && useCachedOutput
        ? 'No AI call will be made if you run with cached output enabled.'
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
                  sourceEvidence: { type: Type.STRING, description: 'How to map the existing candidate evidence (e.g. CSA-01 Project) into the rewrite.' },
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
    recordAnalyzeJobUsage(
      'error',
      inputCharacterCount,
      0,
      Date.now() - startedAt,
      logCompany,
      logRole,
      error instanceof Error ? error.message : String(error)
    );
    res.status(500).json({ error: error instanceof Error ? error.message : 'Internal Server Error' });
  }
});

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
      contextMode = 'standard',
      overrideCostGuard
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
        model: GEMINI_MODEL,
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

    const prompt = `
You are a strict ATS CV tailoring assistant. Return structured JSON only.

The user has an original ATS CV template. Do NOT create a new CV layout. Fill only these fixed template fields:
- targetTitle
- professionalSummary
- experience1Title
- experience1Organization
- experience1Date
- experience1Bullet1
- experience1Bullet2
- experience1Bullet3
- experience2Title
- experience2Organization
- experience2Date
- experience2Bullet1
- experience2Bullet2
- experience2Bullet3
- project1Title
- project1Bullet1
- project2Title
- project2Bullet1
- project3Title
- project3Bullet1
- certifications
- certificationBullet1
- certificationBullet2
- certificationBullet3
- certificationBullet4
- achievementBullet1
- achievementBullet2
- achievementBullet3
- hardSkills
- softSkills
- languages

Fixed final CV layout:
1. NAME + CONTACT
2. TARGET TITLE
3. PROFESSIONAL SUMMARY
4. EDUCATION
5. WORK EXPERIENCE
   - Experience slot 1 from the strongest verified work evidence
   - Experience slot 2 from the next strongest verified work/internship evidence
6. PROJECT / PORTFOLIO
   - Project slots from the strongest verified project/portfolio evidence
7. CERTIFICATIONS
8. ACHIEVEMENTS
9. SKILLS & LANGUAGES

Rules:
- Do not invent credentials, employers, education, dates, certificates, languages, or achievements.
- Use verified evidence only. Unverified evidence is intentionally excluded from the evidence bank below.
- Do not freely rewrite the CV from scratch. Build the placeholders from the reusable CV tailoring framework, evidence-to-role mapping, and ready-to-copy checklist rows.
- Treat the application pack as supporting context only, not as the source of truth.
- If a field cannot be supported by verified profile/evidence/checklist data, return exactly "${warning}".
- Aim for a one-page CV. Summary must be 65-85 words maximum. Work bullets must be one sentence, 18-28 words. Each project bullet must be one sentence, 22-32 words.
- Experience titles, organizations, and dates must be copied or safely summarized from verified evidence/profile only. Do not invent companies, roles, or dates.
- Preferred certification output is certifications for the dynamic {{CERTIFICATIONS}} placeholder.
- certifications must be one compact pipe-separated string built from Recommended certification dynamic section exactly.
- certificationBullet1 through certificationBullet4 are legacy compatibility fields only. Fill them with the first four certification items, but do not limit certifications to four items.
- Never place competitions, achievements, work experience, projects, or portfolio items in Certifications. Those belong in Achievements, Experience, or Project sections.
- If onePageCompressionMode is true in the framework, use the compact final certification text exactly and avoid adding extra detail.
- Skills must be compact comma-separated or pipe-separated phrases.
- Work experience bullet formula: action verb + scope/scale + method + business outcome.
- Summary formula: candidate identity + relevant capability + quantified proof + target industry/function interest + role identity.
- For MT / Generalist CV version, future leader potential may be mentioned only as potential. For non-MT roles, avoid generic future leader language.
- Professional summary source priority has already been selected. If summarySource is "checklist" or "application_pack", copy selectedSummary exactly into professionalSummary.
- Only generate professionalSummary as fallback if summarySource is "fallback_generated".
- Fallback MT/BFLP/ODP/Future Leader professionalSummary must be 65-85 words, balanced, and not one compressed keyword sentence.
- Follow certification priority when choosing certification and achievement emphasis.
- If English/TOEFL is required and verified English score evidence exists, put it first in Certifications.
- Move role alignment into professionalSummary or relevant work/project bullet.
- Use project1 through project3 for the strongest verified project evidence when present. Do not add project names or AI productivity claims unless they exist in verified evidence.
- Do not include application notes, cover-letter language, recruiter outreach, or explanation.
- Do not include sections named Targeted Experience Highlights, Role Alignment, or Application Notes.
- Tailor wording to the selected company and role while staying truthful.
- hardSkills, softSkills, and languages should be pipe-separated strings.
- Reduce noise: avoid excessive technical stack for non-technical business roles, unverified claims, fake seniority, overclaimed leadership, niche internal terms, and buzzwords without evidence.
- Avoid risky fresh-graduate phrases: "leading large-scale operations", "executive stakeholders", "leadership excellence", "Google-certified AI professional", "engineered", and "high-stakes operational coordination".
- Prefer safer wording: hands-on experience in operations coordination, supported project visibility, cross-functional communication, performance monitoring, data-driven decision-making, digital channel analysis, process improvement, and future leadership potential.

Reusable CV tailoring framework (compact prompt view, debug-only fields removed):
${JSON.stringify(promptFramework, null, 2)}

Recommended certification dynamic section from verified evidence:
${JSON.stringify(certificationEvidenceSelected, null, 2)}

Selected opportunity:
${JSON.stringify({
  id: opportunity?.id,
  company: opportunity?.company,
  role: opportunity?.role,
  fitScore: opportunity?.fitScore,
  decision: opportunity?.decision,
  roleDna: opportunity?.roleDna,
  jobText: capJobText(opportunity?.jobText || '')
}, null, 2)}

Candidate profile:
${JSON.stringify(compactProfile(profile), null, 2)}

Application pack summary context only:
${JSON.stringify({
  applicationEnergy: pack?.applicationEnergy,
  cvAction: pack?.cvAction,
  cvAngle: pack?.cvAngle,
  keywordsToEmphasize: pack?.keywordsToEmphasize,
  summaryRewrite: pack?.summaryRewrite,
  bulletPrioritization: pack?.bulletPrioritization,
  portfolioEvidence: pack?.portfolioEvidence
}, null, 2)}

Top relevant verified evidence only (compact, deduped, capped at ${MAX_EVIDENCE_ITEMS_PER_CALL} items):
${JSON.stringify(promptEvidences, null, 2)}

Ready-to-copy CV checklist rows only:
${JSON.stringify(compactReadyChecklistRows, null, 2)}
`;

    inputCharacterCount = prompt.length;
    const dryRunPayload = {
      dryRun: true,
      endpointName: '/api/generate-cv-template',
      model: GEMINI_MODEL,
      opportunityId,
      company: logCompany,
      role: logRole,
      inputCharacterCount,
      estimatedInputTokens: estimateTokensFromChars(inputCharacterCount),
      selectedEvidenceCount: promptEvidences.length,
      selectedEvidenceIds: promptEvidences.map((evidence) => evidence.evidenceId || evidence.id || evidence.title).filter(Boolean),
      readyChecklistRowsCount: compactReadyChecklistRows.length,
      contextMode: resolvedContextMode,
      maxInputCharsPerCall: MAX_INPUT_CHARS_PER_CALL,
      maxEvidenceItemsPerCall: evidenceLimit,
      jobTextWasTruncated: String(opportunity?.jobText || '').length > cappedOpportunityJobText.length,
      contextSent: [
        `${resolvedContextMode} CV tailoring framework`,
        `top ${promptEvidences.length} verified evidence items`,
        `${compactReadyChecklistRows.length} ready-to-copy checklist rows`,
        'role DNA, eligibility evidence, CV rules, tone guard, and one-page constraints',
        'application pack summary fields only'
      ],
      contextExcludedOrReduced: [
        String(opportunity?.jobText || '').length > cappedOpportunityJobText.length ? 'long raw job text truncated' : 'job text within configured cap',
        allEvidences.length > promptEvidences.length ? `${allEvidences.length - promptEvidences.length} evidence items excluded by ranking/cap` : 'no evidence excluded by evidence cap',
        'raw certification candidate audit omitted from prompt',
        'CV Brain debug/final placeholder JSON omitted from prompt',
        'duplicate/stale generated text omitted from prompt'
      ],
      cacheKey,
      promptPreview: prompt.slice(0, 6000)
    };

    if (dryRun) {
      recordAiUsage({
        featureName: 'Generate CV Placeholder JSON',
        company: logCompany,
        role: logRole,
        opportunityId,
        endpointName: '/api/generate-cv-template',
        model: GEMINI_MODEL,
        inputCharacterCount,
        outputCharacterCount: JSON.stringify(dryRunPayload).length,
        estimatedInputTokens: estimateTokensFromChars(inputCharacterCount),
        estimatedOutputTokens: estimateTokensFromChars(JSON.stringify(dryRunPayload).length),
        estimatedTotalTokens: estimateTokensFromChars(inputCharacterCount) + estimateTokensFromChars(JSON.stringify(dryRunPayload).length),
        tokenCountSource: 'estimated',
        durationMs: Date.now() - startedAt,
        cacheStatus: 'dry_run',
        status: 'success'
      });
      res.json(dryRunPayload);
      return;
    }

    const ai = getGenAIClient(getRequestGeminiApiKey(req));
    assertCostGuard(inputCharacterCount, { allowInputOverride: Boolean(overrideCostGuard) });
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            targetTitle: { type: Type.STRING },
            professionalSummary: { type: Type.STRING },
            experience1Title: { type: Type.STRING },
            experience1Organization: { type: Type.STRING },
            experience1Date: { type: Type.STRING },
            experience1Bullet1: { type: Type.STRING },
            experience1Bullet2: { type: Type.STRING },
            experience1Bullet3: { type: Type.STRING },
            experience2Title: { type: Type.STRING },
            experience2Organization: { type: Type.STRING },
            experience2Date: { type: Type.STRING },
            experience2Bullet1: { type: Type.STRING },
            experience2Bullet2: { type: Type.STRING },
            experience2Bullet3: { type: Type.STRING },
            project1Title: { type: Type.STRING },
            project1Bullet1: { type: Type.STRING },
            project2Title: { type: Type.STRING },
            project2Bullet1: { type: Type.STRING },
            project3Title: { type: Type.STRING },
            project3Bullet1: { type: Type.STRING },
            certifications: { type: Type.STRING },
            certificationBullet1: { type: Type.STRING },
            certificationBullet2: { type: Type.STRING },
            certificationBullet3: { type: Type.STRING },
            certificationBullet4: { type: Type.STRING },
            achievementBullet1: { type: Type.STRING },
            achievementBullet2: { type: Type.STRING },
            achievementBullet3: { type: Type.STRING },
            hardSkills: { type: Type.STRING },
            softSkills: { type: Type.STRING },
            languages: { type: Type.STRING }
          },
          required: [
            'targetTitle',
            'professionalSummary',
            'experience1Title',
            'experience1Organization',
            'experience1Date',
            'experience1Bullet1',
            'experience1Bullet2',
            'experience1Bullet3',
            'experience2Title',
            'experience2Organization',
            'experience2Date',
            'experience2Bullet1',
            'experience2Bullet2',
            'experience2Bullet3',
            'project1Title',
            'project1Bullet1',
            'project2Title',
            'project2Bullet1',
            'project3Title',
            'project3Bullet1',
            'certifications',
            'certificationBullet1',
            'certificationBullet2',
            'certificationBullet3',
            'certificationBullet4',
            'achievementBullet1',
            'achievementBullet2',
            'achievementBullet3',
            'hardSkills',
            'softSkills',
            'languages'
          ]
        }
      }
    });

    let parsedData = JSON.parse(response.text || '{}');
    const outputCharacterCount = response.text?.length || JSON.stringify(parsedData).length;
    if (cvTailoringFramework.summarySource !== 'fallback_generated' && cvTailoringFramework.selectedSummary) {
      parsedData.professionalSummary = limitWords(softenRiskyLanguage(cvTailoringFramework.selectedSummary), 85);
    }
    parsedData = normalizeGeneratedCvFields(parsedData, certificationBullets, warning);
    const onePageRiskWarning = estimateOnePageRisk(parsedData);
    const debug: CvTailoringFramework = {
      ...cvTailoringFramework,
      onePageRiskWarning: onePageRiskWarning || undefined,
      qualityWarnings: [
        ...(cvTailoringFramework.qualityWarnings || []),
        ...(onePageRiskWarning ? [onePageRiskWarning] : [])
      ],
      finalPlaceholderJson: parsedData
    };
    const payload = { fields: parsedData, debug, aiCacheKey: cacheKey };
    aiResponseCache.set(cacheKey, payload);
    const usage = tokenUsageFromResponse(response, inputCharacterCount, outputCharacterCount);
    recordAiUsage({
      featureName: 'Generate CV Placeholder JSON',
      company: logCompany,
      role: logRole,
      opportunityId,
      endpointName: '/api/generate-cv-template',
      model: GEMINI_MODEL,
      inputCharacterCount,
      outputCharacterCount,
      durationMs: Date.now() - startedAt,
      cacheStatus: 'miss',
      ...usage,
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
    res.status(500).json({ error: error instanceof Error ? error.message : 'Internal Server Error' });
  }
});

export default app;
