import React, { Component, useState, useEffect, useMemo } from 'react';
import { Briefcase, Building, MapPin, ExternalLink, Trash2, ChevronDown, ChevronUp, Copy, Check, FileText, AlertTriangle, FolderInput, Wand2, Download } from 'lucide-react';
import { collection, query, getDocsFromCache, getDocsFromServer, doc, deleteDoc, getDocFromServer, updateDoc } from 'firebase/firestore';
import { db, formatFirestoreServerError, handleFirestoreError, OperationType, requestGoogleDriveAccessToken } from '../firebase';
import { CareerRadarOpportunity, ApplicationPack, CVEditChecklist, CVEvidence, Profile, CvGenerationDebug } from '../types';
import { CVTemplateFields, createCvGoogleDoc, downloadCvDoc, extractDriveFolderId, validateCvTemplateFields } from '../utils/cvDrive';

interface OpportunitiesPanelProps {
  userId: string;
  refreshToken?: number;
}

interface OpportunitiesCache {
  opportunities: CareerRadarOpportunity[];
  packs: { [opportunityId: string]: ApplicationPack };
}

interface CvTemplateGenerationResult {
  templateFields: CVTemplateFields;
  debug?: CvGenerationDebug;
}

interface CvGenerationProgress {
  status: 'idle' | 'running' | 'success' | 'error';
  currentStep: string;
  steps: string[];
  startedAt?: string;
  finishedAt?: string;
  documentName?: string;
  documentLink?: string;
  errorMessage?: string;
}

interface AiCostConfig {
  model: string;
  maxInputCharsPerCall: number;
  maxEvidenceItemsPerCall: number;
  dailyAiCallLimitDev: number;
  dailyAiCallsUsed: number;
  requireConfirmForRegenerate: boolean;
}

interface CvRequestPreview {
  endpointName: string;
  model: string;
  opportunityId?: string;
  company?: string;
  role?: string;
  inputCharacterCount: number;
  estimatedInputTokens: number;
  selectedEvidenceCount: number;
  selectedEvidenceIds?: string[];
  readyChecklistRowsCount?: number;
  contextMode?: 'standard' | 'compact';
  maxInputCharsPerCall?: number;
  maxEvidenceItemsPerCall?: number;
  jobTextWasTruncated?: boolean;
  contextSent?: string[];
  contextExcludedOrReduced?: string[];
}

interface BlockedCvRequest {
  opportunity: CareerRadarOpportunity;
  pack: ApplicationPack;
  preview: CvRequestPreview;
  reason: string;
}

type CvContextMode = 'standard' | 'compact';
type OpportunitySortMode = 'newest' | 'highest_score' | 'apply_priority' | 'recent_cv';
type OpportunityStatusFilter =
  | 'all'
  | 'apply_now'
  | 'adjust'
  | 'stretch'
  | 'gap'
  | 'generated_cv'
  | 'not_applied'
  | 'applied'
  | 'saved';
type ScoreFilter = 'all' | '85' | '65' | 'below65';

const opportunitiesCache = new Map<string, OpportunitiesCache>();

interface OpportunityExpansionBoundaryProps {
  children: React.ReactNode;
  resetKey: string;
}

interface OpportunityExpansionBoundaryState {
  error: Error | null;
}

