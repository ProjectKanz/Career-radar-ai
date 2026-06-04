import { useEffect, useMemo, useState } from 'react';
import { Database, Check, AlertTriangle, UploadCloud } from 'lucide-react';
import { collection, doc, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { ApplicationPack, BriefStatus, CVEditChecklist, CVEvidence, CareerRadarOpportunity, DailyApplyBrief, DecisionType, JobSearchRaw, Profile } from '../types';

interface LegacyImportPanelProps {
  userId: string;
}

interface LegacyPayload {
  exportedAt: string;
  sourceFile: string;
  counts: Record<string, number>;
  sheets: Record<string, LegacyRow[]>;
}

type LegacyRow = Record<string, string>;

const DECISIONS: DecisionType[] = ['Apply Now', 'Apply After CV Adjustment', 'Save for Later', 'Skip', 'Verify First'];
const BRIEF_STATUSES: BriefStatus[] = [
  'Applied',
  'Expired',
  'Cancelled',
  'Canceled',
  'Closed',
  'Skipped',
  'Not Applied',
  'Not Applied - Closed',
  'Not Applied - Expired',
  'Rejected',
  'Withdrawn',
  'Queued',
  'Pending',
  'Review',
  'Retry Later'
];

function value(row: LegacyRow, key: string) {
  return (row[key] || '').trim();
}

function numberValue(row: LegacyRow, key: string) {
  const raw = value(row, key).replace(',', '.');
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function truthyLegacy(raw: string) {
  return ['yes', 'true', 'done', '1', 'y'].includes(raw.trim().toLowerCase());
}

function excelDateToIso(raw: string) {
  const serial = Number(raw);
  if (Number.isFinite(serial) && serial > 25000) {
    return new Date((serial - 25569) * 86400 * 1000).toISOString();
  }

  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toISOString();
  }

  return new Date().toISOString();
}

function excelDateToDate(raw: string) {
  return excelDateToIso(raw).split('T')[0];
}

function hashText(input: string) {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function slugText(input: string) {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42);

  return slug || 'item';
}

function legacyDocId(prefix: string, parts: string[]) {
  const key = parts.filter(Boolean).join('|') || prefix;
  return `${prefix}_${slugText(parts.slice(0, 2).join(' '))}_${hashText(key)}`;
}

function keyForOpportunity(company: string, role: string) {
  return `${company.trim().toLowerCase()}|${role.trim().toLowerCase()}`;
}

function mapDecision(raw: string): DecisionType {
  return DECISIONS.includes(raw as DecisionType) ? raw as DecisionType : 'Verify First';
}

function mapBriefStatus(raw: string): BriefStatus {
  return BRIEF_STATUSES.includes(raw as BriefStatus) ? raw as BriefStatus : 'Review';
}

function mapApplicationEnergy(raw: string): ApplicationPack['applicationEnergy'] {
  if (raw === 'High' || raw === 'Medium' || raw === 'Lock' || raw === 'None') {
    return raw;
  }
  return 'Medium';
}

function mapEvidenceCategory(type: string) {
  const normalized = type.toLowerCase();
  if (normalized.includes('portfolio')) return 'Side Project / Portfolio';
  if (normalized.includes('certification')) return 'Certification';
  if (normalized.includes('skill')) return 'Hard Skill / Technical Fact';
  if (normalized.includes('education') || normalized.includes('achievement')) return 'Academic Honor';
  if (normalized.includes('work') || normalized.includes('internship')) return 'Work Achievement';
  return 'Other Highlight';
}

function stripUndefined<T extends object>(data: T): T {
  return Object.fromEntries(
    Object.entries(data as Record<string, unknown>).filter(([, item]) => item !== undefined)
  ) as T;
}

function profileFromRows(rows: LegacyRow[]): Profile {
  const fields = new Map(rows.map((row) => [value(row, 'Field'), value(row, 'Value')]));
  const education = fields.get('Education') || '';
  const salary = fields.get('Salary Target') || '';
  const salaryNumbers = salary.match(/\d[\d.]*/g)?.map((item) => Number(item.replace(/\./g, ''))) || [];
  const gpa = Number(education.match(/GPA\s*([0-4](?:\.\d+)?)/i)?.[1]);

  return stripUndefined({
    fullName: fields.get('Profile Name') || 'Anonymous User',
    education,
    graduationDate: education.match(/Graduated\s+([^.,]+)/i)?.[1] || '',
    gpa: Number.isFinite(gpa) ? gpa : undefined,
    workExperienceCount: undefined,
    experienceBrief: fields.get('Experience Summary') || '',
    targetRoles: fields.get('Target Roles') || '',
    preferredLocations: fields.get('Preferred Locations') || fields.get('Location') || '',
    salaryTargetMin: salaryNumbers[0],
    salaryTargetMax: salaryNumbers[1],
    portfolioWording: [
      fields.get('Portfolio Summary'),
      fields.get('Achievements') ? `Achievements: ${fields.get('Achievements')}` : '',
      fields.get('Skills') ? `Skills: ${fields.get('Skills')}` : '',
      fields.get('CV Link') ? `CV: ${fields.get('CV Link')}` : ''
    ].filter(Boolean).join('\n\n'),
    updatedAt: new Date().toISOString()
  });
}

function evidenceFromRow(row: LegacyRow): CVEvidence {
  const metric = value(row, 'Metric / Number');
  const preferred = value(row, 'Preferred Wording');
  const claim = value(row, 'Verified Claim');
  const skillTags = value(row, 'Skill Tags');

  return {
    evidenceId: value(row, 'Evidence ID'),
    category: mapEvidenceCategory(value(row, 'Evidence Type')),
    title: value(row, 'Role / Context') || claim || value(row, 'Evidence ID'),
    organization: value(row, 'Institution / Company / Project') || value(row, 'Source Section'),
    description: [preferred || claim, metric ? `Metric: ${metric}` : '', skillTags ? `Skill tags: ${skillTags}` : ''].filter(Boolean).join('\n'),
    isVerified: truthyLegacy(value(row, 'Can Use In CV?')) && value(row, 'Risk Level').toLowerCase() !== 'high',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

export default function LegacyImportPanel({ userId }: LegacyImportPanelProps) {
  const [payload, setPayload] = useState<LegacyPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/legacy-career-radar-import.json')
      .then((response) => {
        if (!response.ok) throw new Error('Legacy import JSON was not found.');
        return response.json();
      })
      .then((data: LegacyPayload) => setPayload(data))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  const totalRows = useMemo(() => {
    if (!payload) return 0;
    return Object.values(payload.counts).reduce((sum: number, count) => sum + Number(count), 0);
  }, [payload]);

  const runImport = async () => {
    if (!payload) return;

    setImporting(true);
    setError(null);
    setMessage(null);

    try {
      const batch = writeBatch(db);
      const sheets = payload.sheets;
      const opportunityIds = new Map<string, string>();

      const getOpportunityId = (company: string, role: string, fallback: string[]) => {
        const key = keyForOpportunity(company, role);
        const existing = opportunityIds.get(key);
        if (existing) return existing;

        const id = legacyDocId('legacy_opp', [company, role, ...fallback]);
        opportunityIds.set(key, id);
        return id;
      };

      const profile = profileFromRows(sheets.Profile || []);
      batch.set(doc(db, 'profiles', userId), stripUndefined(profile), { merge: true });

      for (const row of sheets.CV_Evidence_Bank || []) {
        const evidence = evidenceFromRow(row);
        if (!evidence.evidenceId) continue;
        batch.set(doc(db, `profiles/${userId}/cv_evidences`, evidence.evidenceId), stripUndefined(evidence), { merge: true });
      }

      for (const row of sheets.Career_Radar || []) {
        const company = value(row, 'Company') || 'Unknown Company';
        const role = value(row, 'Role') || 'Untitled Role';
        const opportunityId = getOpportunityId(company, role, [value(row, 'Source URL'), value(row, 'Timestamp')]);
        const createdAt = excelDateToIso(value(row, 'Timestamp'));
        const redFlags = value(row, 'Red Flags');

        const opportunity: CareerRadarOpportunity = {
          company,
          role,
          location: value(row, 'Location'),
          sourceUrl: value(row, 'Source URL'),
          applyLink: value(row, 'Apply Link'),
          jobText: value(row, 'Requirements'),
          fitScore: numberValue(row, 'Fit Score'),
          decision: mapDecision(value(row, 'Decision')),
          analysisNotes: [value(row, 'Scoring Rationale'), value(row, 'Next Action')].filter(Boolean).join('\n\n'),
          roleDna: [value(row, 'Role Family'), value(row, 'Program Type'), value(row, 'Requirements')].filter(Boolean).join('\n'),
          educationFit: [value(row, 'Accepted Majors'), value(row, 'User Major Fit'), value(row, 'GPA Fit'), value(row, 'Language Fit')].filter(Boolean).join('\n'),
          experienceFit: [value(row, 'Experience Requirement'), value(row, 'Fresh Graduate Fit'), value(row, 'Leadership Fit'), value(row, 'Industry Fit'), value(row, 'Career Direction Fit'), value(row, 'Placement Risk')].filter(Boolean).join('\n'),
          portfolioFit: value(row, 'Portfolio Match'),
          hasRedFlags: Boolean(redFlags || value(row, 'Red Flag Level')),
          redFlags: [value(row, 'Red Flag Level'), redFlags, value(row, 'CV Gap')].filter(Boolean).join('\n'),
          isStretchRole: value(row, 'Match Level').toLowerCase().includes('stretch'),
          createdAt,
          updatedAt: createdAt
        };

        batch.set(doc(db, `profiles/${userId}/opportunities`, opportunityId), stripUndefined(opportunity), { merge: true });
      }

      for (const row of sheets.Application_Pack || []) {
        const company = value(row, 'Company') || 'Unknown Company';
        const role = value(row, 'Role') || 'Untitled Role';
        const opportunityId = getOpportunityId(company, role, [value(row, 'Source URL'), value(row, 'Timestamp')]);
        const createdAt = excelDateToIso(value(row, 'Timestamp'));

        const pack: ApplicationPack = {
          opportunityId,
          company,
          role,
          applicationEnergy: mapApplicationEnergy(value(row, 'Application Energy')),
          cvAction: value(row, 'CV Action'),
          cvAngle: value(row, 'CV Angle'),
          keywordsToEmphasize: value(row, 'Keywords to Emphasize'),
          summaryRewrite: value(row, 'Summary Rewrite'),
          bulletPrioritization: value(row, 'Bullet Prioritization'),
          coverMessage: value(row, 'Short Cover Message'),
          linkedinMessage: value(row, 'LinkedIn/HR Message'),
          portfolioEvidence: value(row, 'Portfolio Evidence'),
          reviewNotes: value(row, 'Review Notes') || [value(row, 'Status'), value(row, 'Error')].filter(Boolean).join('\n'),
          hardSkills: value(row, 'Hard Skills to Emphasize'),
          softSkills: value(row, 'Soft Skills to Emphasize'),
          cvSectionActions: value(row, 'CV Section Actions'),
          cvReadyLink: value(row, 'CV Ready Link'),
          cvReadyStatus: value(row, 'CV Ready Status') as ApplicationPack['cvReadyStatus'],
          cvReadyAt: value(row, 'CV Ready At') ? excelDateToIso(value(row, 'CV Ready At')) : '',
          cvReadyNotes: value(row, 'CV Ready Notes'),
          createdAt,
          updatedAt: createdAt
        };

        batch.set(doc(db, `profiles/${userId}/application_packs`, opportunityId), stripUndefined(pack), { merge: true });
      }

      (sheets.CV_Edit_Checklist || []).forEach((row, index) => {
        const company = value(row, 'Company') || 'Unknown Company';
        const role = value(row, 'Role') || 'Untitled Role';
        if (!value(row, 'CV Section') && !value(row, 'Final Suggested Text')) return;

        const opportunityId = getOpportunityId(company, role, [String(index), value(row, 'Timestamp')]);
        const createdAt = excelDateToIso(value(row, 'Timestamp'));
        const checklist: CVEditChecklist = {
          opportunityId,
          company,
          role,
          cvSection: value(row, 'CV Section') || 'Professional Summary',
          editType: value(row, 'Edit Type'),
          sourceEvidence: value(row, 'Current / Source Evidence'),
          finalSuggestedText: value(row, 'Final Suggested Text'),
          whyTheChangeMatters: value(row, 'Why This Change'),
          priority: value(row, 'Priority') || 'Medium',
          evidenceId: value(row, 'Evidence ID'),
          groundingStatus: value(row, 'Grounding Status') as CVEditChecklist['groundingStatus'],
          isReadyToCopy: truthyLegacy(value(row, 'Ready to Copy?')),
          qualityNotes: value(row, 'Quality Notes'),
          isStale: false,
          isDone: truthyLegacy(value(row, 'Done?')),
          createdAt,
          updatedAt: createdAt
        };

        const id = legacyDocId('legacy_check', [opportunityId, String(index), checklist.cvSection, checklist.finalSuggestedText]);
        batch.set(doc(db, `profiles/${userId}/cv_checklists`, id), stripUndefined(checklist), { merge: true });
      });

      (sheets.Daily_Apply_Brief || []).forEach((row, index) => {
        const company = value(row, 'Company') || 'Unknown Company';
        const role = value(row, 'Role') || 'Untitled Role';
        const opportunityId = getOpportunityId(company, role, [String(index), value(row, 'Date')]);
        const createdAt = excelDateToIso(value(row, 'Date'));
        const originalStatus = value(row, 'Status');

        const brief: DailyApplyBrief = {
          opportunityId,
          company,
          role,
          fitScore: numberValue(row, 'Fit Score'),
          decision: value(row, 'Decision') || 'Review',
          applicationEnergy: value(row, 'Application Energy'),
          cvAction: value(row, 'CV Action') || value(row, 'Today Action'),
          priority: value(row, 'Priority Rank'),
          userActionNeeded: value(row, 'User Action Needed'),
          briefDate: excelDateToDate(value(row, 'Date')),
          status: mapBriefStatus(originalStatus),
          userNotes: [
            value(row, 'Notes'),
            value(row, 'Why This Priority') ? `Why priority: ${value(row, 'Why This Priority')}` : '',
            value(row, 'Apply Link') ? `Apply link: ${value(row, 'Apply Link')}` : '',
            originalStatus && mapBriefStatus(originalStatus) !== originalStatus ? `Legacy status: ${originalStatus}` : ''
          ].filter(Boolean).join('\n'),
          createdAt,
          updatedAt: createdAt
        };

        const id = legacyDocId('legacy_brief', [opportunityId, String(index), brief.briefDate || '']);
        batch.set(doc(db, `profiles/${userId}/daily_apply_briefs`, id), stripUndefined(brief), { merge: true });
      });

      (sheets.Job_Search_Raw || []).forEach((row, index) => {
        const createdAt = excelDateToIso(value(row, 'Timestamp'));
        const discoveryStatus = value(row, 'Discovery Status') || value(row, 'Status');
        const rawJob: JobSearchRaw = {
          sourceUrl: value(row, 'Source URL'),
          applyLink: value(row, 'Apply Link'),
          jobText: value(row, 'Job Text'),
          company: value(row, 'Company'),
          role: value(row, 'Role'),
          location: value(row, 'Location'),
          searchQuery: value(row, 'Search Query'),
          sourceType: value(row, 'Source Type') || value(row, 'Source Name'),
          discoveryStatus: ['Staged', 'Processing', 'Processed', 'Rejected'].includes(discoveryStatus) ? discoveryStatus as JobSearchRaw['discoveryStatus'] : 'Staged',
          dedupeKey: value(row, 'Dedupe Key'),
          createdAt,
          updatedAt: createdAt
        };

        const id = legacyDocId('legacy_raw', [rawJob.sourceUrl || rawJob.company || rawJob.role || String(index), String(index)]);
        batch.set(doc(collection(db, `profiles/${userId}/job_search_raw`), id), stripUndefined(rawJob), { merge: true });
      });

      await batch.commit();
      setMessage(`Imported ${totalRows} legacy rows into Firestore. Refreshing workspace...`);
      window.setTimeout(() => window.location.reload(), 1200);
    } catch (err) {
      console.error('Legacy import failed:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div id="legacy_import_panel" className="max-w-4xl mx-auto py-6 font-sans">
      <div className="md:flex md:items-center md:justify-between mb-8">
        <div className="flex-1 min-w-0">
          <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl tracking-tight flex items-center space-x-2">
            <Database className="h-7 w-7 text-emerald-600" />
            <span>Legacy Data Import</span>
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Bring the previous Career Radar workbook history into this Firestore workspace.
          </p>
        </div>
      </div>

      <div className="bg-white border border-slate-100 shadow-sm rounded-2xl p-6 space-y-6">
        {loading ? (
          <div className="inline-flex items-center gap-2 text-xs font-semibold text-slate-400">
            <span className="h-3.5 w-3.5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin"></span>
            <span>Loading legacy data file...</span>
          </div>
        ) : payload ? (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {Object.entries(payload.counts).map(([sheet, count]) => (
                <div key={sheet} className="border border-slate-100 bg-slate-50/50 rounded-xl p-3">
                  <div className="text-lg font-black text-slate-800">{count}</div>
                  <div className="text-[10px] uppercase tracking-wide font-bold text-slate-400 truncate">{sheet}</div>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={runImport}
              disabled={importing}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400 text-white rounded-xl text-sm font-semibold shadow-md cursor-pointer"
            >
              <UploadCloud className={`h-4 w-4 ${importing ? 'animate-pulse' : ''}`} />
              <span>{importing ? 'Importing Legacy Data...' : `Import ${totalRows} Legacy Rows`}</span>
            </button>
          </>
        ) : null}

        {message && (
          <div className="p-4 bg-emerald-50 border border-emerald-100 rounded-xl text-emerald-700 text-sm font-semibold flex items-start gap-2">
            <Check className="h-4 w-4 mt-0.5" />
            <span>{message}</span>
          </div>
        )}

        {error && (
          <div className="p-4 bg-rose-50 border border-rose-100 rounded-xl text-rose-700 text-sm font-semibold flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
      </div>
    </div>
  );
}
