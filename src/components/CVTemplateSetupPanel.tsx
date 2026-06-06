import { FormEvent, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FileText,
  RefreshCw,
  Save,
  ShieldCheck,
  Upload,
  Wand2
} from 'lucide-react';
import { collection, doc, getDocFromServer, setDoc, writeBatch } from 'firebase/firestore';
import {
  db,
  formatFirestoreServerError,
  handleFirestoreError,
  OperationType,
  requestGoogleDriveAccessToken
} from '../firebase';
import { CVEvidence, Profile } from '../types';
import { aiRequestHeaders, hasStoredGeminiApiKey } from '../utils/aiSettings';
import { extractGoogleDocId } from '../utils/cvDrive';

interface CVTemplateSetupPanelProps {
  userId: string;
}

type CvSourceType = 'google_docs' | 'pdf' | 'docx';
type WizardStatus = 'idle' | 'parsing' | 'generating' | 'creatingTemplate' | 'savingEvidence';

interface ParsedCvSource {
  sourceType: CvSourceType;
  sourceName: string;
  sourceDocumentId?: string;
  parsedText: string;
  parsedTextCharacterCount: number;
  warnings?: string[];
}

interface OnboardingEvidenceDraft {
  category: string;
  title: string;
  organization: string;
  description: string;
  sourceSection: string;
  confidence: number;
  inferredSkillTags: string[];
  selected: boolean;
}

interface OnboardingResult {
  profileDraft: Record<string, string>;
  templateFields: Record<string, string>;
  evidenceDrafts: Omit<OnboardingEvidenceDraft, 'selected'>[];
  mappingWarnings: string[];
}

interface CreatedTemplateDoc {
  id: string;
  name: string;
  webViewLink: string;
  templateMode?: string;
  warnings?: string[];
}

const SOURCE_OPTIONS: { id: CvSourceType; label: string; description: string }[] = [
  {
    id: 'google_docs',
    label: 'Google Docs',
    description: 'Best for editable CVs already in Drive.'
  },
  {
    id: 'pdf',
    label: 'PDF',
    description: 'Best-effort text extraction; scanned PDFs may fail.'
  },
  {
    id: 'docx',
    label: 'DOCX',
    description: 'Good for Word CVs with normal selectable text.'
  }
];

const PLACEHOLDER_CHECKLIST = [
  '{{TARGET_TITLE}}',
  '{{PROFESSIONAL_SUMMARY}}',
  '{{EXPERIENCE_1_TITLE}}',
  '{{EXPERIENCE_1_ORGANIZATION}}',
  '{{EXPERIENCE_1_DATE}}',
  '{{EXPERIENCE_1_BULLET_1}}',
  '{{EXPERIENCE_1_BULLET_2}}',
  '{{EXPERIENCE_1_BULLET_3}}',
  '{{EXPERIENCE_2_TITLE}}',
  '{{EXPERIENCE_2_ORGANIZATION}}',
  '{{EXPERIENCE_2_DATE}}',
  '{{EXPERIENCE_2_BULLET_1}}',
  '{{EXPERIENCE_2_BULLET_2}}',
  '{{EXPERIENCE_2_BULLET_3}}',
  '{{PROJECT_1_TITLE}}',
  '{{PROJECT_1_BULLET_1}}',
  '{{PROJECT_2_TITLE}}',
  '{{PROJECT_2_BULLET_1}}',
  '{{PROJECT_3_TITLE}}',
  '{{PROJECT_3_BULLET_1}}',
  '{{CERTIFICATIONS}}',
  '{{ACHIEVEMENT_BULLET_1}}',
  '{{HARD_SKILLS}}',
  '{{SOFT_SKILLS}}'
];

function cvSourceLabel(sourceType: CvSourceType) {
  return SOURCE_OPTIONS.find((item) => item.id === sourceType)?.label || sourceType;
}

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('Could not read file.'));
    reader.readAsDataURL(file);
  });
}

function friendlyError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error || 'Something went wrong.');
}

function draftEvidenceId(index: number, runStamp: number) {
  return `ONB-${runStamp.toString(36).toUpperCase()}-${String(index + 1).padStart(2, '0')}`;
}

