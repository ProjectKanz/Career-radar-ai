import { FormEvent, useEffect, useState } from 'react';
import { FileText, Save, ShieldCheck, ExternalLink, AlertTriangle } from 'lucide-react';
import { doc, getDocFromServer, setDoc } from 'firebase/firestore';
import { db, formatFirestoreServerError, handleFirestoreError, OperationType } from '../firebase';
import { Profile } from '../types';
import { extractGoogleDocId } from '../utils/cvDrive';

interface CVTemplateSetupPanelProps {
  userId: string;
}

export default function CVTemplateSetupPanel({ userId }: CVTemplateSetupPanelProps) {
  const [templateInput, setTemplateInput] = useState('');
  const [templateDocId, setTemplateDocId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [serverReadError, setServerReadError] = useState<string | null>(null);

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

  const previewUrl = templateDocId ? `https://docs.google.com/document/d/${templateDocId}/edit` : '';

  return (
    <div id="cv_template_setup_panel" className="max-w-4xl mx-auto py-6 font-sans">
      <div className="md:flex md:items-center md:justify-between mb-8">
        <div className="flex-1 min-w-0">
          <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl tracking-tight flex items-center space-x-2">
            <FileText className="h-7 w-7 text-emerald-600" />
            <span>CV Template Setup</span>
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Connect your own Google Docs CV template so generated drafts land in your preferred format.
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
                V1 supports custom templates that already contain placeholders. Use the generic placeholders below for new templates. Legacy Kemas placeholders are still supported for older templates.
              </p>
              <div className="mt-4 grid grid-cols-1 gap-2 text-xs font-mono text-amber-900 sm:grid-cols-2">
                {[
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
                ].map((item) => (
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
