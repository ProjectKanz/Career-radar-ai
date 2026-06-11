import React, { useState, useEffect } from 'react';
import { Radar, Sparkles, Building, ShieldCheck, FileText, AlertTriangle, Check, Clipboard } from 'lucide-react';
import { doc, getDocFromServer, getDocsFromServer, collection, writeBatch } from 'firebase/firestore';
import { db, formatFirestoreServerError } from '../firebase';
import { Profile, CVEvidence, CareerRadarOpportunity, ApplicationPack, CVEditChecklist, DailyApplyBrief } from '../types';
import { aiRequestHeaders, hasStoredGeminiApiKey } from '../utils/aiSettings';

interface CareerRadarPanelProps {
  userId: string;
  onOpportunitySaved?: () => void;
}

interface RadarContextCache {
  profile: Profile | null;
  evidences: CVEvidence[];
}

const radarContextCache = new Map<string, RadarContextCache>();

interface AiCostConfig {
  model: string;
  maxInputCharsPerCall: number;
  maxEvidenceItemsPerCall: number;
  maxAnalyzeEvidenceItemsPerCall?: number;
  dailyAiCallLimitDev: number;
  dailyAiCallsUsed: number;
  requireConfirmForRegenerate: boolean;
}

interface AiPayloadDiagnostics {
  inputCharacterCount: number;
  jobTextChars: number;
  profileContextChars: number;
  selectedEvidenceChars: number;
  frameworkChars: number;
  instructionTemplateChars: number;
  totalPromptChars: number;
  selectedEvidenceCount: number;
  fullEvidenceBankCount: number;
  jobTextWasTruncated: boolean;
  maxInputCharsPerCall: number;
  maxEvidenceItemsPerCall: number;
  promptBudgetStatus: 'ok' | 'over_limit';
  largestSections?: { label: string; chars: number }[];
}

interface AiRequestPreview {
  endpointName: string;
  featureNames?: string[];
  expectedAiCalls: number;
  model: string;
  inputCharacterCount: number;
  estimatedInputTokens: number;
  selectedEvidenceCount: number;
  selectedEvidenceIds: string[];
  cachedOutputExists: boolean;
  cacheStatus?: 'hit' | 'miss';
  dryRunEnabled: boolean;
  useCachedOutputEnabled: boolean;
  contextSent: string[];
  contextExcludedOrReduced: string[];
  warning?: string;
  promptPreview?: string;
  requestFingerprint?: string;
  payloadDiagnostics?: AiPayloadDiagnostics;
}

function safeText(value: unknown, fallback = '-') {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => safeText(item, '')).filter(Boolean).join(', ') || fallback;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return fallback;
  }
}

function extractApiErrorMessage(value: unknown) {
  if (!value) return 'Request failed.';
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return extractApiErrorMessage(parsed);
    } catch (_) {
      return value;
    }
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.error) return extractApiErrorMessage(record.error);
    if (record.message) return String(record.message);
  }
  return String(value);
}

function userFacingAiError(value: unknown) {
  const message = extractApiErrorMessage(value);
  const lower = message.toLowerCase();

  if (lower.includes('api key') || lower.includes('ai settings')) {
    return message;
  }

  if (message.includes('503') || lower.includes('high demand') || lower.includes('unavailable')) {
    return 'Gemini sedang padat. Coba lagi beberapa menit lagi, aktifkan Dry Run untuk preview gratis, atau coba lagi dengan API key/model yang kuotanya masih tersedia.';
  }

  if (lower.includes('quota') || lower.includes('rate limit') || lower.includes('resource exhausted')) {
    return 'Kuota atau batas gratis Gemini sedang tercapai. Coba lagi nanti, aktifkan Dry Run, atau gunakan API key Gemini lain.';
  }

  if (lower.includes('permission') || lower.includes('forbidden') || lower.includes('unauthorized')) {
    return 'API key Gemini belum bisa dipakai untuk request ini. Cek kembali key di AI Settings atau buat API key baru dari Google AI Studio.';
  }

  return message;
}

function hashString(value: string) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) + value.charCodeAt(index);
  }
  return Math.abs(hash).toString(36);
}

function analysisCacheKey(jobText: string, profile: Profile | null, evidences: CVEvidence[]) {
  return `careerRadarAnalysis:${hashString(JSON.stringify({
    jobText: jobText.trim(),
    profileUpdatedAt: profile?.updatedAt || '',
    profileName: profile?.fullName || '',
    evidenceKeys: evidences.map((item) => `${item.evidenceId || item.id}:${item.updatedAt}:${item.isVerified}`).sort()
  }))}`;
}

function formatChars(value?: number) {
  return Number(value || 0).toLocaleString();
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('File could not be read.'));
    reader.readAsDataURL(file);
  });
}

