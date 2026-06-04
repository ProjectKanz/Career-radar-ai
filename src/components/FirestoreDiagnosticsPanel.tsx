import { useEffect, useState } from 'react';
import { collection, doc, getDocFromServer, getDocsFromServer } from 'firebase/firestore';
import { Activity } from 'lucide-react';
import { db, formatFirestoreServerError, getFirestoreDiagnostics } from '../firebase';

interface FirestoreDiagnosticsPanelProps {
  userId: string;
}

type ReadStatus = 'idle' | 'checking' | 'success' | 'error';

interface DiagnosticRead {
  status: ReadStatus;
  message: string;
}

function statusClass(status: ReadStatus) {
  if (status === 'success') return 'text-emerald-700 bg-emerald-50 border-emerald-100';
  if (status === 'error') return 'text-rose-700 bg-rose-50 border-rose-100';
  if (status === 'checking') return 'text-amber-700 bg-amber-50 border-amber-100';
  return 'text-slate-600 bg-slate-50 border-slate-100';
}

async function checkRead(label: string, read: () => Promise<unknown>): Promise<DiagnosticRead> {
  try {
    await read();
    return { status: 'success', message: `${label}: server read ok` };
  } catch (error) {
    return { status: 'error', message: `${label}: ${formatFirestoreServerError(error)}` };
  }
}

export default function FirestoreDiagnosticsPanel({ userId }: FirestoreDiagnosticsPanelProps) {
  const [reads, setReads] = useState<Record<string, DiagnosticRead>>({
    profile: { status: 'idle', message: 'Profile: not checked' },
    evidence: { status: 'idle', message: 'Evidence: not checked' },
    opportunities: { status: 'idle', message: 'Opportunities: not checked' }
  });

  useEffect(() => {
    let cancelled = false;

    async function runDiagnostics() {
      setReads({
        profile: { status: 'checking', message: 'Profile: checking server read...' },
        evidence: { status: 'checking', message: 'Evidence: checking server read...' },
        opportunities: { status: 'checking', message: 'Opportunities: checking server read...' }
      });

      const [profile, evidence, opportunities] = await Promise.all([
        checkRead('Profile', () => getDocFromServer(doc(db, 'profiles', userId))),
        checkRead('Evidence', () => getDocsFromServer(collection(db, `profiles/${userId}/cv_evidences`))),
        checkRead('Opportunities', () => getDocsFromServer(collection(db, `profiles/${userId}/opportunities`)))
      ]);

      if (!cancelled) {
        setReads({ profile, evidence, opportunities });
      }
    }

    runDiagnostics();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  const diagnostics = getFirestoreDiagnostics();

  return (
    <details className="mb-4 rounded-2xl border border-slate-100 bg-white px-4 py-3 text-xs text-slate-600 shadow-sm">
      <summary className="cursor-pointer font-bold text-slate-800 inline-flex items-center gap-2">
        <Activity className="h-4 w-4 text-emerald-600" />
        <span>Developer Firestore Diagnostics</span>
      </summary>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
          <div>projectId: <strong>{diagnostics.projectId || '-'}</strong></div>
          <div>authDomain: <strong>{diagnostics.authDomain || '-'}</strong></div>
          <div>firestoreDatabaseId: <strong>{diagnostics.firestoreDatabaseId}</strong></div>
          <div>current UID: <strong>{userId || diagnostics.currentUserUid || '-'}</strong></div>
        </div>
        <div className="space-y-2">
          {(Object.entries(reads) as Array<[string, DiagnosticRead]>).map(([key, read]) => (
            <div key={key} className={`rounded-xl border px-3 py-2 ${statusClass(read.status)}`}>
              {read.message}
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}