class OpportunityExpansionBoundary extends Component<OpportunityExpansionBoundaryProps, OpportunityExpansionBoundaryState> {
  declare props: OpportunityExpansionBoundaryProps;
  declare setState: (state: Partial<OpportunityExpansionBoundaryState>) => void;
  state: OpportunityExpansionBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Opportunity expansion render crashed:', {
      resetKey: this.props.resetKey,
      error,
      componentStack: info.componentStack
    });
  }

  componentDidUpdate(prevProps: OpportunityExpansionBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="border-t border-rose-100 bg-rose-50/40 p-6 sm:p-8">
          <div className="rounded-xl border border-rose-100 bg-white px-4 py-3 text-sm text-rose-700">
            <div className="font-bold text-rose-900">This opportunity has a rendering issue.</div>
            <div className="mt-1 text-xs leading-relaxed">
              {this.state.error.message || 'Unknown render error. Check the browser console for the captured opportunity data shape.'}
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

function sortOpportunities(items: CareerRadarOpportunity[]) {
  return items.sort((a, b) => b.fitScore - a.fitScore);
}

function opportunityPriorityScore(opp: CareerRadarOpportunity, pack?: ApplicationPack) {
  let score = opp.fitScore || 0;
  if (opp.decision === 'Apply Now') score += 30;
  if (opp.decision === 'Apply After CV Adjustment') score += 20;
  if (opp.isStretchRole) score += 6;
  if (pack?.cvReadyLink) score += 12;
  if (pack?.cvReadyStatus === 'Generated') score += 8;
  if (pack?.cvReadyStatus === 'Submitted') score -= 20;
  return score;
}

function timestampValue(value?: string) {
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function safeText(value: unknown, fallback = '-') {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => safeText(item, '')).filter(Boolean).join(', ') || fallback;
  if (isRecord(value)) {
    const summaryKeys = ['primaryDirection', 'seniorityLevel', 'summarySource', 'cvBaseVersion'];
    const summary = summaryKeys
      .map((key) => value[key])
      .filter((item) => item !== undefined && item !== null)
      .map((item) => safeText(item, ''))
      .filter(Boolean)
      .join(' | ');
    return summary || JSON.stringify(value).slice(0, 500);
  }
  return fallback;
}

function safeJoin(value: unknown, separator = ', ') {
  return safeArray(value).map((item) => safeText(item, '')).filter(Boolean).join(separator);
}

function safeJsonPreview(value: unknown, maxLength = 6000) {
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > maxLength ? `${text.slice(0, maxLength)}\n... [truncated for safe preview]` : text;
  } catch (err) {
    return `Unable to serialize debug payload: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function normalizeCvDebug(input: unknown) {
  if (!isRecord(input)) return null;
  const roleDna = isRecord(input.roleDna) ? input.roleDna : {};

  return {
    roleDna: {
      primaryDirection: safeText(roleDna.primaryDirection, 'Unknown / needs verification'),
      industrySignals: safeArray(roleDna.industrySignals),
      functionSignals: safeArray(roleDna.functionSignals),
      seniorityLevel: safeText(roleDna.seniorityLevel, 'Unknown / needs verification'),
      hardSkillSignals: safeArray(roleDna.hardSkillSignals),
      softSkillSignals: safeArray(roleDna.softSkillSignals),
      eligibilitySignals: safeArray(roleDna.eligibilitySignals),
      avoidOverclaimRisks: safeArray(roleDna.avoidOverclaimRisks)
    },
    cvBaseVersion: safeText(input.cvBaseVersion, 'GENERAL'),
    evidenceIdsUsed: safeArray(input.evidenceIdsUsed).map((item) => safeText(item, '')).filter(Boolean),
    evidenceMappings: safeArray<Record<string, unknown>>(input.evidenceMappings),
    certificationPriority: safeArray(input.certificationPriority),
    rawCertificationCandidates: safeArray<Record<string, unknown>>(input.rawCertificationCandidates),
    certificationEvidenceSelected: safeArray<Record<string, unknown>>(input.certificationEvidenceSelected),
    finalSelectedCertificationList: safeArray(input.finalSelectedCertificationList),
    finalCertificationStringLength: Number(input.finalCertificationStringLength || 0),
    onePageCompressionMode: Boolean(input.onePageCompressionMode),
    ignoredUnverifiedEvidenceIds: safeArray(input.ignoredUnverifiedEvidenceIds),
    qualificationPromotions: safeArray(input.qualificationPromotions),
    readyChecklistRowsUsed: safeArray(input.readyChecklistRowsUsed),
    verifiedEvidenceCount: Number(input.verifiedEvidenceCount || 0),
    summarySource: safeText(input.summarySource, '-'),
    selectedSummary: safeText(input.selectedSummary, ''),
    onePageRiskWarning: safeText(input.onePageRiskWarning, ''),
    englishEvidenceWarning: safeText(input.englishEvidenceWarning, ''),
    qualityWarnings: safeArray(input.qualityWarnings),
    templateWarnings: safeArray(input.templateWarnings),
    finalPlaceholderJson: input.finalPlaceholderJson
  };
}

export default function OpportunitiesPanel({ userId, refreshToken = 0 }: OpportunitiesPanelProps) {
  const cachedData = opportunitiesCache.get(userId);
  const [opportunities, setOpportunities] = useState<CareerRadarOpportunity[]>(() => cachedData?.opportunities ?? []);
  const [packs, setPacks] = useState<{ [opportunityId: string]: ApplicationPack }>(() => cachedData?.packs ?? {});
  const [loading, setLoading] = useState(() => !cachedData);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [driveFolderInput, setDriveFolderInput] = useState(() => localStorage.getItem('careerRadarCvDriveFolder') || '');
  const [generatingCvId, setGeneratingCvId] = useState<string | null>(null);
  const [downloadingCvId, setDownloadingCvId] = useState<string | null>(null);
  const [cvError, setCvError] = useState<string | null>(null);
  const [serverReadError, setServerReadError] = useState<string | null>(null);
  const [cvDebugs, setCvDebugs] = useState<Record<string, CvGenerationDebug>>({});
  const [expandedDebugRows, setExpandedDebugRows] = useState<Record<string, boolean>>({});
  const [cvProgress, setCvProgress] = useState<Record<string, CvGenerationProgress>>({});
  const [dryRunAi, setDryRunAi] = useState(() => localStorage.getItem('careerRadarDryRunAi') === 'true');
  const [useCachedOutput, setUseCachedOutput] = useState(() => localStorage.getItem('careerRadarUseCachedOutput') !== 'false');
  const [costConfig, setCostConfig] = useState<AiCostConfig | null>(null);
  const [blockedCvRequest, setBlockedCvRequest] = useState<BlockedCvRequest | null>(null);
  const [opportunitySearch, setOpportunitySearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<OpportunityStatusFilter>('all');
  const [scoreFilter, setScoreFilter] = useState<ScoreFilter>('all');
  const [companyFilter, setCompanyFilter] = useState('all');
  const [sortMode, setSortMode] = useState<OpportunitySortMode>('newest');

  const opportunitiesPath = `profiles/${userId}/opportunities`;

  const fetchData = async (forceRefresh = false) => {
    if (forceRefresh) {
      opportunitiesCache.delete(userId);
    }

    const cached = forceRefresh ? undefined : opportunitiesCache.get(userId);
    if (cached) {
      setOpportunities(cached.opportunities);
      setPacks(cached.packs);
      setLoading(false);
    } else {
      setOpportunities([]);
      setPacks({});
      setLoading(true);
    }

    const opportunitiesQuery = query(collection(db, opportunitiesPath));
    const packsCollection = collection(db, `profiles/${userId}/application_packs`);

    try {
      setServerReadError(null);
      if (!cached) {
        try {
          const [cachedOppSnap, cachedPackSnap] = await Promise.all([
            getDocsFromCache(opportunitiesQuery),
            getDocsFromCache(packsCollection)
          ]);
          const cachedOpps: CareerRadarOpportunity[] = [];
          cachedOppSnap.forEach((doc) => {
            cachedOpps.push({ id: doc.id, ...doc.data() } as CareerRadarOpportunity);
          });
          const cachedPacks: { [opportunityId: string]: ApplicationPack } = {};
          cachedPackSnap.forEach((doc) => {
            cachedPacks[doc.id] = doc.data() as ApplicationPack;
          });

          if (cachedOpps.length > 0 || Object.keys(cachedPacks).length > 0) {
            const nextCache = { opportunities: sortOpportunities(cachedOpps), packs: cachedPacks };
            opportunitiesCache.set(userId, nextCache);
            setOpportunities(nextCache.opportunities);
            setPacks(nextCache.packs);
            setLoading(false);
          }
        } catch (_) {
          // Cache miss is expected on first load.
        }
      }

      const [qSnap, pSnap] = await Promise.all([
        getDocsFromServer(opportunitiesQuery),
        getDocsFromServer(packsCollection)
      ]);

      const items: CareerRadarOpportunity[] = [];
      qSnap.forEach((doc) => {
        items.push({ id: doc.id, ...doc.data() } as CareerRadarOpportunity);
      });
      const packsMap: { [opportunityId: string]: ApplicationPack } = {};
      pSnap.forEach((doc) => {
        const pack = doc.data() as ApplicationPack;
        packsMap[doc.id] = pack;
      });

      const nextCache = { opportunities: sortOpportunities(items), packs: packsMap };
      opportunitiesCache.set(userId, nextCache);
      setOpportunities(nextCache.opportunities);
      setPacks(nextCache.packs);
    } catch (err) {
      console.error('Error fetching opportunities:', err);
      setServerReadError(formatFirestoreServerError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData(refreshToken > 0);
  }, [userId, refreshToken]);

  useEffect(() => {
    fetch('/api/ai-cost-config')
      .then((response) => response.ok ? response.json() : null)
      .then((config) => {
        if (config) setCostConfig(config);
      })
      .catch((err) => console.warn('AI cost config unavailable:', err));
  }, []);

  useEffect(() => {
    localStorage.setItem('careerRadarDryRunAi', String(dryRunAi));
  }, [dryRunAi]);

  useEffect(() => {
    localStorage.setItem('careerRadarUseCachedOutput', String(useCachedOutput));
  }, [useCachedOutput]);

  const companyOptions = useMemo(() => {
    const names = opportunities
      .map((opp) => String(opp.company || '').trim())
      .filter((company): company is string => company.length > 0);
    return Array.from(new Set<string>(names)).sort((a, b) => a.localeCompare(b));
  }, [opportunities]);

  const visibleOpportunities = useMemo(() => {
    const search = opportunitySearch.trim().toLowerCase();
    return opportunities
      .filter((opp) => {
        const pack = opp.id ? packs[opp.id] : undefined;
        const searchableText = [
          opp.company,
          opp.role,
          opp.location,
          opp.decision,
          opp.analysisNotes,
          opp.roleDna,
          pack?.keywordsToEmphasize,
          pack?.cvAngle
        ].map((value) => safeText(value, '').toLowerCase()).join(' ');

        if (search && !searchableText.includes(search)) return false;
        if (companyFilter !== 'all' && safeText(opp.company, '') !== companyFilter) return false;
        if (scoreFilter === '85' && (opp.fitScore || 0) < 85) return false;
        if (scoreFilter === '65' && ((opp.fitScore || 0) < 65 || (opp.fitScore || 0) >= 85)) return false;
        if (scoreFilter === 'below65' && (opp.fitScore || 0) >= 65) return false;
        if (statusFilter === 'apply_now' && opp.decision !== 'Apply Now') return false;
        if (statusFilter === 'adjust' && opp.decision !== 'Apply After CV Adjustment') return false;
        if (statusFilter === 'stretch' && !opp.isStretchRole) return false;
        if (statusFilter === 'gap' && !((opp.fitScore || 0) < 65 || opp.decision === 'Verify First' || opp.decision === 'Skip')) return false;
        if (statusFilter === 'generated_cv' && !pack?.cvReadyLink && pack?.cvReadyStatus !== 'Generated') return false;
        if (statusFilter === 'not_applied' && pack?.cvReadyStatus === 'Submitted') return false;
        if (statusFilter === 'applied' && pack?.cvReadyStatus !== 'Submitted') return false;
        return true;
      })
      .sort((a, b) => {
        const packA = a.id ? packs[a.id] : undefined;
        const packB = b.id ? packs[b.id] : undefined;
        if (sortMode === 'highest_score') return (b.fitScore || 0) - (a.fitScore || 0);
        if (sortMode === 'apply_priority') return opportunityPriorityScore(b, packB) - opportunityPriorityScore(a, packA);
        if (sortMode === 'recent_cv') return timestampValue(packB?.cvReadyAt) - timestampValue(packA?.cvReadyAt);
        return timestampValue(b.createdAt) - timestampValue(a.createdAt);
      });
  }, [opportunities, packs, opportunitySearch, companyFilter, scoreFilter, statusFilter, sortMode]);

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm('Are you sure you want to delete this opportunity? This will also un-track associated packages.')) return;

    try {
      await deleteDoc(doc(db, opportunitiesPath, id));
      await deleteDoc(doc(db, `profiles/${userId}/application_packs`, id));
      opportunitiesCache.delete(userId);
      await fetchData();
      if (expandedId === id) setExpandedId(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `${opportunitiesPath}/${id}`);
    }
  };

  const copyText = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const updatePackInState = (opportunityId: string, nextPack: ApplicationPack) => {
    setPacks((current) => {
      const nextPacks = { ...current, [opportunityId]: nextPack };
      opportunitiesCache.set(userId, { opportunities, packs: nextPacks });
      return nextPacks;
    });
  };

  const setCvProgressStep = (opportunityId: string, currentStep: string, patch: Partial<CvGenerationProgress> = {}) => {
    setCvProgress((current) => {
      const existing = current[opportunityId] || {
        status: 'running',
        currentStep,
        steps: [],
        startedAt: new Date().toISOString()
      } satisfies CvGenerationProgress;
      const steps = existing.steps.includes(currentStep)
        ? existing.steps
        : [...existing.steps, currentStep];

      return {
        ...current,
        [opportunityId]: {
          ...existing,
          ...patch,
          currentStep,
          steps
        }
      };
    });
  };

  const loadCvContext = async (opp: CareerRadarOpportunity) => {
    const profileRef = doc(db, 'profiles', userId);
    const evidenceCollection = collection(db, `profiles/${userId}/cv_evidences`);
    const checklistQuery = query(collection(db, `profiles/${userId}/cv_checklists`));

    const [profileSnap, evidenceSnap, checklistSnap] = await Promise.all([
      getDocFromServer(profileRef),
      getDocsFromServer(evidenceCollection),
      getDocsFromServer(checklistQuery)
    ]).catch((err) => {
      throw new Error(formatFirestoreServerError(err));
    });

    const profile = profileSnap.exists()
      ? profileSnap.data() as Profile
      : { fullName: 'Anonymous User', education: '', experienceBrief: '', targetRoles: '', updatedAt: new Date().toISOString() };
    const evidences: CVEvidence[] = [];
    evidenceSnap.forEach((item) => evidences.push({ id: item.id, ...item.data() } as CVEvidence));
    const checklists: CVEditChecklist[] = [];
    checklistSnap.forEach((item) => {
      const checklist = { id: item.id, ...item.data() } as CVEditChecklist;
      if (checklist.opportunityId === opp.id) {
        checklists.push(checklist);
      }
    });

    return { profile, evidences, checklists };
  };

  const generateTemplateFields = async (
    opp: CareerRadarOpportunity,
    pack: ApplicationPack,
    profile: Profile,
    evidences: CVEvidence[],
    checklists: CVEditChecklist[],
    forceAi = false,
    options: { contextMode?: CvContextMode; overrideCostGuard?: boolean } = {}
  ): Promise<CvTemplateGenerationResult> => {
    const cachedFields = pack.cvGenerationDebug?.finalPlaceholderJson;
    if (useCachedOutput && !forceAi && cachedFields) {
      return {
        templateFields: validateCvTemplateFields(cachedFields),
        debug: pack.cvGenerationDebug
      };
    }

    const response = await fetch('/api/generate-cv-template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile,
        opportunity: opp,
        pack,
        evidences,
        checklists,
        dryRun: dryRunAi,
        useCachedOutput,
        contextMode: options.contextMode || 'standard',
        overrideCostGuard: Boolean(options.overrideCostGuard)
      })
    });

    if (!response.ok) {
      let errorMessage = 'CV template generation failed.';
      try {
        const errorData = await response.json();
        errorMessage = errorData.error || errorMessage;
      } catch (_) {}
      throw new Error(errorMessage);
    }

    const data = await response.json();
    if (data.dryRun) {
      throw new Error(`Dry Run only: ${data.inputCharacterCount?.toLocaleString?.() || data.inputCharacterCount} input chars, about ${data.estimatedInputTokens?.toLocaleString?.() || data.estimatedInputTokens} tokens, ${data.selectedEvidenceCount} evidence items selected. No Gemini call was made.`);
    }

    return {
      templateFields: validateCvTemplateFields(data.fields || data),
      debug: data.debug
    };
  };

  const previewCvTemplateRequest = async (
    opp: CareerRadarOpportunity,
    pack: ApplicationPack,
    profile: Profile,
    evidences: CVEvidence[],
    checklists: CVEditChecklist[],
    contextMode: CvContextMode
  ): Promise<CvRequestPreview> => {
    const response = await fetch('/api/generate-cv-template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile,
        opportunity: opp,
        pack,
        evidences,
        checklists,
        dryRun: true,
        useCachedOutput,
        contextMode
      })
    });

    if (!response.ok) {
      let errMsg = 'CV request preview failed on back-end server.';
      try {
        const errData = await response.json();
        if (errData?.error) errMsg = errData.error;
      } catch (_) {}
      throw new Error(errMsg);
    }

    const data = await response.json();
    return {
      endpointName: data.endpointName || '/api/generate-cv-template',
      model: data.model || costConfig?.model || 'gemini',
      opportunityId: data.opportunityId || opp.id,
      company: data.company || opp.company,
      role: data.role || opp.role,
      inputCharacterCount: Number(data.inputCharacterCount || 0),
      estimatedInputTokens: Number(data.estimatedInputTokens || 0),
      selectedEvidenceCount: Number(data.selectedEvidenceCount || 0),
      selectedEvidenceIds: Array.isArray(data.selectedEvidenceIds) ? data.selectedEvidenceIds : [],
      readyChecklistRowsCount: Number(data.readyChecklistRowsCount || 0),
      contextMode: data.contextMode === 'compact' ? 'compact' : 'standard',
      maxInputCharsPerCall: Number(data.maxInputCharsPerCall || costConfig?.maxInputCharsPerCall || 0),
      maxEvidenceItemsPerCall: Number(data.maxEvidenceItemsPerCall || costConfig?.maxEvidenceItemsPerCall || 0),
      jobTextWasTruncated: Boolean(data.jobTextWasTruncated),
      contextSent: Array.isArray(data.contextSent) ? data.contextSent : [],
      contextExcludedOrReduced: Array.isArray(data.contextExcludedOrReduced) ? data.contextExcludedOrReduced : []
    };
  };

  const downloadCv = async (opp: CareerRadarOpportunity, pack: ApplicationPack, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!opp.id) return;

    setDownloadingCvId(opp.id);
    setCvError(null);

    try {
      const { profile, evidences, checklists } = await loadCvContext(opp);
      const { templateFields, debug } = await generateTemplateFields(opp, pack, profile, evidences, checklists);
      if (debug) {
        setCvDebugs((current) => ({ ...current, [opp.id || '']: debug }));
      }
      downloadCvDoc({ profile, opportunity: opp, pack, evidences, checklists, templateFields });
    } catch (err) {
      console.error('CV download failed:', err);
      setCvError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloadingCvId(null);
    }
  };

  const generateCvToDrive = async (
    opp: CareerRadarOpportunity,
    pack: ApplicationPack,
    e?: React.MouseEvent,
    options: { contextMode?: CvContextMode; overrideCostGuard?: boolean; skipPreflight?: boolean } = {}
  ) => {
    e?.stopPropagation();
    if (!opp.id) return;

    const hasCachedCvJson = Boolean(pack.cvGenerationDebug?.finalPlaceholderJson);
    const isRegenerate = Boolean(pack.cvReadyLink || hasCachedCvJson);
    if (!dryRunAi && isRegenerate && !useCachedOutput && costConfig?.requireConfirmForRegenerate) {
      const proceed = window.confirm('Regenerate with AI will spend another Gemini call. Turn on Use Cached Output to reuse the existing CV JSON. Continue?');
      if (!proceed) return;
    }

    const folderId = extractDriveFolderId(driveFolderInput);
    localStorage.setItem('careerRadarCvDriveFolder', driveFolderInput.trim());
    setGeneratingCvId(opp.id);
    setCvError(null);
    setBlockedCvRequest(null);
    const startedAt = new Date().toISOString();
    const generatingPack: ApplicationPack = {
      ...pack,
      cvReadyStatus: 'Generating',
      cvReadyAt: startedAt,
      cvReadyNotes: 'Requesting Google Drive/Docs access...',
      updatedAt: startedAt
    };
    updatePackInState(opp.id, generatingPack);
    setCvProgressStep(opp.id, 'Requesting Google Drive/Docs access', {
      status: 'running',
      startedAt
    });

    try {
      setCvProgressStep(opp.id, 'Loading profile and evidence context');
      const { profile, evidences, checklists } = await loadCvContext(opp);
      const usingCachedJson = useCachedOutput && hasCachedCvJson;
      const contextMode = options.contextMode || 'standard';

      if (!dryRunAi && !usingCachedJson && !options.skipPreflight) {
        setCvProgressStep(opp.id, contextMode === 'compact' ? 'Preparing compact AI request preview' : 'Preparing AI request preview');
        const preview = await previewCvTemplateRequest(opp, pack, profile, evidences, checklists, contextMode);
        const maxChars = preview.maxInputCharsPerCall || costConfig?.maxInputCharsPerCall || 0;
        if (maxChars > 0 && preview.inputCharacterCount > maxChars && !options.overrideCostGuard) {
          const reason = `CV request is ${preview.inputCharacterCount.toLocaleString()} chars, above the configured ${maxChars.toLocaleString()} char guard.`;
          setBlockedCvRequest({ opportunity: opp, pack, preview, reason });
          setCvError(reason);
          setCvProgressStep(opp.id, 'Needs decision before AI call', {
            status: 'error',
            finishedAt: new Date().toISOString(),
            errorMessage: reason
          });
          updatePackInState(opp.id, pack);
          setGeneratingCvId(null);
          return;
        }
      }

      let accessToken = '';
      if (!dryRunAi) {
        if (!usingCachedJson) {
          setCvProgressStep(opp.id, 'Requesting Google Drive/Docs access');
        }
        accessToken = await requestGoogleDriveAccessToken();
      }

      setCvProgressStep(opp.id, useCachedOutput && hasCachedCvJson ? 'Using cached CV placeholder JSON' : 'Generating CV placeholder JSON');
      const { templateFields, debug } = await generateTemplateFields(opp, pack, profile, evidences, checklists, false, {
        contextMode,
        overrideCostGuard: Boolean(options.overrideCostGuard)
      });
      if (debug) {
        setCvDebugs((current) => ({ ...current, [opp.id || '']: debug }));
      }

      if (dryRunAi) {
        throw new Error('Dry Run complete: CV placeholder request was previewed without a Gemini or Google Docs call.');
      }

      await updateDoc(doc(db, `profiles/${userId}/application_packs`, opp.id), {
        cvReadyStatus: 'Generating',
        cvReadyAt: startedAt,
        cvReadyNotes: 'Copying Google Docs template...',
        updatedAt: new Date().toISOString()
      });

      setCvProgressStep(opp.id, 'Copying Google Docs template');
      const driveDoc = await createCvGoogleDoc({
        accessToken,
        folderId,
        profile,
        opportunity: opp,
        pack,
        evidences,
        checklists,
        templateFields,
        onProgress: (step) => {
          setCvProgressStep(
            opp.id || '',
            step === 'copying_template' ? 'Copying Google Docs template' : 'Replacing placeholders'
          );
        }
      });

      const templateWarnings = driveDoc.warnings || [];
      const debugWithTemplateWarnings = debug
        ? {
            ...debug,
            templateWarnings: [
              ...(debug.templateWarnings || []),
              ...templateWarnings
            ]
          }
        : undefined;

      if (debugWithTemplateWarnings) {
        setCvDebugs((current) => ({ ...current, [opp.id || '']: debugWithTemplateWarnings }));
      }

      setCvProgressStep(opp.id, 'Saving generated CV link');
      const updatedPack: ApplicationPack = {
        ...pack,
        cvReadyLink: driveDoc.webViewLink,
        cvReadyStatus: 'Generated',
        cvReadyAt: new Date().toISOString(),
        cvReadyNotes: templateWarnings.length
          ? `Generated as Google Docs: ${driveDoc.name}. ${templateWarnings.join(' ')}`
          : `Generated as Google Docs: ${driveDoc.name}`,
        cvGenerationDebug: debugWithTemplateWarnings,
        updatedAt: new Date().toISOString()
      };

      const updatePayload: Record<string, unknown> = {
        cvReadyLink: updatedPack.cvReadyLink,
        cvReadyStatus: updatedPack.cvReadyStatus,
        cvReadyAt: updatedPack.cvReadyAt,
        cvReadyNotes: updatedPack.cvReadyNotes,
        updatedAt: updatedPack.updatedAt
      };

      if (debugWithTemplateWarnings) {
        updatePayload.cvGenerationDebug = JSON.parse(JSON.stringify(debugWithTemplateWarnings));
      }

      await updateDoc(doc(db, `profiles/${userId}/application_packs`, opp.id), updatePayload);

      updatePackInState(opp.id, updatedPack);
      setCvProgressStep(opp.id, 'Done', {
        status: 'success',
        finishedAt: updatedPack.cvReadyAt,
        documentName: driveDoc.name,
        documentLink: driveDoc.webViewLink
      });
    } catch (err) {
      console.error('CV generation failed:', err);
      const message = err instanceof Error ? err.message : String(err);
      if (dryRunAi && message.startsWith('Dry Run')) {
        setCvError(message);
        setCvProgressStep(opp.id, 'Dry Run complete', {
          status: 'success',
          finishedAt: new Date().toISOString(),
          errorMessage: message
        });
        updatePackInState(opp.id, pack);
        return;
      }

      setCvError(message);
      const failedAt = new Date().toISOString();
      const failedPack: ApplicationPack = {
        ...pack,
        cvReadyStatus: 'Failed',
        cvReadyAt: failedAt,
        cvReadyNotes: message,
        updatedAt: failedAt
      };
      updatePackInState(opp.id, failedPack);
      setCvProgressStep(opp.id, 'Failed', {
        status: 'error',
        finishedAt: failedAt,
        errorMessage: message
      });
      try {
        await updateDoc(doc(db, `profiles/${userId}/application_packs`, opp.id), {
          cvReadyStatus: 'Failed',
          cvReadyAt: failedAt,
          cvReadyNotes: message,
          updatedAt: failedAt
        });
      } catch (updateErr) {
        console.error('Failed to persist CV failure status:', updateErr);
      }
    } finally {
      setGeneratingCvId(null);
    }
  };

  return (
    <div id="opportunities_panel" className="py-6 font-sans">
      <div className="md:flex md:items-center md:justify-between mb-8">
        <div className="flex-1 min-w-0">
          <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl tracking-tight flex items-center space-x-2">
            <Briefcase className="h-7 w-7 text-emerald-600" />
            <span>Target Opportunities</span>
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Browse match-screened jobs, view custom fit parameters, and extract custom summary rewrites, outreach pitches, and recruiter message templates.
          </p>
        </div>
      </div>

      {loading && (
        <div className="mb-6 inline-flex items-center gap-2 text-xs font-semibold text-slate-400">
          <span className="h-3.5 w-3.5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin"></span>
          <span>Loading latest saved opportunities...</span>
        </div>
      )}

      {serverReadError && (
        <div className="mb-6 rounded-2xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <div className="font-bold text-rose-900">Firestore server read failed</div>
          <div className="mt-1">{serverReadError}</div>
        </div>
      )}

      {blockedCvRequest && (
        <div className="mb-6 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900 shadow-sm">
          <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
            <div>
              <div className="text-xs font-extrabold uppercase tracking-wider text-amber-700">Expensive AI Request Needs Decision</div>
              <h3 className="mt-1 text-lg font-extrabold text-slate-900">
                {safeText(blockedCvRequest.opportunity.company)} - {safeText(blockedCvRequest.opportunity.role)}
              </h3>
              <p className="mt-2 leading-relaxed">{blockedCvRequest.reason} No Gemini call has been made yet.</p>
              <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-2 text-xs">
                <div className="rounded-xl bg-white/70 px-3 py-2 border border-amber-100">
                  <div className="font-bold text-slate-500">Endpoint</div>
                  <div className="font-semibold">{blockedCvRequest.preview.endpointName}</div>
                </div>
                <div className="rounded-xl bg-white/70 px-3 py-2 border border-amber-100">
                  <div className="font-bold text-slate-500">Input</div>
                  <div className="font-semibold">{blockedCvRequest.preview.inputCharacterCount.toLocaleString()} chars</div>
                </div>
                <div className="rounded-xl bg-white/70 px-3 py-2 border border-amber-100">
                  <div className="font-bold text-slate-500">Tokens</div>
                  <div className="font-semibold">~{blockedCvRequest.preview.estimatedInputTokens.toLocaleString()}</div>
                </div>
                <div className="rounded-xl bg-white/70 px-3 py-2 border border-amber-100">
                  <div className="font-bold text-slate-500">Evidence</div>
                  <div className="font-semibold">{blockedCvRequest.preview.selectedEvidenceCount} selected</div>
                </div>
              </div>
              <div className="mt-3 text-xs leading-relaxed text-amber-800">
                Compact Context keeps role DNA, top verified evidence, eligibility evidence, CV rules, tone guard, and one-page constraints while reducing raw job text, debug logs, duplicate generated text, and lower-ranked evidence.
              </div>
            </div>
            <div className="flex shrink-0 flex-col gap-2 min-w-[220px]">
              <button
                type="button"
                onClick={() => generateCvToDrive(blockedCvRequest.opportunity, blockedCvRequest.pack, undefined, { contextMode: 'compact' })}
                className="rounded-xl bg-emerald-600 px-4 py-2.5 text-xs font-extrabold text-white shadow-sm hover:bg-emerald-700"
              >
                Use Compact Context
              </button>
              <button
                type="button"
                onClick={() => {
                  const ok = window.confirm(`Continue anyway with ${blockedCvRequest.preview.inputCharacterCount.toLocaleString()} input chars (~${blockedCvRequest.preview.estimatedInputTokens.toLocaleString()} tokens)? This may cost more.`);
                  if (ok) {
                    generateCvToDrive(blockedCvRequest.opportunity, blockedCvRequest.pack, undefined, {
                      contextMode: blockedCvRequest.preview.contextMode || 'standard',
                      overrideCostGuard: true,
                      skipPreflight: true
                    });
                  }
                }}
                className="rounded-xl border border-amber-300 bg-white px-4 py-2.5 text-xs font-extrabold text-amber-800 hover:bg-amber-100"
              >
                Continue Anyway
              </button>
              <button
                type="button"
                onClick={() => {
                  setBlockedCvRequest(null);
                  setCvError(null);
                }}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-extrabold text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
          </div>
          {(blockedCvRequest.preview.selectedEvidenceIds || []).length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {(blockedCvRequest.preview.selectedEvidenceIds || []).map((id) => (
                <span key={id} className="rounded bg-white px-2 py-1 text-[11px] font-bold text-slate-700 border border-amber-100">{id}</span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mb-6 bg-white border border-slate-100 rounded-2xl p-4 shadow-sm">
        <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">
          Google Drive CV Folder
        </label>
        <div className="flex flex-col md:flex-row gap-3">
          <div className="relative flex-1">
            <FolderInput className="h-4 w-4 text-slate-300 absolute left-3 top-3" />
            <input
              type="text"
              value={driveFolderInput}
              onChange={(event) => setDriveFolderInput(event.target.value)}
              placeholder="Paste Drive folder URL or folder ID. Leave blank to save in My Drive."
              className="w-full text-sm border border-slate-200 rounded-xl pl-9 pr-3 py-2.5 bg-slate-50 outline-none focus:bg-white focus:ring-1 focus:ring-emerald-500/50"
            />
          </div>
        </div>
        <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50/70 px-4 py-3 text-xs text-slate-600">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
            <div>
              <div className="font-bold text-slate-700">CV AI budget controls</div>
              <div className="mt-1">
                Model: {costConfig?.model || 'gemini'} · CV JSON: {dryRunAi ? '0 calls in Dry Run' : '1 call unless cached'} · Daily dev usage: {costConfig ? `${costConfig.dailyAiCallsUsed}/${costConfig.dailyAiCallLimitDev}` : 'loading'}
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <label className="inline-flex items-center gap-2 font-bold">
                <input
                  type="checkbox"
                  checked={dryRunAi}
                  onChange={(event) => setDryRunAi(event.target.checked)}
                  className="rounded border-slate-300 text-emerald-600"
                />
                <span>Dry Run / No AI</span>
              </label>
              <label className="inline-flex items-center gap-2 font-bold">
                <input
                  type="checkbox"
                  checked={useCachedOutput}
                  onChange={(event) => setUseCachedOutput(event.target.checked)}
                  className="rounded border-slate-300 text-emerald-600"
                />
                <span>Use Cached Output</span>
              </label>
            </div>
          </div>
        </div>
        {cvError && (
          <p className="mt-3 text-xs font-semibold text-rose-600 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2">
            {cvError}
          </p>
        )}
      </div>

      <div className="mb-6 bg-white border border-slate-100 rounded-2xl p-4 shadow-sm">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 mb-4">
          <div>
            <h3 className="text-sm font-extrabold text-slate-800">Find Opportunities</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Showing {visibleOpportunities.length} of {opportunities.length} saved opportunities.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setOpportunitySearch('');
              setStatusFilter('all');
              setScoreFilter('all');
              setCompanyFilter('all');
              setSortMode('newest');
            }}
            className="self-start lg:self-auto rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
          >
            Reset filters
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
          <input
            type="search"
            value={opportunitySearch}
            onChange={(event) => setOpportunitySearch(event.target.value)}
            placeholder="Search company, role, keyword..."
            className="xl:col-span-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:bg-white focus:ring-1 focus:ring-emerald-500/50"
          />
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as OpportunityStatusFilter)}
            className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-semibold text-slate-700 outline-none focus:bg-white focus:ring-1 focus:ring-emerald-500/50"
          >
            <option value="all">All statuses</option>
            <option value="apply_now">Apply Now</option>
            <option value="adjust">Apply After CV Adjustment</option>
            <option value="stretch">Stretch Growth</option>
            <option value="gap">Gap Identified</option>
            <option value="generated_cv">Generated CV</option>
            <option value="not_applied">Not Applied</option>
            <option value="applied">Applied</option>
            <option value="saved">Saved</option>
          </select>
          <select
            value={scoreFilter}
            onChange={(event) => setScoreFilter(event.target.value as ScoreFilter)}
            className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-semibold text-slate-700 outline-none focus:bg-white focus:ring-1 focus:ring-emerald-500/50"
          >
            <option value="all">All scores</option>
            <option value="85">85+ high match</option>
            <option value="65">65-84 workable</option>
            <option value="below65">Below 65</option>
          </select>
          <select
            value={sortMode}
            onChange={(event) => setSortMode(event.target.value as OpportunitySortMode)}
            className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-semibold text-slate-700 outline-none focus:bg-white focus:ring-1 focus:ring-emerald-500/50"
          >
            <option value="newest">Newest scanned</option>
            <option value="highest_score">Highest match score</option>
            <option value="apply_priority">Apply priority</option>
            <option value="recent_cv">Recently generated CV</option>
          </select>
          <select
            value={companyFilter}
            onChange={(event) => setCompanyFilter(event.target.value)}
            className="md:col-span-2 xl:col-span-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-semibold text-slate-700 outline-none focus:bg-white focus:ring-1 focus:ring-emerald-500/50"
          >
            <option value="all">All companies</option>
            {companyOptions.map((company) => (
              <option key={company} value={company}>{company}</option>
            ))}
          </select>
        </div>
      </div>

      {!loading && opportunities.length === 0 ? (
        <div className="text-center py-16 bg-white border border-slate-100 rounded-2xl">
          <Briefcase className="h-12 w-12 text-slate-300 mx-auto mb-3" />
          <p className="text-sm text-slate-500">No matched opportunities saved to database yet.</p>
          <p className="text-xs text-slate-400 mt-1">Use the <strong>AI Career Radar</strong> panel to analyze and align a job description first.</p>
        </div>
      ) : !loading && visibleOpportunities.length === 0 ? (
        <div className="text-center py-12 bg-white border border-slate-100 rounded-2xl">
          <Briefcase className="h-10 w-10 text-slate-300 mx-auto mb-3" />
          <p className="text-sm font-semibold text-slate-600">No opportunities match the current filters.</p>
          <p className="text-xs text-slate-400 mt-1">Try clearing search, company, score, or status filters.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {visibleOpportunities.map((opp) => {
            const isExpanded = expandedId === opp.id;
            const pack = opp.id ? packs[opp.id] : null;
            const rawCvDebug = opp.id ? (cvDebugs[opp.id] || pack?.cvGenerationDebug) : undefined;
            const cvDebug = normalizeCvDebug(rawCvDebug);
            const debugRowsExpanded = Boolean(opp.id && expandedDebugRows[opp.id]);
            const mappingRows = cvDebug ? (debugRowsExpanded ? cvDebug.evidenceMappings : cvDebug.evidenceMappings.slice(0, 10)) : [];
            const generationProgress = opp.id ? cvProgress[opp.id] : undefined;
            const handleExpandClick = () => {
              if (!isExpanded) {
                console.info('Expanding opportunity data shape:', {
                  id: opp.id,
                  company: safeText(opp.company),
                  role: safeText(opp.role),
                  roleDnaType: Array.isArray(opp.roleDna) ? 'array' : typeof opp.roleDna,
                  educationFitType: Array.isArray(opp.educationFit) ? 'array' : typeof opp.educationFit,
                  experienceFitType: Array.isArray(opp.experienceFit) ? 'array' : typeof opp.experienceFit,
                  portfolioFitType: Array.isArray(opp.portfolioFit) ? 'array' : typeof opp.portfolioFit,
                  hasPack: Boolean(pack),
                  cvDebugKeys: rawCvDebug && isRecord(rawCvDebug) ? Object.keys(rawCvDebug) : [],
                  evidenceMappingsCount: cvDebug?.evidenceMappings.length || 0,
                  finalPlaceholderJsonType: rawCvDebug && isRecord(rawCvDebug) ? typeof rawCvDebug.finalPlaceholderJson : 'missing'
                });
              }
              setExpandedId(isExpanded ? null : (opp.id || null));
            };

            return (
              <div
                key={opp.id}
                className="bg-white border border-slate-100 rounded-2xl shadow-sm hover:shadow-md transition-shadow overflow-hidden"
              >
                {/* Header card click to expand */}
                <div
                  onClick={handleExpandClick}
                  className="p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4 cursor-pointer select-none"
                >
                  <div className="flex items-start space-x-4">
                    {/* Fit score circle badge */}
                    <div className={`h-14 w-14 shrink-0 rounded-full border flex flex-col items-center justify-center font-extrabold ${
                      opp.fitScore >= 85 ? 'bg-emerald-50 text-emerald-700 border-emerald-100' :
                      opp.fitScore >= 65 ? 'bg-amber-50 text-amber-700 border-amber-100' : 'bg-rose-50 text-rose-700 border-rose-100'
                    }`}>
                      <span className="text-sm leading-none">{opp.fitScore}%</span>
                      <span className="text-[8px] uppercase tracking-wide mt-0.5 font-semibold text-slate-400">Match</span>
                    </div>

                    <div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs font-bold text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded-full">
                          {opp.decision}
                        </span>
                        {opp.isStretchRole && (
                          <span className="text-xs font-bold text-indigo-800 bg-indigo-50 px-2 py-0.5 rounded-full">
                            Stretch Growth
                          </span>
                        )}
                        {opp.hasRedFlags && (
                          <span className="text-xs font-bold text-rose-800 bg-rose-50 px-2 py-0.5 rounded-full flex items-center">
                            <AlertTriangle className="h-3 w-3 mr-0.5 text-rose-600" />
                            <span>Gap Identified</span>
                          </span>
                        )}
                      </div>

                      <h4 className="text-base font-bold text-slate-800 tracking-tight leading-snug mt-1">
                        {safeText(opp.role)}
                      </h4>
                      <p className="text-xs text-slate-400 font-medium mt-0.5 flex items-center gap-1">
                        <Building className="h-3.5 w-3.5" />
                        <span>{safeText(opp.company)}</span>
                        {opp.location && (
                          <>
                            <span>•</span>
                            <MapPin className="h-3.5 w-3.5 text-slate-300" />
                            <span>{safeText(opp.location)}</span>
                          </>
                        )}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center space-x-4 self-end sm:self-center">
                    <span className="text-xs text-slate-400 font-mono hidden sm:inline">
                      Scanned: {new Date(opp.createdAt).toLocaleDateString()}
                    </span>

                    {/* Controls */}
                    <div className="flex space-x-2">
                      {opp.applyLink && (
                        <a
                          href={opp.applyLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-slate-50 border border-slate-100 rounded-lg transition-colors cursor-pointer"
                          title="Apply link"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      )}
                      <button
                        onClick={(e) => handleDelete(opp.id || '', e)}
                        className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-slate-50 border border-slate-100 rounded-lg transition-colors cursor-pointer"
                        title="Delete opportunity"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                      <button className="p-1 text-slate-400 rounded hover:bg-slate-50 transition-colors">
                        {isExpanded ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Expanded Details section */}
                <OpportunityExpansionBoundary resetKey={`${opp.id || 'unknown'}-${isExpanded ? 'open' : 'closed'}`}>
                {isExpanded && (
                  <div className="border-t border-slate-100 bg-slate-50/50 p-6 sm:p-8 animate-fade-in space-y-6">
                    {/* Synthesis Cards */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="space-y-4">
                        <div>
                          <h5 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Role Requirements (DNA)</h5>
                          <p className="text-sm font-normal text-slate-600 bg-white p-3.5 rounded-xl border border-slate-100 leading-relaxed mt-1">{safeText(opp.roleDna)}</p>
                        </div>
                        <div>
                          <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Academic & Background Fit</h4>
                          <p className="text-sm font-normal text-slate-600 bg-white p-3.5 rounded-xl border border-slate-100 leading-relaxed mt-1">{safeText(opp.educationFit)}</p>
                        </div>
                      </div>

                      <div className="space-y-4">
                        <div>
                          <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Candidate Experience Fit</h4>
                          <p className="text-sm font-normal text-slate-600 bg-white p-3.5 rounded-xl border border-slate-100 leading-relaxed mt-1">{safeText(opp.experienceFit)}</p>
                        </div>
                        <div>
                          <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Portfolio Grounding (Matched Highlights)</h4>
                          <p className="text-sm font-normal text-slate-600 bg-emerald-50/10 p-3.5 rounded-xl border border-emerald-100 leading-relaxed mt-1">{safeText(opp.portfolioFit)}</p>
                        </div>
                      </div>
                    </div>

                    {opp.hasRedFlags && (
                      <div className="p-4 bg-rose-50/40 border border-rose-100 rounded-xl text-rose-800 text-sm">
                        <h4 className="font-bold flex items-center text-rose-900 mb-1">
                          <AlertTriangle className="h-4.5 w-4.5 mr-1.5 text-rose-600" />
                          <span>Identified Security / Skills Flags</span>
                        </h4>
                        <p className="text-xs leading-relaxed">{safeText(opp.redFlags)}</p>
                      </div>
                    )}

                    {/* Matches Pack */}
                    {pack ? (
                      <div className="bg-white border border-slate-200/60 rounded-2xl p-5 sm:p-6 space-y-5 shadow-sm">
                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                          <div className="flex items-center space-x-2">
                            <FileText className="h-5 w-5 text-emerald-600" />
                            <h4 className="text-sm font-bold text-slate-800">Available Application Pack Outputs</h4>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {pack.cvReadyLink && (
                              <a
                                href={pack.cvReadyLink}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(event) => event.stopPropagation()}
                                className="inline-flex items-center gap-1.5 px-3 py-2 border border-emerald-100 bg-emerald-50 text-emerald-700 rounded-xl text-xs font-bold hover:bg-emerald-100"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                                <span>Open CV</span>
                              </a>
                            )}
                            <button
                              type="button"
                              onClick={(event) => downloadCv(opp, pack, event)}
                              disabled={downloadingCvId === opp.id}
                              className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-200 bg-white hover:bg-slate-50 disabled:bg-slate-100 text-slate-600 rounded-xl text-xs font-bold"
                            >
                              <Download className={`h-3.5 w-3.5 ${downloadingCvId === opp.id ? 'animate-pulse' : ''}`} />
                              <span>{downloadingCvId === opp.id ? 'Preparing...' : 'Download DOC'}</span>
                            </button>
                            <button
                              type="button"
                              onClick={(event) => generateCvToDrive(opp, pack, event)}
                              disabled={generatingCvId === opp.id}
                              className="inline-flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 disabled:bg-slate-400 text-white rounded-xl text-xs font-bold shadow-sm"
                            >
                              <Wand2 className={`h-3.5 w-3.5 ${generatingCvId === opp.id ? 'animate-pulse' : ''}`} />
                              <span>
                                {generatingCvId === opp.id
                                  ? 'Generating CV...'
                                  : dryRunAi
                                    ? 'Preview CV AI Request'
                                    : pack.cvGenerationDebug?.finalPlaceholderJson && useCachedOutput
                                      ? 'Create CV from Cached JSON'
                                      : pack.cvReadyLink || pack.cvGenerationDebug?.finalPlaceholderJson
                                        ? 'Regenerate CV with AI'
                                        : 'Generate CV to Drive'}
                              </span>
                            </button>
                          </div>
                        </div>

                        {(generationProgress || pack.cvReadyStatus || pack.cvReadyLink) && (
                          <div className={`rounded-xl border px-4 py-3 text-xs ${
                            generationProgress?.status === 'error' || pack.cvReadyStatus === 'Failed'
                              ? 'border-rose-100 bg-rose-50 text-rose-700'
                              : generationProgress?.status === 'success' || pack.cvReadyStatus === 'Generated'
                                ? 'border-emerald-100 bg-emerald-50 text-emerald-700'
                                : 'border-slate-100 bg-slate-50 text-slate-600'
                          }`}>
                            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                              <div>
                                <div className="font-bold">
                                  {generationProgress?.status === 'success' || pack.cvReadyStatus === 'Generated'
                                    ? 'CV generated successfully'
                                    : generationProgress?.status === 'error' || pack.cvReadyStatus === 'Failed'
                                      ? 'CV generation failed'
                                      : pack.cvReadyStatus === 'Generating'
                                        ? 'CV generation in progress'
                                        : `CV status: ${safeText(pack.cvReadyStatus, 'Draft')}`}
                                </div>
                                <div className="mt-1 leading-relaxed">
                                  {generationProgress?.currentStep || safeText(pack.cvReadyNotes, '')}
                                </div>
                                {(generationProgress?.startedAt || pack.cvReadyAt) && (
                                  <div className="mt-1 text-[11px] opacity-80">
                                    Updated: {new Date(generationProgress?.finishedAt || generationProgress?.startedAt || pack.cvReadyAt || '').toLocaleString()}
                                  </div>
                                )}
                                {generationProgress?.steps?.length ? (
                                  <ol className="mt-2 list-decimal pl-4 space-y-0.5 text-[11px]">
                                    {generationProgress.steps.map((step) => (
                                      <li key={`${opp.id}-${step}`}>{step}</li>
                                    ))}
                                  </ol>
                                ) : null}
                                {(generationProgress?.documentName || pack.cvReadyNotes) && (
                                  <div className="mt-1 text-[11px] opacity-80">
                                    {safeText(generationProgress?.documentName || pack.cvReadyNotes, '')}
                                  </div>
                                )}
                                {(generationProgress?.errorMessage || (pack.cvReadyStatus === 'Failed' ? pack.cvReadyNotes : '')) && (
                                  <div className="mt-1 text-[11px] font-semibold">
                                    {safeText(generationProgress?.errorMessage || pack.cvReadyNotes, '')}
                                  </div>
                                )}
                              </div>
                              {(generationProgress?.documentLink || pack.cvReadyLink) && (
                                <a
                                  href={generationProgress?.documentLink || pack.cvReadyLink}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(event) => event.stopPropagation()}
                                  className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-white border border-current font-bold hover:bg-white/70"
                                >
                                  <ExternalLink className="h-3.5 w-3.5" />
                                  <span>Open Generated CV</span>
                                </a>
                              )}
                            </div>
                          </div>
                        )}

                        {cvDebug && (
                          <details className="border border-emerald-100 rounded-xl bg-emerald-50/20">
                            <summary className="cursor-pointer p-4 text-xs font-bold text-slate-700">
                              CV Brain Debug
                              <span className="ml-2 font-normal text-slate-500">
                                {cvDebug.roleDna.primaryDirection} · {cvDebug.cvBaseVersion} · summary: {cvDebug.summarySource}
                              </span>
                            </summary>
                            <div className="px-4 pb-4 space-y-4">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-[10px] font-bold text-emerald-700 uppercase tracking-widest bg-white border border-emerald-100 px-2 py-1 rounded-lg">
                                CV Brain Debug
                              </span>
                              <span className="text-xs font-bold text-slate-700">
                                {cvDebug.roleDna.primaryDirection}
                              </span>
                              <span className="text-xs text-slate-500">
                                Version: <strong>{cvDebug.cvBaseVersion}</strong>
                              </span>
                              <span className="text-xs text-slate-500">
                                Evidence IDs: {safeJoin(cvDebug.evidenceIdsUsed) || '-'}
                              </span>
                              <span className="text-xs text-slate-500">
                                Summary source: <strong>{cvDebug.summarySource || '-'}</strong>
                              </span>
                            </div>

                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                              <div className="bg-white/80 border border-emerald-100 rounded-xl p-3">
                                <h5 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Role DNA Signals</h5>
                                <p className="text-xs text-slate-600 leading-relaxed">
                                  Industry: {safeJoin(cvDebug.roleDna.industrySignals) || '-'}<br />
                                  Function: {safeJoin(cvDebug.roleDna.functionSignals) || '-'}<br />
                                  Seniority: {cvDebug.roleDna.seniorityLevel}<br />
                                  Hard skills: {safeJoin(cvDebug.roleDna.hardSkillSignals) || '-'}<br />
                                  Soft skills: {safeJoin(cvDebug.roleDna.softSkillSignals) || '-'}
                                </p>
                              </div>

                              <div className="bg-white/80 border border-emerald-100 rounded-xl p-3">
                                <h5 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Certification Priority & Noise Rules</h5>
                                <p className="text-xs text-slate-600 leading-relaxed">
                                  Priority: {safeJoin(cvDebug.certificationPriority, ' | ') || '-'}<br />
                                  Raw candidates: {cvDebug.rawCertificationCandidates?.length || 0}<br />
                                  Dynamic certifications selected: {cvDebug.certificationEvidenceSelected?.length || 0}<br />
                                  Final string length: {cvDebug.finalCertificationStringLength || 0}<br />
                                  One-page compression: {cvDebug.onePageCompressionMode ? 'true' : 'false'}<br />
                                  Ignored unverified IDs: {safeJoin(cvDebug.ignoredUnverifiedEvidenceIds) || '-'}<br />
                                  Verified evidence count: {cvDebug.verifiedEvidenceCount}<br />
                                  Qualification promotions: {cvDebug.qualificationPromotions.length}
                                </p>
                              </div>
                            </div>

                            {(cvDebug.onePageRiskWarning || cvDebug.englishEvidenceWarning || cvDebug.qualityWarnings.length > 0 || (cvDebug.templateWarnings?.length || 0) > 0) && (
                              <div className="bg-amber-50/70 border border-amber-100 rounded-xl p-3 text-xs text-amber-800">
                                <h5 className="text-[10px] font-bold uppercase tracking-widest mb-2">CV Quality Warnings</h5>
                                {cvDebug.onePageRiskWarning && <p className="mb-1">{cvDebug.onePageRiskWarning}</p>}
                                {cvDebug.englishEvidenceWarning && <p className="mb-1">{cvDebug.englishEvidenceWarning}</p>}
                                {(cvDebug.templateWarnings?.length || 0) > 0 && (
                                  <ul className="list-disc pl-4 space-y-0.5 mb-1">
                                    {cvDebug.templateWarnings?.map((warning, index) => (
                                      <li key={`${opp.id}-template-warning-${index}`}>{safeText(warning)}</li>
                                    ))}
                                  </ul>
                                )}
                                {cvDebug.qualityWarnings.length > 0 && (
                                  <ul className="list-disc pl-4 space-y-0.5">
                                    {cvDebug.qualityWarnings.map((warning, index) => (
                                      <li key={`${opp.id}-quality-${index}`}>{safeText(warning)}</li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            )}

                            {(cvDebug.certificationEvidenceSelected?.length || 0) > 0 && (
                              <div className="overflow-x-auto border border-emerald-100 rounded-xl bg-white/80">
                                <table className="min-w-full text-left text-xs">
                                  <thead className="bg-emerald-50/70 text-[10px] uppercase tracking-widest text-slate-400 font-bold">
                                    <tr>
                                      <th className="px-3 py-2">Priority</th>
                                      <th className="px-3 py-2">Evidence</th>
                                      <th className="px-3 py-2">Reason</th>
                                      <th className="px-3 py-2">Final Text</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-emerald-50">
                                    {cvDebug.certificationEvidenceSelected?.slice(0, 10).map((item, index) => (
                                      <tr key={`${opp.id}-cert-${safeText(item.evidenceId, 'evidence')}-${index}`}>
                                        <td className="px-3 py-2 font-mono font-bold text-emerald-700">{safeText(item.priority)}</td>
                                        <td className="px-3 py-2">
                                          <div className="font-mono font-bold text-emerald-700">{safeText(item.evidenceId)}</div>
                                          <div className="text-slate-500">{safeText(item.title)}</div>
                                        </td>
                                        <td className="px-3 py-2 text-slate-600">{safeText(item.reason)}</td>
                                        <td className="px-3 py-2 text-slate-600">{safeText(item.finalText)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}

                            {(cvDebug.rawCertificationCandidates?.length || 0) > 0 && (
                              <details className="border border-emerald-100 rounded-xl bg-white/80">
                                <summary className="cursor-pointer px-3 py-2 text-xs font-bold text-slate-700">
                                  Raw certification candidate audit
                                  <span className="ml-2 font-normal text-slate-500">
                                    {cvDebug.rawCertificationCandidates?.length || 0} candidates
                                  </span>
                                </summary>
                                <div className="overflow-x-auto border-t border-emerald-50">
                                  <table className="min-w-full text-left text-xs">
                                    <thead className="bg-emerald-50/70 text-[10px] uppercase tracking-widest text-slate-400 font-bold">
                                      <tr>
                                        <th className="px-3 py-2">Status</th>
                                        <th className="px-3 py-2">Source</th>
                                        <th className="px-3 py-2">Evidence</th>
                                        <th className="px-3 py-2">Dedupe Key</th>
                                        <th className="px-3 py-2">Reason</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-emerald-50">
                                      {cvDebug.rawCertificationCandidates?.slice(0, 20).map((item, index) => (
                                        <tr key={`${opp.id}-raw-cert-${safeText(item.evidenceId, 'evidence')}-${index}`}>
                                          <td className={`px-3 py-2 font-bold ${safeText(item.status) === 'accepted' ? 'text-emerald-700' : 'text-rose-600'}`}>
                                            {safeText(item.status)}
                                          </td>
                                          <td className="px-3 py-2 text-slate-500">{safeText(item.source)}</td>
                                          <td className="px-3 py-2">
                                            <div className="font-mono font-bold text-emerald-700">{safeText(item.evidenceId)}</div>
                                            <div className="text-slate-600">{safeText(item.title)}</div>
                                            <div className="text-slate-400">{safeText(item.category)} · {safeText(item.organization)}</div>
                                          </td>
                                          <td className="px-3 py-2 font-mono text-[11px] text-slate-500">{safeText(item.deduplicationKey)}</td>
                                          <td className="px-3 py-2 text-slate-600">
                                            {safeText(item.rejectionReason || item.finalText || '-')}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </details>
                            )}

                            <div className="overflow-x-auto border border-emerald-100 rounded-xl bg-white/80">
                              <table className="min-w-full text-left text-xs">
                                <thead className="bg-emerald-50/70 text-[10px] uppercase tracking-widest text-slate-400 font-bold">
                                  <tr>
                                    <th className="px-3 py-2">Evidence</th>
                                    <th className="px-3 py-2">Business Meaning</th>
                                    <th className="px-3 py-2">Role Wording</th>
                                    <th className="px-3 py-2">CV Section</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-emerald-50">
                                  {mappingRows.map((item, index) => (
                                    <tr key={`${opp.id}-${safeText(item.evidenceId, 'evidence')}-${safeText(item.targetCvSection, 'section')}-${index}`}>
                                      <td className="px-3 py-2 font-mono font-bold text-emerald-700">{safeText(item.evidenceId)}</td>
                                      <td className="px-3 py-2 text-slate-600">{safeText(item.businessMeaning)}</td>
                                      <td className="px-3 py-2 text-slate-600">{safeText(item.roleRelevantWording)}</td>
                                      <td className="px-3 py-2 text-slate-500">{safeText(item.targetCvSection)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                              {cvDebug.evidenceMappings.length > 10 && (
                                <div className="border-t border-emerald-50 px-3 py-2 bg-white">
                                  <button
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      if (!opp.id) return;
                                      setExpandedDebugRows((current) => ({ ...current, [opp.id]: !debugRowsExpanded }));
                                    }}
                                    className="text-xs font-bold text-emerald-700 hover:text-emerald-900"
                                  >
                                    {debugRowsExpanded ? 'Show less' : `Show more (${cvDebug.evidenceMappings.length - 10} more)`}
                                  </button>
                                </div>
                              )}
                            </div>

                            <details className="bg-white/80 border border-emerald-100 rounded-xl p-3">
                              <summary className="text-xs font-bold text-slate-700 cursor-pointer">
                                Ready checklist rows and final placeholder JSON
                              </summary>
                              <pre className="mt-3 text-[11px] leading-relaxed text-slate-600 whitespace-pre-wrap overflow-x-auto">
                                {safeJsonPreview({
                                  readyChecklistRowsUsed: cvDebug.readyChecklistRowsUsed,
                                  qualificationPromotions: cvDebug.qualificationPromotions,
                                  rawCertificationCandidates: cvDebug.rawCertificationCandidates,
                                  certificationEvidenceSelected: cvDebug.certificationEvidenceSelected,
                                  finalSelectedCertificationList: cvDebug.finalSelectedCertificationList,
                                  finalCertificationStringLength: cvDebug.finalCertificationStringLength,
                                  onePageCompressionMode: cvDebug.onePageCompressionMode,
                                  templateWarnings: cvDebug.templateWarnings,
                                  summarySource: cvDebug.summarySource,
                                  selectedSummary: cvDebug.selectedSummary,
                                  finalPlaceholderJson: cvDebug.finalPlaceholderJson
                                })}
                              </pre>
                            </details>
                            </div>
                          </details>
                        )}

                        {/* Summary Rewrite */}
                        <div className="border border-slate-100 rounded-xl p-4 bg-slate-50/50">
                          <div className="flex justify-between items-center mb-1">
                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Custom Resume Summary Profile rewrite</span>
                            <button
                              onClick={() => copyText(safeText(pack.summaryRewrite, ''), `summary-${opp.id}`)}
                              className="inline-flex items-center text-xs text-slate-500 hover:text-emerald-600 cursor-pointer"
                            >
                              {copiedId === `summary-${opp.id}` ? (
                                <Check className="h-3.5 w-3.5 text-emerald-600 mr-1" />
                              ) : (
                                <Copy className="h-3.5 w-3.5 mr-1" />
                              )}
                              <span>Copy summary</span>
                            </button>
                          </div>
                          <p className="text-xs text-slate-600 italic leading-relaxed">
                            "{safeText(pack.summaryRewrite, '')}"
                          </p>
                        </div>

                        {/* Pitch message */}
                        <div className="border border-slate-100 rounded-xl p-4 bg-slate-50/50">
                          <div className="flex justify-between items-center mb-1">
                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Precision Pitch / Tailored Cover Message</span>
                            <button
                              onClick={() => copyText(safeText(pack.coverMessage, ''), `cover-${opp.id}`)}
                              className="inline-flex items-center text-xs text-slate-500 hover:text-emerald-600 cursor-pointer"
                            >
                              {copiedId === `cover-${opp.id}` ? (
                                <Check className="h-3.5 w-3.5 text-emerald-600 mr-1" />
                              ) : (
                                <Copy className="h-3.5 w-3.5 mr-1" />
                              )}
                              <span>Copy pitch</span>
                            </button>
                          </div>
                          <p className="text-xs text-slate-600 leading-relaxed whitespace-pre-line">
                            {safeText(pack.coverMessage, '')}
                          </p>
                        </div>

                        {/* Outreach Template */}
                        <div className="border border-slate-100 rounded-xl p-4 bg-slate-50/50">
                          <div className="flex justify-between items-center mb-1">
                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Recruiter Dynamic Cold outreach script (&lt;300 chars)</span>
                            <button
                              onClick={() => copyText(safeText(pack.linkedinMessage, ''), `linkedin-${opp.id}`)}
                              className="inline-flex items-center text-xs text-slate-500 hover:text-emerald-600 cursor-pointer"
                            >
                              {copiedId === `linkedin-${opp.id}` ? (
                                <Check className="h-3.5 w-3.5 text-emerald-600 mr-1" />
                              ) : (
                                <Copy className="h-3.5 w-3.5 mr-1" />
                              )}
                              <span>Copy intro</span>
                            </button>
                          </div>
                          <p className="text-xs text-slate-600 font-mono leading-normal leading-relaxed text-slate-500">
                            "{safeText(pack.linkedinMessage, '')}"
                          </p>
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-slate-400">Loading custom application pack parameters...</p>
                    )}
                  </div>
                )}
                </OpportunityExpansionBoundary>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
