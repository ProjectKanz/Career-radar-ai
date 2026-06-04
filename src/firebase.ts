import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut } from 'firebase/auth';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  doc,
  getDocFromServer
} from 'firebase/firestore';
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const missingFirebaseKeys = Object.entries(firebaseConfig)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missingFirebaseKeys.length > 0) {
  console.warn('Missing Firebase environment variables:', missingFirebaseKeys.join(', '));
}

const app = initializeApp(firebaseConfig);
export const FIRESTORE_DATABASE_ID = import.meta.env.VITE_FIRESTORE_DATABASE_ID || '(default)';
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
}, FIRESTORE_DATABASE_ID); /* CRITICAL: The app will break without this line */
export const auth = getAuth(app);

export interface FirebaseStartupDiagnostics {
  projectId?: string;
  authDomain?: string;
  firestoreDatabaseId: string;
  currentUserUid?: string | null;
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export function getFirestoreDiagnostics(): FirebaseStartupDiagnostics {
  return {
    projectId: firebaseConfig.projectId,
    authDomain: firebaseConfig.authDomain,
    firestoreDatabaseId: FIRESTORE_DATABASE_ID,
    currentUserUid: auth.currentUser?.uid || null
  };
}

export function isFirestoreDatabaseNotFound(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /database .*not found|database '\(default\)' not found|not found.*database/i.test(message);
}

export function formatFirestoreServerError(error: unknown) {
  if (isFirestoreDatabaseNotFound(error)) {
    return 'Firestore server database not found. Please check Firebase database ID.';
  }

  return error instanceof Error ? error.message : String(error);
}

export async function loginWithGoogle() {
  const provider = new GoogleAuthProvider();
  try {
    const result = await signInWithPopup(auth, provider);
    return result.user;
  } catch (err) {
    console.error('Google Sign-In Popup Error:', err);
    throw err;
  }
}

export async function requestGoogleDriveAccessToken() {
  const provider = new GoogleAuthProvider();
  provider.addScope('https://www.googleapis.com/auth/drive');
  provider.addScope('https://www.googleapis.com/auth/documents');
  provider.setCustomParameters({
    prompt: 'consent'
  });

  try {
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);

    if (!credential?.accessToken) {
      throw new Error('Google Drive access token was not returned. Please try signing in again.');
    }

    return credential.accessToken;
  } catch (err) {
    console.error('Google Drive Authorization Error:', err);
    throw err;
  }
}

export async function loginWithGoogleRedirect() {
  const provider = new GoogleAuthProvider();
  try {
    await signInWithRedirect(auth, provider);
  } catch (err) {
    console.error('Google Sign-In Redirect Error:', err);
    throw err;
  }
}

export async function logout() {
  try {
    await signOut(auth);
  } catch (err) {
    console.error('Sign Out Error:', err);
    throw err;
  }
}

export async function testConnection(userId = auth.currentUser?.uid || '') {
  const diagnostics = getFirestoreDiagnostics();
  console.info('Firebase startup diagnostics:', diagnostics);

  if (!userId) {
    const message = 'No authenticated user UID available for Firestore server read.';
    console.warn('Firestore server read skipped:', {
      ...diagnostics,
      error: message
    });
    return { ok: false, diagnostics, error: message, databaseNotFound: false };
  }

  try {
    await getDocFromServer(doc(db, 'profiles', userId));
    console.info('Firestore server read success:', {
      ...diagnostics,
      currentUserUid: auth.currentUser?.uid || null
    });
    return { ok: true, diagnostics };
  } catch (error) {
    const message = formatFirestoreServerError(error);
    console.error('Firestore server read failure:', {
      ...diagnostics,
      currentUserUid: auth.currentUser?.uid || null,
      error: message,
      rawError: error
    });
    return { ok: false, diagnostics, error: message, databaseNotFound: isFirestoreDatabaseNotFound(error) };
  }
}