export default function CVTemplateSetupPanel({ userId }: CVTemplateSetupPanelProps) {
  const [templateInput, setTemplateInput] = useState('');
  const [templateDocId, setTemplateDocId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [serverReadError, setServerReadError] = useState<string | null>(null);

  const [sourceType, setSourceType] = useState<CvSourceType>('google_docs');
  const [sourceLink, setSourceLink] = useState('');
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [parsedSource, setParsedSource] = useState<ParsedCvSource | null>(null);
  const [onboardingResult, setOnboardingResult] = useState<OnboardingResult | null>(null);
  const [evidenceDrafts, setEvidenceDrafts] = useState<OnboardingEvidenceDraft[]>([]);
  const [createdTemplate, setCreatedTemplate] = useState<CreatedTemplateDoc | null>(null);
  const [wizardStatus, setWizardStatus] = useState<WizardStatus>('idle');
  const [wizardMessage, setWizardMessage] = useState<string | null>(null);
  const [wizardError, setWizardError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadTemplate() {
      setLoading(true);
      setServerReadError(null);
      try {
        const profileRef = doc(db, 'profiles', userId);
        const snap = await getDocFromServer(profileRef);
        if (cancelled) return;
        if (snap.exists()) {
          const profile = snap.data() as Profile;
          setTemplateInput(profile.cvTemplateSourceUrl || profile.cvTemplateDocumentId || '');
          setTemplateDocId(profile.cvTemplateDocumentId || '');
        }
      } catch (err) {
        if (!cancelled) setServerReadError(formatFirestoreServerError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadTemplate();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const resetWizardOutput = () => {
    setParsedSource(null);
    setOnboardingResult(null);
    setEvidenceDrafts([]);
    setCreatedTemplate(null);
    setWizardMessage(null);
    setWizardError(null);
  };

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    const docId = extractGoogleDocId(templateInput);

    if (!docId) {
      setSaveMessage('Paste a Google Docs template link or document ID first.');
      return;
    }

    setSaving(true);
    setSaveMessage(null);
    const profileRef = doc(db, 'profiles', userId);
    const now = new Date().toISOString();

    try {
      await setDoc(profileRef, {
        cvTemplateDocumentId: docId,
        cvTemplateSourceUrl: templateInput.trim(),
        updatedAt: now
      }, { merge: true });
      setTemplateDocId(docId);
      setSaveMessage('CV template saved. Future CV generation will copy this Google Docs template.');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `profiles/${userId}`);
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    setSaveMessage(null);
    const profileRef = doc(db, 'profiles', userId);

    try {
      await setDoc(profileRef, {
        cvTemplateDocumentId: '',
        cvTemplateSourceUrl: '',
        updatedAt: new Date().toISOString()
      }, { merge: true });
      setTemplateInput('');
      setTemplateDocId('');
      setSaveMessage('Custom template removed. CV generation will use the default CareerRadar template.');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `profiles/${userId}`);
    } finally {
      setSaving(false);
    }
  };

  const handleParseSource = async () => {
    setWizardStatus('parsing');
    setWizardError(null);
    setWizardMessage(null);
    setParsedSource(null);
    setOnboardingResult(null);
    setEvidenceDrafts([]);
    setCreatedTemplate(null);

    try {
      let payload: Record<string, unknown> = { sourceType };

      if (sourceType === 'google_docs') {
        const documentId = extractGoogleDocId(sourceLink);
        if (!documentId) throw new Error('Paste a valid Google Docs CV link first.');
        const accessToken = await requestGoogleDriveAccessToken();
        payload = { sourceType, accessToken, googleDocUrl: sourceLink.trim(), documentId };
      } else {
        if (!sourceFile) throw new Error(`Choose a ${sourceType.toUpperCase()} CV file first.`);
        const expectedExtension = sourceType === 'pdf' ? '.pdf' : '.docx';
        if (!sourceFile.name.toLowerCase().endsWith(expectedExtension)) {
          throw new Error(`Please upload a ${expectedExtension.toUpperCase()} file.`);
        }
        if (sourceFile.size > 4 * 1024 * 1024) {
          throw new Error('CV file is too large. Please upload a file under 4MB.');
        }
        payload = {
          sourceType,
          fileName: sourceFile.name,
          mimeType: sourceFile.type,
          fileBase64: await fileToBase64(sourceFile)
        };
      }

      const response = await fetch('/api/parse-cv-source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'CV source could not be parsed.');

      setParsedSource(data as ParsedCvSource);
      setWizardMessage(`Parsed ${data.parsedTextCharacterCount || 0} characters from ${cvSourceLabel(sourceType)}.`);
    } catch (err) {
      setWizardError(friendlyError(err));
    } finally {
      setWizardStatus('idle');
    }
  };

  const handleGenerateOnboarding = async () => {
    if (!parsedSource) {
      setWizardError('Parse a CV source first.');
      return;
    }
    if (!hasStoredGeminiApiKey()) {
      setWizardError('Add your own Gemini API key in AI Settings first, then run CV onboarding.');
      return;
    }

    setWizardStatus('generating');
    setWizardError(null);
    setWizardMessage(null);
    setOnboardingResult(null);
    setEvidenceDrafts([]);
    setCreatedTemplate(null);

    try {
      const response = await fetch('/api/generate-cv-onboarding', {
        method: 'POST',
        headers: aiRequestHeaders(),
        body: JSON.stringify({
          parsedText: parsedSource.parsedText,
          sourceName: parsedSource.sourceName
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Gemini could not build CV onboarding drafts.');

      const result = data as OnboardingResult;
      setOnboardingResult(result);
      setEvidenceDrafts((result.evidenceDrafts || []).map((draft) => ({
        ...draft,
        selected: true
      })));
      setWizardMessage('Generated placeholder mapping and evidence drafts. Review before saving.');
    } catch (err) {
      setWizardError(friendlyError(err));
    } finally {
      setWizardStatus('idle');
    }
  };

  const handleCreateTemplate = async () => {
    if (!parsedSource || !onboardingResult) {
      setWizardError('Generate the onboarding mapping first.');
      return;
    }

    setWizardStatus('creatingTemplate');
    setWizardError(null);
    setWizardMessage(null);

    try {
      const accessToken = await requestGoogleDriveAccessToken();
      const response = await fetch('/api/create-placeholder-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken,
          sourceType: parsedSource.sourceType,
          sourceDocumentId: parsedSource.sourceDocumentId,
          sourceName: parsedSource.sourceName,
          templateFields: onboardingResult.templateFields,
          preserveSourceFormatting: false
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Placeholder template could not be created.');

      const created = data as CreatedTemplateDoc;
      await setDoc(doc(db, 'profiles', userId), {
        cvTemplateDocumentId: created.id,
        cvTemplateSourceUrl: created.webViewLink,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      setCreatedTemplate(created);
      setTemplateDocId(created.id);
      setTemplateInput(created.webViewLink);
      setWizardMessage(
        created.templateMode === 'normalized_ats'
          ? 'Clean placeholder template created in your Google Drive and saved for future CV generation.'
          : 'Placeholder template created in your Google Drive and saved for future CV generation.'
      );
    } catch (err) {
      setWizardError(friendlyError(err));
    } finally {
      setWizardStatus('idle');
    }
  };

  const handleSaveEvidenceDrafts = async () => {
    const selectedDrafts = evidenceDrafts.filter((draft) => draft.selected && draft.title.trim() && draft.description.trim());
    if (selectedDrafts.length === 0) {
      setWizardError('Select at least one evidence draft with a title and description.');
      return;
    }

    setWizardStatus('savingEvidence');
    setWizardError(null);
    setWizardMessage(null);

    try {
      const now = new Date().toISOString();
      const runStamp = Date.now();
      const evidenceCollectionPath = `profiles/${userId}/cv_evidences`;
      const batch = writeBatch(db);

      selectedDrafts.forEach((draft, index) => {
        const itemRef = doc(collection(db, evidenceCollectionPath));
        const skillTags = draft.inferredSkillTags?.length ? `\nSkill tags: ${draft.inferredSkillTags.join(', ')}` : '';
        const sourceNote = draft.sourceSection ? `\nSource section: ${draft.sourceSection}` : '';
        const payload: CVEvidence = {
          evidenceId: draftEvidenceId(index, runStamp),
          category: draft.category || 'Other Highlight',
          title: draft.title.trim(),
          organization: draft.organization.trim(),
          description: `${draft.description.trim()}${skillTags}${sourceNote}`,
          isVerified: false,
          createdAt: now,
          updatedAt: now
        };
        batch.set(itemRef, payload);
      });

      await batch.commit();
      setWizardMessage(`${selectedDrafts.length} evidence drafts saved as unverified review items.`);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `profiles/${userId}/cv_evidences`);
    } finally {
      setWizardStatus('idle');
    }
  };

  const updateEvidenceDraft = (index: number, patch: Partial<OnboardingEvidenceDraft>) => {
    setEvidenceDrafts((current) => current.map((draft, draftIndex) => (
      draftIndex === index ? { ...draft, ...patch } : draft
    )));
  };

  const previewUrl = templateDocId ? `https://docs.google.com/document/d/${templateDocId}/edit` : '';
  const isBusy = wizardStatus !== 'idle';

  return (
    <div id="cv_template_setup_panel" className="max-w-5xl mx-auto py-6 font-sans">
      <div className="md:flex md:items-center md:justify-between mb-8">
        <div className="flex-1 min-w-0">
          <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl tracking-tight flex items-center space-x-2">
            <FileText className="h-7 w-7 text-emerald-600" />
            <span>CV Template Setup</span>
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Start from an existing CV or connect your own placeholder template for generated drafts.
          </p>
        </div>
      </div>

      {serverReadError && (
        <div className="mb-6 rounded-2xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <div className="font-bold text-rose-900">Template setup read failed</div>
          <div className="mt-1">{serverReadError}</div>
        </div>
      )}

      <div className="space-y-6">
        <section className="rounded-2xl border border-emerald-100 bg-white p-6 shadow-sm">
          <div className="flex items-start gap-3">
            <Wand2 className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
            <div>
              <h3 className="text-lg font-bold text-slate-900">Auto-build from existing CV</h3>
              <p className="mt-1 text-sm leading-relaxed text-slate-500">
                Upload or link a CV, let Gemini extract only visible facts, then review the placeholder template and evidence drafts before saving.
              </p>
            </div>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-3">
            {SOURCE_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => {
                  setSourceType(option.id);
                  resetWizardOutput();
                }}
                className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                  sourceType === option.id
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-950'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                <div className="text-sm font-bold">{option.label}</div>
                <div className="mt-1 text-xs leading-relaxed">{option.description}</div>
              </button>
            ))}
          </div>

          <div className="mt-5">
            {sourceType === 'google_docs' ? (
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-600 mb-1">
                  Existing Google Docs CV link
                </label>
                <input
                  type="text"
                  value={sourceLink}
                  onChange={(event) => {
                    setSourceLink(event.target.value);
                    resetWizardOutput();
                  }}
                  placeholder="https://docs.google.com/document/d/..."
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none transition-all focus:bg-white focus:ring-1 focus:ring-emerald-500/50"
                />
              </div>
            ) : (
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-600 mb-1">
                  Upload {sourceType.toUpperCase()} CV
                </label>
                <input
                  type="file"
                  accept={sourceType === 'pdf' ? '.pdf,application/pdf' : '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document'}
                  onChange={(event) => {
                    setSourceFile(event.target.files?.[0] || null);
                    resetWizardOutput();
                  }}
                  className="block w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600 file:mr-4 file:rounded-lg file:border-0 file:bg-slate-900 file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-white"
                />
                <p className="mt-2 text-xs text-slate-400">Files are sent only for this request. Raw CV files are not stored in Firestore.</p>
              </div>
            )}
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleParseSource}
              disabled={isBusy}
              className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-xs font-bold text-white shadow-sm hover:bg-slate-700 disabled:bg-slate-400"
            >
              {wizardStatus === 'parsing' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              <span>{wizardStatus === 'parsing' ? 'Parsing...' : 'Parse CV text'}</span>
            </button>
            <button
              type="button"
              onClick={handleGenerateOnboarding}
              disabled={isBusy || !parsedSource}
              className="inline-flex items-center gap-2 rounded-xl border border-emerald-200 bg-white px-4 py-2 text-xs font-bold text-emerald-700 hover:bg-emerald-50 disabled:bg-slate-100 disabled:text-slate-400"
            >
              {wizardStatus === 'generating' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
              <span>{wizardStatus === 'generating' ? 'Generating...' : 'Generate mapping'}</span>
            </button>
          </div>

          {wizardError && (
            <div className="mt-4 rounded-xl border border-rose-100 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
              {wizardError}
            </div>
          )}
          {wizardMessage && (
            <div className="mt-4 rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800">
              {wizardMessage}
            </div>
          )}

          {parsedSource && (
            <div className="mt-5 rounded-xl border border-slate-100 bg-slate-50 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-bold text-slate-900">{parsedSource.sourceName}</div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {cvSourceLabel(parsedSource.sourceType)} source, {parsedSource.parsedTextCharacterCount} characters extracted
                  </div>
                </div>
                <CheckCircle2 className="h-5 w-5 text-emerald-600" />
              </div>
              {parsedSource.warnings?.map((warning) => (
                <div key={warning} className="mt-3 text-xs font-semibold text-amber-700">{warning}</div>
              ))}
              <details className="mt-3">
                <summary className="cursor-pointer text-xs font-bold text-slate-500">Preview extracted text</summary>
                <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-white p-3 text-xs leading-relaxed text-slate-600">
                  {parsedSource.parsedText}
                </pre>
              </details>
            </div>
          )}

          {onboardingResult && (
            <div className="mt-6 space-y-5">
              <div className="rounded-xl border border-slate-100 bg-slate-50 p-4">
                <h4 className="text-sm font-bold text-slate-900">Template mapping preview</h4>
                {onboardingResult.mappingWarnings?.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {onboardingResult.mappingWarnings.map((warning) => (
                      <div key={warning} className="rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
                        {warning}
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-4 grid gap-2 md:grid-cols-2">
                  {Object.entries(onboardingResult.templateFields || {}).slice(0, 16).map(([key, value]) => (
                    <div key={key} className="rounded-lg border border-slate-100 bg-white px-3 py-2">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{key}</div>
                      <div className="mt-1 text-xs text-slate-700">{value || '[Needs verified input]'}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-slate-100 bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h4 className="text-sm font-bold text-slate-900">Evidence draft review</h4>
                    <p className="mt-1 text-xs text-slate-500">Saved drafts stay unverified until the user manually confirms them later.</p>
                  </div>
                  <button
                    type="button"
                    onClick={handleSaveEvidenceDrafts}
                    disabled={isBusy || evidenceDrafts.length === 0}
                    className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-xs font-bold text-white shadow-sm hover:bg-slate-700 disabled:bg-slate-400"
                  >
                    {wizardStatus === 'savingEvidence' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    <span>{wizardStatus === 'savingEvidence' ? 'Saving...' : 'Save selected drafts'}</span>
                  </button>
                </div>

                <div className="mt-4 space-y-4">
                  {evidenceDrafts.map((draft, index) => (
                    <div key={`${draft.title}-${index}`} className="rounded-xl border border-slate-100 bg-slate-50 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <label className="inline-flex items-center gap-2 text-xs font-bold text-slate-700">
                          <input
                            type="checkbox"
                            checked={draft.selected}
                            onChange={(event) => updateEvidenceDraft(index, { selected: event.target.checked })}
                            className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                          />
                          Review draft {index + 1}
                        </label>
                        <span className="rounded-full bg-white px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                          Confidence {Math.round(Number(draft.confidence || 0) * 100)}%
                        </span>
                      </div>

                      <div className="mt-3 grid gap-3 md:grid-cols-3">
                        <input
                          value={draft.category}
                          onChange={(event) => updateEvidenceDraft(index, { category: event.target.value })}
                          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:ring-1 focus:ring-emerald-500/50"
                        />
                        <input
                          value={draft.title}
                          onChange={(event) => updateEvidenceDraft(index, { title: event.target.value })}
                          placeholder="Evidence title"
                          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:ring-1 focus:ring-emerald-500/50 md:col-span-2"
                        />
                      </div>
                      <input
                        value={draft.organization}
                        onChange={(event) => updateEvidenceDraft(index, { organization: event.target.value })}
                        placeholder="Organization"
                        className="mt-3 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:ring-1 focus:ring-emerald-500/50"
                      />
                      <textarea
                        value={draft.description}
                        onChange={(event) => updateEvidenceDraft(index, { description: event.target.value })}
                        rows={3}
                        className="mt-3 w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs leading-relaxed outline-none focus:ring-1 focus:ring-emerald-500/50"
                      />
                      <div className="mt-2 text-[11px] text-slate-400">
                        Source: {draft.sourceSection || 'CV text'}{draft.inferredSkillTags?.length ? ` | Tags: ${draft.inferredSkillTags.join(', ')}` : ''}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={handleCreateTemplate}
                  disabled={isBusy}
                  className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white shadow-sm hover:bg-emerald-700 disabled:bg-slate-400"
                >
                  {wizardStatus === 'creatingTemplate' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                  <span>{wizardStatus === 'creatingTemplate' ? 'Creating...' : 'Create placeholder template'}</span>
                </button>
                {createdTemplate && (
                  <>
                    <a
                      href={createdTemplate.webViewLink}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 rounded-xl border border-emerald-200 bg-white px-4 py-2 text-xs font-bold text-emerald-700 hover:bg-emerald-50"
                    >
                      <ExternalLink className="h-4 w-4" />
                      <span>Open generated template</span>
                    </a>
                    {createdTemplate.warnings?.map((warning) => (
                      <span key={warning} className="text-xs font-semibold text-slate-500">{warning}</span>
                    ))}
                  </>
                )}
              </div>
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
          <div className="flex items-start gap-3">
            <ShieldCheck className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
            <div>
              <h3 className="text-lg font-bold text-slate-900">Use your own placeholder template</h3>
              <p className="mt-1 text-sm leading-relaxed text-slate-500">
                Create or copy a Google Docs CV, add CareerRadar placeholders, then paste the document link here.
              </p>
            </div>
          </div>

          <form onSubmit={handleSave} className="mt-5 space-y-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-600 mb-1">
                Google Docs CV template link
              </label>
              <input
                type="text"
                value={templateInput}
                onChange={(event) => setTemplateInput(event.target.value)}
                placeholder="https://docs.google.com/document/d/..."
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none transition-all focus:bg-white focus:ring-1 focus:ring-emerald-500/50"
              />
              <p className="mt-2 text-xs text-slate-400">
                Make sure the Google account you use here can open the document, because CV generation will copy it through your Drive permission.
              </p>
            </div>

            {templateDocId && (
              <div className="rounded-xl border border-emerald-100 bg-emerald-50/60 px-3 py-2 text-xs font-semibold text-emerald-800">
                Active template ID: <span className="font-mono">{templateDocId}</span>
              </div>
            )}

            {saveMessage && (
              <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700">
                {saveMessage}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={saving || loading}
                className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-xs font-bold text-white shadow-sm hover:bg-slate-700 disabled:bg-slate-400"
              >
                <Save className="h-4 w-4" />
                <span>{saving ? 'Saving...' : 'Save template'}</span>
              </button>
              <button
                type="button"
                onClick={handleClear}
                disabled={saving || loading}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:bg-slate-100"
              >
                Use default template
              </button>
              {previewUrl && (
                <a
                  href={previewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 rounded-xl border border-emerald-200 bg-white px-4 py-2 text-xs font-bold text-emerald-700 hover:bg-emerald-50"
                >
                  <ExternalLink className="h-4 w-4" />
                  <span>Open template</span>
                </a>
              )}
            </div>
          </form>
        </section>

        <section className="rounded-2xl border border-amber-100 bg-amber-50/50 p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <h3 className="text-base font-bold text-amber-900">Placeholder checklist</h3>
              <p className="mt-1 text-sm leading-relaxed text-amber-800">
                Use the generic placeholders below for new templates. Legacy Kemas placeholders are still supported for older templates.
              </p>
              <div className="mt-4 grid grid-cols-1 gap-2 text-xs font-mono text-amber-900 sm:grid-cols-2">
                {PLACEHOLDER_CHECKLIST.map((item) => (
                  <div key={item} className="rounded-lg border border-amber-100 bg-white/70 px-3 py-2">{item}</div>
                ))}
              </div>
              <p className="mt-3 text-xs leading-relaxed text-amber-800">
                Legacy aliases still work: <span className="font-mono">CSA_BULLET_*</span>, <span className="font-mono">XL_BULLET_*</span>, and <span className="font-mono">PORTFOLIO_BULLET_*</span>.
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