export default function CareerRadarPanel({ userId, onOpportunitySaved }: CareerRadarPanelProps) {
  const cachedContext = radarContextCache.get(userId);
  const [profile, setProfile] = useState<Profile | null>(() => cachedContext?.profile ?? null);
  const [evidences, setEvidences] = useState<CVEvidence[]>(() => cachedContext?.evidences ?? []);
  const [loadingContext, setLoadingContext] = useState(() => !cachedContext);

  // Form input
  const [jobText, setJobText] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [applyLink, setApplyLink] = useState('');
  const [companyName, setCompanyName] = useState(''); // Optional, AI will extract
  const [roleTitle, setRoleTitle] = useState(''); // Optional, AI will extract
  const [locationName, setLocationName] = useState(''); // Optional, AI will extract

  // Matching results state
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<any>(null);
  const [savingResult, setSavingResult] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copiedSection, setCopiedSection] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [dryRunAi, setDryRunAi] = useState(() => localStorage.getItem('careerRadarDryRunAi') === 'true');
  const [useCachedOutput, setUseCachedOutput] = useState(() => localStorage.getItem('careerRadarUseCachedOutput') !== 'false');
  const [costConfig, setCostConfig] = useState<AiCostConfig | null>(null);
  const [aiBudgetPreview, setAiBudgetPreview] = useState<string | null>(null);
  const [aiRequestPreview, setAiRequestPreview] = useState<AiRequestPreview | null>(null);
  const [previewStatus, setPreviewStatus] = useState<'idle' | 'preparing' | 'ready' | 'error'>('idle');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [extractingScreenshot, setExtractingScreenshot] = useState(false);
  const [screenshotMessage, setScreenshotMessage] = useState<string | null>(null);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadAnchors() {
      const cached = radarContextCache.get(userId);
      if (cached) {
        setProfile(cached.profile);
        setEvidences(cached.evidences);
        setLoadingContext(false);
      } else {
        setProfile(null);
        setEvidences([]);
        setLoadingContext(true);
      }

      try {
        setContextError(null);
        const [profileSnap, evSnap] = await Promise.all([
          getDocFromServer(doc(db, 'profiles', userId)),
          getDocsFromServer(collection(db, `profiles/${userId}/cv_evidences`))
        ]);

        if (cancelled) return;

        let nextProfile: Profile | null = null;
        if (profileSnap.exists()) {
          nextProfile = profileSnap.data() as Profile;
        }

        const items: CVEvidence[] = [];
        evSnap.forEach((doc) => {
          items.push({ id: doc.id, ...doc.data() } as CVEvidence);
        });

        radarContextCache.set(userId, { profile: nextProfile, evidences: items });
        setProfile(nextProfile);
        setEvidences(items);
      } catch (err) {
        console.error('Error loading context:', err);
        if (!cancelled) {
          setContextError(formatFirestoreServerError(err));
        }
      } finally {
        if (!cancelled) {
          setLoadingContext(false);
        }
      }
    }
    loadAnchors();

    return () => {
      cancelled = true;
    };
  }, [userId]);

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

  const currentAnalysisFingerprint = analysisCacheKey(jobText, profile, evidences);
  const previewIsStale = Boolean(aiRequestPreview?.requestFingerprint && aiRequestPreview.requestFingerprint !== currentAnalysisFingerprint);
  const exactInputChars = Number(aiRequestPreview?.payloadDiagnostics?.inputCharacterCount || aiRequestPreview?.inputCharacterCount || 0);
  const budgetLimit = aiRequestPreview?.payloadDiagnostics?.maxInputCharsPerCall || costConfig?.maxInputCharsPerCall;
  const largestPromptSection = aiRequestPreview?.payloadDiagnostics?.largestSections?.[0];

  const extractJobScreenshot = async (file: File | null) => {
    if (!file) return;
    setScreenshotError(null);
    setScreenshotMessage(null);
    setError(null);

    try {
      if (!hasStoredGeminiApiKey()) {
        throw new Error('Add your Gemini API key in AI Settings before extracting text from a screenshot.');
      }
      if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
        throw new Error('Upload a PNG, JPG, JPEG, or WEBP screenshot.');
      }
      if (file.size > 3 * 1024 * 1024) {
        throw new Error('Screenshot is too large. Use an image under 3MB.');
      }

      setExtractingScreenshot(true);
      const imageBase64 = await readFileAsBase64(file);
      const response = await fetch('/api/extract-job-screenshot', {
        method: 'POST',
        headers: aiRequestHeaders(),
        body: JSON.stringify({
          imageBase64,
          mimeType: file.type,
          fileName: file.name
        })
      });

      if (!response.ok) {
        let errMsg = 'Screenshot extraction failed on back-end server.';
        try {
          const errData = await response.json();
          if (errData?.error) errMsg = userFacingAiError(errData.error);
        } catch (_) {}
        throw new Error(errMsg);
      }

      const data = await response.json();
      const extractedText = String(data.jobText || '').trim();
      if (!extractedText) {
        throw new Error('No readable job description text was found. Try a clearer screenshot or paste the text manually.');
      }

      setJobText(extractedText);
      if (data.company && !companyName) setCompanyName(String(data.company));
      if (data.role && !roleTitle) setRoleTitle(String(data.role));
      setAiRequestPreview(null);
      setPreviewStatus('idle');
      setAiBudgetPreview(null);
      setScreenshotMessage(`Screenshot extracted ${extractedText.length.toLocaleString()} chars${data.sourceNotes ? `; ${data.sourceNotes}` : ''}`);
    } catch (err: any) {
      const message = userFacingAiError(err.message || err || 'Screenshot extraction failed.');
      setScreenshotError(message);
      setError(message);
    } finally {
      setExtractingScreenshot(false);
    }
  };

  const runAnalysis = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!jobText.trim()) return;

    setAnalyzing(true);
    setAnalysisResult(null);
    setSaveSuccess(false);
    setSaveMessage(null);
    setSavedAt(null);
    setSaveError(null);
    setError(null);
    setAiBudgetPreview(null);
    setPreviewError(null);
    if (dryRunAi) {
      setPreviewStatus('preparing');
      setAiRequestPreview(null);
    } else {
      setPreviewStatus('idle');
    }

    try {
      if (analysisResult && !dryRunAi && costConfig?.requireConfirmForRegenerate) {
        const proceed = window.confirm('Regenerate with AI will spend another Gemini call. Use cached output or Dry Run for free UI testing. Continue?');
        if (!proceed) {
          setAnalyzing(false);
          return;
        }
      }

      if (!dryRunAi && !hasStoredGeminiApiKey()) {
        throw new Error('Add your Gemini API key in AI Settings, or turn on Dry Run to preview without AI cost.');
      }

      const key = currentAnalysisFingerprint;
      if (useCachedOutput && !dryRunAi) {
        const cached = localStorage.getItem(key);
        if (cached) {
          const parsed = JSON.parse(cached);
          setAnalysisResult({ ...parsed, cacheStatus: 'browser_cache' });
          if (parsed.company && !companyName) setCompanyName(parsed.company);
          if (parsed.role && !roleTitle) setRoleTitle(parsed.role);
          setAiBudgetPreview('Used cached analysis output. No Gemini call was made.');
          setAnalyzing(false);
          return;
        }
      }

      if (!dryRunAi) {
        if (!aiRequestPreview) {
          throw new Error('Run Dry Run / No AI first to get the exact backend payload estimate before spending a Gemini call.');
        }
        if (previewIsStale) {
          throw new Error('The AI request preview is stale because the job text, profile, or evidence bank changed. Run Dry Run / No AI again.');
        }
        const previewInputChars = aiRequestPreview.payloadDiagnostics?.inputCharacterCount || aiRequestPreview.inputCharacterCount;
        const maxInputChars = aiRequestPreview.payloadDiagnostics?.maxInputCharsPerCall || costConfig?.maxInputCharsPerCall || 45000;
        if (previewInputChars > maxInputChars) {
          const largest = aiRequestPreview.payloadDiagnostics?.largestSections?.[0];
          throw new Error(`Exact AI request is ${previewInputChars.toLocaleString()} chars, above the ${maxInputChars.toLocaleString()} char limit.${largest ? ` Largest section: ${largest.label} (${largest.chars.toLocaleString()} chars).` : ''}`);
        }
      }

      const response = await fetch('/api/analyze-job', {
        method: 'POST',
        headers: aiRequestHeaders(),
        body: JSON.stringify({
          jobText,
          profile: profile || { fullName: 'Anonymous Candidate', education: '', experienceBrief: '', targetRoles: '' },
          evidences,
          dryRun: dryRunAi,
          useCachedOutput
        })
      });

      if (!response.ok) {
        let errMsg = 'Analysis request failed on back-end server.';
        try {
          const errData = await response.json();
          if (errData && errData.error) {
            errMsg = userFacingAiError(errData.error);
          }
        } catch (_) {}
        throw new Error(errMsg);
      }

      const data = await response.json();
      if (data.dryRun) {
        const browserCacheExists = useCachedOutput && Boolean(localStorage.getItem(key));
        const cachedOutputExists = Boolean(data.cachedOutputExists || browserCacheExists);
        const preview: AiRequestPreview = {
          endpointName: data.endpointName || '/api/analyze-job',
          featureNames: Array.isArray(data.featureNames) ? data.featureNames : ['Analyze Job Fit', 'Generate Application Pack', 'Generate CV Checklist'],
          expectedAiCalls: browserCacheExists ? 0 : Number(data.expectedAiCalls ?? 0),
          model: data.model || costConfig?.model || 'gemini',
          inputCharacterCount: Number(data.inputCharacterCount || 0),
          estimatedInputTokens: Number(data.estimatedInputTokens || 0),
          selectedEvidenceCount: Number(data.selectedEvidenceCount || 0),
          selectedEvidenceIds: Array.isArray(data.selectedEvidenceIds) ? data.selectedEvidenceIds : [],
          cachedOutputExists,
          cacheStatus: cachedOutputExists ? 'hit' : 'miss',
          dryRunEnabled: Boolean(data.dryRunEnabled ?? true),
          useCachedOutputEnabled: Boolean(data.useCachedOutputEnabled ?? useCachedOutput),
          contextSent: Array.isArray(data.contextSent) ? data.contextSent : ['compact profile', 'capped job description', 'selected evidence'],
          contextExcludedOrReduced: Array.isArray(data.contextExcludedOrReduced) ? data.contextExcludedOrReduced : ['full evidence bank reduced before prompt'],
          warning: browserCacheExists
            ? 'Browser cache hit available. No AI call will be made if you run with cached output enabled.'
            : data.warning || 'No AI call will be made in preview mode.',
          promptPreview: data.promptPreview || '',
          requestFingerprint: key,
          payloadDiagnostics: data.payloadDiagnostics || undefined
        };
        setAiRequestPreview(preview);
        setPreviewStatus('ready');
        setAiBudgetPreview(`Dry Run only: ${formatChars(preview.payloadDiagnostics?.inputCharacterCount || preview.inputCharacterCount)} exact input chars, about ${formatChars(preview.estimatedInputTokens)} tokens, ${preview.selectedEvidenceCount} evidence items selected. No Gemini call was made.`);
        setAnalysisResult(null);
        return;
      }

      setAnalysisResult(data);
      if (!dryRunAi) {
        localStorage.setItem(key, JSON.stringify(data));
      }

      // Pre-fill manual overrides if AI has extracted them
      if (data.company && !companyName) setCompanyName(data.company);
      if (data.role && !roleTitle) setRoleTitle(data.role);
    } catch (err: any) {
      console.error('Analysis failed:', err);
      if (dryRunAi) {
        setPreviewStatus('error');
        setPreviewError(err.message || 'Preview generation failed.');
      }
      setError(userFacingAiError(err.message || err || 'Gagal menganalisis lowongan.'));
    } finally {
      setAnalyzing(false);
    }
  };

  const saveOpportunityAndPacks = async () => {
    if (!analysisResult) return;
    setSavingResult(true);
    setSaveSuccess(false);
    setSaveMessage(null);
    setSavedAt(null);
    setSaveError(null);

    try {
      const opportunityId = doc(collection(db, 'profiles')).id; // Unique ID to link packs and checklists
      const batch = writeBatch(db);
      const now = new Date().toISOString();

      // 1. Create CareerRadarOpportunity
      const opportunityPayload: CareerRadarOpportunity = {
        company: companyName.trim() || analysisResult.company || 'Unknown Company',
        role: roleTitle.trim() || analysisResult.role || 'Tailored Opportunity',
        location: locationName.trim() || analysisResult.location || 'Hybrid/Remote',
        sourceUrl: sourceUrl.trim() || '',
        applyLink: applyLink.trim() || '',
        jobText,
        fitScore: analysisResult.fitScore,
        decision: analysisResult.decision,
        analysisNotes: analysisResult.analysisNotes,
        roleDna: analysisResult.roleDna,
        educationFit: analysisResult.educationFit,
        experienceFit: analysisResult.experienceFit,
        portfolioFit: analysisResult.portfolioFit,
        hasRedFlags: analysisResult.hasRedFlags || false,
        redFlags: analysisResult.redFlags || '',
        isStretchRole: analysisResult.isStretchRole || false,
        roleDnaFramework: analysisResult.roleDnaFramework || {
          primaryDirection: 'Business / Operations',
          industrySignals: [],
          functionSignals: [],
          seniorityLevel: 'Unknown / needs verification',
          hardSkillSignals: [],
          softSkillSignals: [],
          eligibilitySignals: [],
          avoidOverclaimRisks: []
        },
        cvBaseVersion: analysisResult.cvBaseVersion || 'GENERAL',
        evidenceRoleMappings: analysisResult.evidenceRoleMappings || [],
        evidenceIdsUsed: analysisResult.evidenceIdsUsed || [],
        createdAt: now,
        updatedAt: now
      };

      batch.set(doc(db, `profiles/${userId}/opportunities`, opportunityId), opportunityPayload);

      // 2. Create ApplicationPack
      const packPayload: ApplicationPack = {
        opportunityId,
        company: opportunityPayload.company,
        role: opportunityPayload.role,
        applicationEnergy: analysisResult.applicationPack?.applicationEnergy || 'Medium',
        cvAction: analysisResult.applicationPack?.cvAction || 'Adjust summary',
        cvAngle: analysisResult.applicationPack?.cvAngle || 'General match',
        keywordsToEmphasize: analysisResult.applicationPack?.keywordsToEmphasize || '',
        summaryRewrite: analysisResult.applicationPack?.summaryRewrite || '',
        bulletPrioritization: analysisResult.applicationPack?.bulletPrioritization || '',
        coverMessage: analysisResult.applicationPack?.coverMessage || '',
        linkedinMessage: analysisResult.applicationPack?.linkedinMessage || '',
        portfolioEvidence: analysisResult.applicationPack?.portfolioEvidence || '',
        createdAt: now,
        updatedAt: now
      };

      batch.set(doc(db, `profiles/${userId}/application_packs`, opportunityId), packPayload);

      // 3. Create CV Edit Checklists (Iterative map)
      const checklists = analysisResult.suggestedChecklists || [];
      for (const item of checklists) {
        const checkId = doc(collection(db, 'profiles')).id;
        const checkPayload: CVEditChecklist = {
          opportunityId,
          company: opportunityPayload.company,
          role: opportunityPayload.role,
          cvSection: item.cvSection || 'Professional Summary',
          editType: item.editType || 'Keyword adjustment',
          sourceEvidence: item.sourceEvidence || '',
          finalSuggestedText: item.finalSuggestedText || '',
          whyTheChangeMatters: item.whyTheChangeMatters || '',
          priority: item.priority || 'Medium',
          evidenceId: item.evidenceId || '',
          isReadyToCopy: true,
          isStale: false,
          isDone: false,
          createdAt: now,
          updatedAt: now
        };

        batch.set(doc(db, `profiles/${userId}/cv_checklists`, checkId), checkPayload);
      }

      // 4. Create Daily Apply Brief log entry
      const briefId = doc(collection(db, 'profiles')).id;
      const briefPayload: DailyApplyBrief = {
        opportunityId,
        company: opportunityPayload.company,
        role: opportunityPayload.role,
        fitScore: opportunityPayload.fitScore,
        decision: opportunityPayload.decision,
        applicationEnergy: packPayload.applicationEnergy,
        cvAction: packPayload.cvAction,
        priority: 'Medium',
        status: 'Not Applied',
        briefDate: now.split('T')[0],
        createdAt: now,
        updatedAt: now
      };

      batch.set(doc(db, `profiles/${userId}/daily_apply_briefs`, briefId), briefPayload);
      await batch.commit();

      setSaveSuccess(true);
      setSaveMessage('Opportunity saved successfully.');
      setSavedAt(now);
      if (onOpportunitySaved) {
        window.setTimeout(() => onOpportunitySaved(), 700);
      }
    } catch (err) {
      console.error('Error saving opportunity packs:', err);
      setSaveError(err instanceof Error ? err.message : 'Failed to save matching results to database.');
    } finally {
      setSavingResult(false);
    }
  };

  const copyToClipboard = (text: string, section: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSection(section);
    setTimeout(() => setCopiedSection(null), 2000);
  };

  // Warning state if profile is fully empty
  const isProfileEmpty = !profile || !profile.fullName || (profile.experienceBrief?.length ?? 0) < 5;
  const evidenceCount = evidences.length;
  const hasApiKey = hasStoredGeminiApiKey();

  return (
    <div id="radar_panel_root" className="max-w-5xl mx-auto py-6 font-sans">
      <div className="md:flex md:items-center md:justify-between mb-8">
        <div className="flex-1 min-w-0">
          <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl tracking-tight flex items-center space-x-2">
            <Radar className="h-7 w-7 text-emerald-600" />
            <span>AI Career Radar Matching Engine</span>
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Paste a job posting below. Gemini will extract its Technical DNA and ground it against your CV Evidence Bank.
          </p>
        </div>
      </div>

      <div className="mb-8 rounded-2xl border border-emerald-100 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-lg bg-emerald-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-emerald-700">
              <Clipboard className="h-3.5 w-3.5" />
              <span>Quick start for first-time users</span>
            </div>
            <h3 className="mt-3 text-lg font-bold text-slate-900">Set up your CV context before spending an AI call</h3>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-500">
              Dry Run is safe for testing. Real AI matching works best after your profile, evidence, and Gemini key are ready.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs font-bold text-slate-600 sm:grid-cols-4">
            <div className={`rounded-xl border px-3 py-2 ${isProfileEmpty ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-emerald-100 bg-emerald-50 text-emerald-700'}`}>
              Profile {isProfileEmpty ? 'needed' : 'ready'}
            </div>
            <div className={`rounded-xl border px-3 py-2 ${evidenceCount === 0 ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-emerald-100 bg-emerald-50 text-emerald-700'}`}>
              Evidence {evidenceCount}
            </div>
            <div className={`rounded-xl border px-3 py-2 ${hasApiKey ? 'border-emerald-100 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
              API key {hasApiKey ? 'ready' : 'optional'}
            </div>
            <div className={`rounded-xl border px-3 py-2 ${dryRunAi ? 'border-emerald-100 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
              Dry Run {dryRunAi ? 'on' : 'off'}
            </div>
          </div>
        </div>
      </div>

      {isProfileEmpty && (
        <div className="p-4 bg-orange-50 border border-orange-200 rounded-2xl mb-8 flex items-start space-x-3 text-orange-800 animate-fade-in">
          <AlertTriangle className="h-5 w-5 text-orange-600 shrink-0 mt-0.5" />
          <div>
            {loadingContext ? (
              <>
                <h4 className="font-bold text-sm">Loading Profile Context</h4>
                <p className="text-xs text-orange-700 mt-1">
                  The form is ready to use while Firestore loads your profile and evidence bank in the background.
                </p>
              </>
            ) : (
              <>
                <h4 className="font-bold text-sm">Profile Context Needed</h4>
                <p className="text-xs text-orange-700 mt-1">
                  Fill <strong>Candidate Profile Context</strong> and add at least a few items in <strong>CV Evidence Bank</strong> before real AI matching. You can still use Dry Run to preview request size for free.
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="p-4 bg-rose-50 border border-rose-200 rounded-2xl mb-8 flex items-start space-x-3 text-rose-800 animate-fade-in shadow-sm">
          <AlertTriangle className="h-5 w-5 text-rose-600 shrink-0 mt-0.5" />
          <div className="flex-1">
            <h4 className="font-bold text-sm text-rose-950">AI request needs attention</h4>
            <p className="text-xs text-rose-700 mt-1 leading-relaxed">
              {error}
            </p>
          </div>
        </div>
      )}

      {contextError && (
        <div className="p-4 bg-rose-50 border border-rose-200 rounded-2xl mb-8 flex items-start space-x-3 text-rose-800 animate-fade-in shadow-sm">
          <AlertTriangle className="h-5 w-5 text-rose-600 shrink-0 mt-0.5" />
          <div className="flex-1">
            <h4 className="font-bold text-sm text-rose-950">Firestore Server Read Failed</h4>
            <p className="text-xs text-rose-700 mt-1 leading-relaxed">
              {contextError}
            </p>
          </div>
        </div>
      )}

      {/* Main Form */}
      <div className="bg-white border border-slate-100 shadow-sm rounded-2xl overflow-hidden p-6 mb-8">
        <form onSubmit={runAnalysis} className="space-y-4">
          <div>
            <div className="mb-2 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
              <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider">Job Description Text / Raw Specifications</label>
              <div className="flex flex-wrap items-center gap-2">
                <label className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-bold cursor-pointer ${
                  extractingScreenshot
                    ? 'border-slate-200 bg-slate-100 text-slate-400'
                    : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                }`}>
                  <FileText className={`h-4 w-4 ${extractingScreenshot ? 'animate-pulse' : ''}`} />
                  <span>{extractingScreenshot ? 'Extracting screenshot...' : 'Upload screenshot'}</span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/jpg,image/webp"
                    disabled={extractingScreenshot}
                    onChange={(event) => {
                      const file = event.target.files?.[0] || null;
                      event.target.value = '';
                      void extractJobScreenshot(file);
                    }}
                    className="hidden"
                  />
                </label>
              </div>
            </div>
            {screenshotMessage && (
              <div className="mb-2 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">
                {screenshotMessage}
              </div>
            )}
            {screenshotError && (
              <div className="mb-2 rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
                {screenshotError}
              </div>
            )}
            <textarea
              required
              rows={8}
              placeholder="Paste the full job posting specifications here (including technologies, years of experience, requirements, and about company summary)..."
              value={jobText}
              onChange={(e) => setJobText(e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-xl px-4 py-3 bg-slate-50 outline-none focus:bg-white focus:ring-1 focus:ring-emerald-500/50 resize-y font-normal leading-relaxed"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Company (Optional / AI Auto-extracts)</label>
              <input
                type="text"
                placeholder="e.g. Tokopedia, Gojek"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 outline-none focus:bg-white focus:ring-1 focus:ring-emerald-500/50"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Role Title (Optional / AI Auto-extracts)</label>
              <input
                type="text"
                placeholder="e.g. Senior React Developer"
                value={roleTitle}
                onChange={(e) => setRoleTitle(e.target.value)}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 outline-none focus:bg-white focus:ring-1 focus:ring-emerald-500/50"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Job Link / Source URL</label>
              <input
                type="url"
                placeholder="e.g. https://linkedin.com/jobs/view/..."
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 outline-none focus:bg-white focus:ring-1 focus:ring-emerald-500/50"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Direct Apply Link</label>
              <input
                type="url"
                placeholder="e.g. https://careers.company.com/apply"
                value={applyLink}
                onChange={(e) => setApplyLink(e.target.value)}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 outline-none focus:bg-white focus:ring-1 focus:ring-emerald-500/50"
              />
            </div>
          </div>

          <div className="rounded-xl border border-slate-100 bg-slate-50/70 px-4 py-3 text-xs text-slate-600">
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
              <div>
                <div className="font-bold text-slate-700">AI budget estimate</div>
                <div className="mt-1">
                  Expected calls: {dryRunAi ? '0' : '1 Gemini call, 3 generated outputs'} · Model: {costConfig?.model || 'gemini'} · Exact input: {
                    aiRequestPreview && !previewIsStale
                      ? `${formatChars(exactInputChars)} chars`
                      : 'run Dry Run / No AI for exact estimate'
                  } · Daily dev usage: {costConfig ? `${costConfig.dailyAiCallsUsed}/${costConfig.dailyAiCallLimitDev}` : 'loading'}
                </div>
                {aiRequestPreview && previewIsStale && (
                  <div className="mt-1 font-semibold text-amber-700">Preview is stale. Run Dry Run again before real AI.</div>
                )}
                {aiRequestPreview && !previewIsStale && budgetLimit && exactInputChars > budgetLimit && (
                  <div className="mt-1 font-semibold text-rose-700">
                    Over limit by {formatChars(exactInputChars - budgetLimit)} chars{largestPromptSection ? `; largest section: ${largestPromptSection.label}` : ''}.
                  </div>
                )}
                {aiBudgetPreview && (
                  <div className="mt-1 font-semibold text-emerald-700">{aiBudgetPreview}</div>
                )}
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

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              disabled={analyzing || loadingContext}
              className="px-6 py-3 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400 text-white rounded-xl text-sm font-semibold shadow-md inline-flex items-center space-x-2 cursor-pointer"
            >
              <Radar className={`h-4 w-4 ${analyzing || loadingContext ? 'animate-spin' : ''}`} />
              <span>
                {loadingContext
                  ? 'Loading Profile Context...'
                  : analyzing
                    ? 'Extracting Technical DNA & Grounding...'
                    : analysisResult
                      ? 'Regenerate with AI'
                      : dryRunAi
                        ? 'Preview AI Request'
                        : 'Compare & Align Job Match'}
              </span>
            </button>
          </div>
        </form>
      </div>

      {(previewStatus === 'preparing' || previewStatus === 'ready' || previewStatus === 'error') && (
        <div className="bg-white border border-emerald-100 shadow-sm rounded-2xl p-6 mb-8 animate-fade-in">
          <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3 border-b border-slate-100 pb-4 mb-4">
            <div>
              <h3 className="text-sm font-extrabold text-slate-800 uppercase tracking-wide">AI Request Preview</h3>
              <p className="text-xs text-slate-500 mt-1">No AI call will be made in preview mode.</p>
            </div>
            <span className={`text-xs font-bold px-3 py-1 rounded-full ${
              previewStatus === 'ready'
                ? 'bg-emerald-50 text-emerald-700'
                : previewStatus === 'error'
                  ? 'bg-rose-50 text-rose-700'
                  : 'bg-amber-50 text-amber-700'
            }`}>
              {previewStatus === 'ready' ? 'Preview Ready' : previewStatus === 'error' ? 'Preview Failed' : 'Preparing preview...'}
            </span>
          </div>

          {previewStatus === 'preparing' && (
            <div className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
              Preparing preview...
            </div>
          )}

          {previewStatus === 'error' && (
            <div className="rounded-xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
              {previewError || 'Preview generation failed.'}
            </div>
          )}

          {previewStatus === 'ready' && aiRequestPreview && (
            <div className="space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Endpoint</div>
                  <div className="mt-1 text-sm font-bold text-slate-800">{aiRequestPreview.endpointName}</div>
                </div>
                <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Budget</div>
                  <div className="mt-1 text-sm font-bold text-slate-800">
                    {aiRequestPreview.expectedAiCalls === 1 ? '1 Gemini call, 3 generated outputs' : `${aiRequestPreview.expectedAiCalls} AI calls`} · {aiRequestPreview.model}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Cache</div>
                  <div className="mt-1 text-sm font-bold text-slate-800">
                    {aiRequestPreview.cachedOutputExists ? 'Cache hit available' : 'No cache hit'}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Input Chars</div>
                  <div className="mt-1 text-sm font-bold text-slate-800">{aiRequestPreview.inputCharacterCount.toLocaleString()}</div>
                </div>
                <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Est. Tokens</div>
                  <div className="mt-1 text-sm font-bold text-slate-800">{aiRequestPreview.estimatedInputTokens.toLocaleString()}</div>
                </div>
                <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Evidence Selected</div>
                  <div className="mt-1 text-sm font-bold text-slate-800">{aiRequestPreview.selectedEvidenceCount}</div>
                </div>
              </div>

              <div className="rounded-xl border border-emerald-100 bg-emerald-50/60 px-4 py-3 text-sm font-semibold text-emerald-800">
                {aiRequestPreview.warning || 'No AI call will be made in preview mode.'}
              </div>

              {previewIsStale && (
                <div className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
                  This preview is stale because the job text, profile, or evidence bank changed. Run Dry Run again before using real AI.
                </div>
              )}

              {aiRequestPreview.payloadDiagnostics && (
                <div className="rounded-xl border border-slate-100 bg-white px-4 py-3">
                  <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 mb-3">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">Exact Payload Breakdown</h4>
                    <span className={`text-xs font-bold px-3 py-1 rounded-full ${
                      aiRequestPreview.payloadDiagnostics.promptBudgetStatus === 'over_limit'
                        ? 'bg-rose-50 text-rose-700'
                        : 'bg-emerald-50 text-emerald-700'
                    }`}>
                      {aiRequestPreview.payloadDiagnostics.promptBudgetStatus === 'over_limit' ? 'Over Limit' : 'Within Limit'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 text-xs">
                    <div className="rounded-lg bg-slate-50 px-3 py-2">
                      <div className="font-bold text-slate-400 uppercase">Job Text</div>
                      <div className="font-extrabold text-slate-800">{formatChars(aiRequestPreview.payloadDiagnostics.jobTextChars)}</div>
                    </div>
                    <div className="rounded-lg bg-slate-50 px-3 py-2">
                      <div className="font-bold text-slate-400 uppercase">Profile</div>
                      <div className="font-extrabold text-slate-800">{formatChars(aiRequestPreview.payloadDiagnostics.profileContextChars)}</div>
                    </div>
                    <div className="rounded-lg bg-slate-50 px-3 py-2">
                      <div className="font-bold text-slate-400 uppercase">Evidence</div>
                      <div className="font-extrabold text-slate-800">{formatChars(aiRequestPreview.payloadDiagnostics.selectedEvidenceChars)}</div>
                    </div>
                    <div className="rounded-lg bg-slate-50 px-3 py-2">
                      <div className="font-bold text-slate-400 uppercase">Framework</div>
                      <div className="font-extrabold text-slate-800">{formatChars(aiRequestPreview.payloadDiagnostics.frameworkChars)}</div>
                    </div>
                    <div className="rounded-lg bg-slate-50 px-3 py-2">
                      <div className="font-bold text-slate-400 uppercase">Instructions</div>
                      <div className="font-extrabold text-slate-800">{formatChars(aiRequestPreview.payloadDiagnostics.instructionTemplateChars)}</div>
                    </div>
                  </div>
                  <div className="mt-3 text-xs font-semibold text-slate-500">
                    Total prompt: {formatChars(aiRequestPreview.payloadDiagnostics.totalPromptChars)} chars · Evidence selected: {aiRequestPreview.payloadDiagnostics.selectedEvidenceCount}/{aiRequestPreview.payloadDiagnostics.fullEvidenceBankCount} · Limit: {formatChars(aiRequestPreview.payloadDiagnostics.maxInputCharsPerCall)} chars
                    {aiRequestPreview.payloadDiagnostics.jobTextWasTruncated ? ' · Job text was truncated to the configured cap.' : ''}
                  </div>
                  {aiRequestPreview.payloadDiagnostics.largestSections?.length ? (
                    <div className="mt-2 text-xs font-semibold text-slate-500">
                      Largest sections: {aiRequestPreview.payloadDiagnostics.largestSections.slice(0, 3).map((section) => `${section.label} (${formatChars(section.chars)})`).join(', ')}
                    </div>
                  ) : null}
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="rounded-xl border border-slate-100 bg-white px-4 py-3">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Selected Evidence IDs</h4>
                  <div className="flex flex-wrap gap-1.5">
                    {aiRequestPreview.selectedEvidenceIds.length > 0 ? aiRequestPreview.selectedEvidenceIds.map((id) => (
                      <span key={id} className="rounded bg-slate-100 px-2 py-1 text-xs font-bold text-slate-700">{id}</span>
                    )) : (
                      <span className="text-xs font-semibold text-rose-600">No evidence selected.</span>
                    )}
                  </div>
                </div>

                <div className="rounded-xl border border-slate-100 bg-white px-4 py-3">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Mode Flags</h4>
                  <div className="space-y-1 text-xs font-semibold text-slate-600">
                    <div>Dry Run: {aiRequestPreview.dryRunEnabled ? 'enabled' : 'disabled'}</div>
                    <div>Use Cached Output: {aiRequestPreview.useCachedOutputEnabled ? 'enabled' : 'disabled'}</div>
                    <div>Feature bundle: {(aiRequestPreview.featureNames || []).join(' + ') || 'Analyze Job Fit'}</div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Context Sent</h4>
                  <ul className="space-y-1 text-xs font-semibold text-slate-600">
                    {aiRequestPreview.contextSent.map((item) => <li key={item}>- {item}</li>)}
                  </ul>
                </div>
                <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Context Excluded / Reduced</h4>
                  <ul className="space-y-1 text-xs font-semibold text-slate-600">
                    {aiRequestPreview.contextExcludedOrReduced.map((item) => <li key={item}>- {item}</li>)}
                  </ul>
                </div>
              </div>

              {aiRequestPreview.promptPreview && (
                <details className="rounded-xl border border-slate-100 bg-slate-950 text-slate-100 px-4 py-3">
                  <summary className="cursor-pointer text-xs font-bold uppercase tracking-wider text-slate-300">Prompt Preview</summary>
                  <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap text-xs leading-relaxed">{aiRequestPreview.promptPreview}</pre>
                </details>
              )}
            </div>
          )}
        </div>
      )}

      {/* Analysis Results View */}
      {analyzing && (
        <div className="p-12 text-center bg-white border border-slate-50 shadow-sm rounded-2xl flex flex-col items-center justify-center space-y-4 animate-pulse">
          <Radar className="h-12 w-12 text-emerald-600 animate-spin" />
          <h3 className="text-lg font-bold text-slate-800">Aligning Portfolio Anchors...</h3>
          <p className="text-xs text-slate-500 max-w-sm">
            Please wait while Gemini evaluates core criteria, extracts technology keywords, maps academic scoring, checks experience limits, and maps your custom evidence items.
          </p>
        </div>
      )}

      {analysisResult && (
        <div className="space-y-6">
          {/* Executive Overview Card */}
          <div className="bg-white border border-slate-100 shadow-md rounded-2xl p-6 sm:p-8 animate-fade-in">
            <div className="flex flex-col md:flex-row md:items-center justify-between border-b border-slate-100 pb-6 mb-6 gap-6">
              <div className="flex items-center space-x-4">
                {/* Visual Fit Circle */}
                <div className="relative shrink-0">
                  <div className="h-20 w-20 rounded-full bg-slate-50 border border-slate-100 flex items-center justify-center">
                    <span className={`text-2xl font-extrabold tracking-tight ${
                      analysisResult.fitScore >= 85 ? 'text-emerald-600' :
                      analysisResult.fitScore >= 65 ? 'text-amber-500' : 'text-rose-500'
                    }`}>
                      {analysisResult.fitScore}%
                    </span>
                  </div>
                  <div className="absolute top-0 right-0 w-5 h-5 bg-emerald-100 rounded-full flex items-center justify-center shadow-sm">
                    <ShieldCheck className="h-3 w-3 text-emerald-700" />
                  </div>
                </div>

                <div>
                  <div className="flex items-center space-x-2">
                    <span className="text-xs font-bold text-emerald-700 bg-emerald-50 px-2.5 py-0.5 rounded-full inline-flex items-center">
                      <Sparkles className="h-3 w-3 mr-1" />
                      <span>{analysisResult.decision}</span>
                    </span>
                    {analysisResult.isStretchRole && (
                      <span className="text-xs font-bold text-indigo-700 bg-indigo-50 px-2.5 py-0.5 rounded-full">
                        Stretch Role
                      </span>
                    )}
                  </div>
                  <h3 className="text-xl font-bold text-slate-800 mt-1">
                    {roleTitle || analysisResult.role || 'Tailored Job Title'}
                  </h3>
                  <p className="text-xs font-medium text-slate-400 mt-0.5 flex items-center">
                    <Building className="h-3.5 w-3.5 mr-1" />
                    <span>{companyName || analysisResult.company || 'Unknown Company'}</span>
                  </p>
                </div>
              </div>

              <div>
                {saveSuccess ? (
                  <div className="px-4 py-2.5 bg-emerald-50 border border-emerald-100 text-emerald-700 text-sm font-semibold rounded-xl animate-fade-in">
                    <div className="inline-flex items-center space-x-1.5">
                      <Check className="h-4.5 w-4.5" />
                      <span>{saveMessage || 'Opportunity saved successfully.'}</span>
                    </div>
                    {savedAt && (
                      <div className="mt-1 text-[10px] font-medium text-emerald-600">
                        Saved at {new Date(savedAt).toLocaleString()}
                      </div>
                    )}
                  </div>
                ) : (
                  <button
                    onClick={saveOpportunityAndPacks}
                    disabled={savingResult}
                    className="w-full md:w-auto inline-flex items-center justify-center px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400 text-white rounded-xl text-xs font-bold tracking-wide transition-all shadow-md cursor-pointer"
                  >
                    {savingResult ? 'Saving to Database...' : 'Save Opportunity & Application Pack'}
                  </button>
                )}
                {saveError && (
                  <div className="mt-2 rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
                    {saveError}
                  </div>
                )}
              </div>
            </div>

            {/* Analysis Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-4">
                <div>
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Role DNA (Technical Requirements)</h4>
                  <p className="text-sm text-slate-600 mt-1 leading-relaxed bg-slate-50 px-4 py-3 rounded-xl border border-slate-100">{safeText(analysisResult.roleDna)}</p>
                </div>

                <div>
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Education & Academic Fit</h4>
                  <p className="text-sm text-slate-600 mt-1 leading-relaxed bg-slate-50 px-4 py-3 rounded-xl border border-slate-100">{safeText(analysisResult.educationFit)}</p>
                </div>

                <div>
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Professional Experience Fit</h4>
                  <p className="text-sm text-slate-700 mt-1 leading-relaxed bg-slate-50 px-4 py-3 rounded-xl border border-slate-100">{safeText(analysisResult.experienceFit)}</p>
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Grounding Fact Alignment (Portfolio Fit)</h4>
                  <p className="text-sm text-slate-700 mt-1 leading-relaxed bg-emerald-50/10 px-4 py-3 rounded-xl border border-emerald-50">{safeText(analysisResult.portfolioFit)}</p>
                </div>

                <div>
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Overall Match Justification</h4>
                  <p className="text-sm text-slate-700 mt-1 leading-relaxed bg-slate-50 px-4 py-3 rounded-xl border border-slate-100">{safeText(analysisResult.analysisNotes)}</p>
                </div>

                {analysisResult.hasRedFlags && (
                  <div>
                    <h4 className="text-xs font-bold text-rose-500 uppercase tracking-wider flex items-center">
                      <AlertTriangle className="h-4 w-4 mr-1 text-rose-500" />
                      <span>Identified Flags / Mismatch Gaps</span>
                    </h4>
                    <p className="text-sm text-rose-700 mt-1 leading-relaxed bg-rose-50 px-4 py-3 rounded-xl border border-rose-100">{safeText(analysisResult.redFlags)}</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Actionable Tailor Checklist Suggestions */}
          <div className="bg-white border border-slate-100 shadow-md rounded-2xl p-6 sm:p-8">
            <h3 className="text-lg font-bold text-slate-800 mb-4 flex items-center space-x-2">
              <span className="p-1.5 bg-indigo-50 text-indigo-700 rounded-lg"><Clipboard className="h-4 w-4" /></span>
              <span>Tailored CV Modification Recommendations</span>
            </h3>
            <p className="text-xs text-slate-500 mb-6">
              These suggestions specify exactly how to customize your CV details using ground fact tokens relative to core requirements.
            </p>

            <div className="space-y-4">
              {analysisResult.suggestedChecklists?.map((item: any, idx: number) => (
                <div key={idx} className="border border-slate-100 rounded-xl p-4 bg-slate-50/50 hover:bg-slate-50/100 transition-colors">
                  <div className="flex justify-between items-start gap-4 mb-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-bold text-slate-800 uppercase tracking-wider bg-slate-100 px-2 py-0.5 rounded">
                        {safeText(item.cvSection)}
                      </span>
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                        item.priority === 'High' ? 'bg-rose-50 text-rose-600' :
                        item.priority === 'Medium' ? 'bg-amber-50 text-amber-600' : 'bg-slate-50 text-slate-500'
                      }`}>
                        {safeText(item.priority)} Priority
                      </span>
                      {item.evidenceId && (
                        <span className="text-[10px] font-mono font-bold bg-emerald-50 text-emerald-700 px-1.5 py-0.5 rounded">
                          Ground Source: {safeText(item.evidenceId)}
                        </span>
                      )}
                    </div>
                  </div>

                  <p className="text-xs text-slate-400 font-medium mb-1">
                    Strategy: <span className="text-slate-600 font-semibold">{safeText(item.editType)}</span> (based on {safeText(item.sourceEvidence, 'general alignment')})
                  </p>
                  <p className="text-xs text-slate-500 leading-relaxed mb-3">
                    {safeText(item.whyTheChangeMatters)}
                  </p>

                  <div className="relative bg-slate-800 text-slate-200 text-xs font-mono p-3 rounded-lg overflow-x-auto select-all flex justify-between items-center group">
                    <span className="leading-relaxed">{safeText(item.finalSuggestedText)}</span>
                    <button
                      onClick={() => copyToClipboard(safeText(item.finalSuggestedText, ''), `checklist-${idx}`)}
                      className="ml-2 bg-slate-700 hover:bg-slate-600 text-white p-1.5 rounded transition-colors"
                      title="Copy rewrite string"
                    >
                      {copiedSection === `checklist-${idx}` ? (
                        <Check className="h-3.5 w-3.5 text-emerald-400" />
                      ) : (
                        <Clipboard className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Strategic Application Pack Content */}
          <div className="bg-white border border-slate-100 shadow-md rounded-2xl p-6 sm:p-8 space-y-6">
            <h3 className="text-lg font-bold text-slate-800 flex items-center space-x-2">
              <span className="p-1.5 bg-emerald-50 text-emerald-700 rounded-lg"><FileText className="h-4 w-4" /></span>
              <span>Customized Application Pack Outputs</span>
            </h3>

            {/* Profile Summary Rewrite */}
            <div className="border border-slate-100 rounded-xl p-5 bg-slate-50">
              <div className="flex justify-between items-center mb-2">
                <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Tailored CV Profile Summary Section</h4>
                <button
                  onClick={() => copyToClipboard(safeText(analysisResult.applicationPack?.summaryRewrite, ''), 'summary')}
                  className="inline-flex items-center text-xs text-slate-500 hover:text-emerald-600 transition-colors"
                >
                  {copiedSection === 'summary' ? (
                    <>
                      <Check className="h-3.5 w-3.5 mr-1 text-emerald-500" />
                      <span className="font-semibold text-emerald-600">Copied!</span>
                    </>
                  ) : (
                    <>
                      <Clipboard className="h-3.5 w-3.5 mr-1" />
                      <span>Copy summary</span>
                    </>
                  )}
                </button>
              </div>
              <p className="text-sm font-normal text-slate-700 italic leading-relaxed">
                "{safeText(analysisResult.applicationPack?.summaryRewrite, '')}"
              </p>
            </div>

            {/* Personalized Cover Pitch */}
            <div className="border border-slate-100 rounded-xl p-5 bg-slate-50">
              <div className="flex justify-between items-center mb-2">
                <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Tailored Cover Pitch / Outreach Message (150-250 Words)</h4>
                <button
                  onClick={() => copyToClipboard(safeText(analysisResult.applicationPack?.coverMessage, ''), 'cover')}
                  className="inline-flex items-center text-xs text-slate-500 hover:text-emerald-600 transition-colors"
                >
                  {copiedSection === 'cover' ? (
                    <>
                      <Check className="h-3.5 w-3.5 mr-1 text-emerald-500" />
                      <span className="font-semibold text-emerald-600">Copied!</span>
                    </>
                  ) : (
                    <>
                      <Clipboard className="h-3.5 w-3.5 mr-1" />
                      <span>Copy pitch</span>
                    </>
                  )}
                </button>
              </div>
              <p className="text-sm text-slate-600 leading-relaxed whitespace-pre-wrap">
                {safeText(analysisResult.applicationPack?.coverMessage, '')}
              </p>
            </div>

            {/* Recruiter Cold Outreach */}
            <div className="border border-slate-100 rounded-xl p-5 bg-slate-50">
              <div className="flex justify-between items-center mb-2">
                <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider">LinkedIn Recruiter Cold Outreach Script (&lt; 300 char)</h4>
                <button
                  onClick={() => copyToClipboard(safeText(analysisResult.applicationPack?.linkedinMessage, ''), 'linkedin')}
                  className="inline-flex items-center text-xs text-slate-500 hover:text-emerald-600 transition-colors"
                >
                  {copiedSection === 'linkedin' ? (
                    <>
                      <Check className="h-3.5 w-3.5 mr-1 text-emerald-500" />
                      <span className="font-semibold text-emerald-600">Copied!</span>
                    </>
                  ) : (
                    <>
                      <Clipboard className="h-3.5 w-3.5 mr-1" />
                      <span>Copy snippet</span>
                    </>
                  )}
                </button>
              </div>
              <p className="text-sm font-mono text-slate-600 leading-normal leading-relaxed">
                "{safeText(analysisResult.applicationPack?.linkedinMessage, '')}"
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
