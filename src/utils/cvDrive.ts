import { ApplicationPack, CVEditChecklist, CVEvidence, CareerRadarOpportunity, Profile } from '../types';

export interface CVTemplateFields {
  targetTitle: string;
  professionalSummary: string;
  experience1Title: string;
  experience1Organization: string;
  experience1Date: string;
  experience1Bullet1: string;
  experience1Bullet2: string;
  experience1Bullet3: string;
  experience2Title: string;
  experience2Organization: string;
  experience2Date: string;
  experience2Bullet1: string;
  experience2Bullet2: string;
  experience2Bullet3: string;
  project1Title: string;
  project1Bullet1: string;
  project2Title: string;
  project2Bullet1: string;
  project3Title: string;
  project3Bullet1: string;
  certifications: string;
  certificationBullet1: string;
  certificationBullet2: string;
  certificationBullet3: string;
  certificationBullet4: string;
  achievementBullet1: string;
  achievementBullet2: string;
  achievementBullet3: string;
  hardSkills: string;
  softSkills: string;
  languages: string;
}

interface LegacyCVTemplateFields {
  csaBullet1?: string;
  csaBullet2?: string;
  csaBullet3?: string;
  xlBullet1?: string;
  xlBullet2?: string;
  xlBullet3?: string;
  portfolioBullet1?: string;
  portfolioBullet2?: string;
  portfolioBullet3?: string;
}

interface GenerateCvDocInput {
  accessToken: string;
  folderId?: string;
  profile: Profile;
  opportunity: CareerRadarOpportunity;
  pack: ApplicationPack;
  evidences: CVEvidence[];
  checklists: CVEditChecklist[];
  templateFields: CVTemplateFields;
  onProgress?: (step: 'copying_template' | 'replacing_placeholders') => void;
}

type RenderCvInput = Omit<GenerateCvDocInput, 'accessToken' | 'folderId'>;

export interface GeneratedDriveDoc {
  id: string;
  name: string;
  webViewLink: string;
  warnings?: string[];
}

const CV_TEMPLATE_DOCUMENT_ID = '1elzdx1As8HcvDdOw8TYFcmh1DzFO5pk6fI9zkUj-_co';
const WARNING = '[Needs verified input]';

function escapeHtml(value: string | number | undefined | null) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeFilePart(value: string | undefined) {
  return String(value || 'Untitled')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function templateValue(value: string | undefined) {
  const cleaned = String(value || '').trim();
  return cleaned || WARNING;
}

function bullet(value: string | undefined) {
  return `<li>${escapeHtml(templateValue(value))}</li>`;
}

function certificationItems(value: string | undefined) {
  const certifications = templateValue(value);
  if (certifications === WARNING) return bullet(certifications);

  return certifications
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join('');
}

function extractUrls(value: string | undefined) {
  return String(value || '').match(/https?:\/\/[^\s)]+/g) || [];
}

function buildContactLine(profile: Profile) {
  const urls = extractUrls(profile.portfolioWording).slice(0, 3);
  return urls.length > 0 ? urls.join(' | ') : WARNING;
}

export function extractDriveFolderId(input: string) {
  const raw = input.trim();
  if (!raw) return '';

  const folderMatch = raw.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folderMatch) return folderMatch[1];

  const queryMatch = raw.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (queryMatch) return queryMatch[1];

  return raw;
}

export function extractGoogleDocId(input: string) {
  const raw = input.trim();
  if (!raw) return '';

  const docMatch = raw.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (docMatch) return docMatch[1];

  const queryMatch = raw.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (queryMatch) return queryMatch[1];

  return raw;
}

export function validateCvTemplateFields(input: Partial<CVTemplateFields & LegacyCVTemplateFields>): CVTemplateFields {
  const legacyCertifications = [
    input.certificationBullet1,
    input.certificationBullet2,
    input.certificationBullet3,
    input.certificationBullet4
  ].map((item) => String(item || '').trim()).filter(Boolean).join(' | ');

  return {
    targetTitle: templateValue(input.targetTitle),
    professionalSummary: templateValue(input.professionalSummary),
    experience1Title: templateValue(input.experience1Title),
    experience1Organization: templateValue(input.experience1Organization),
    experience1Date: templateValue(input.experience1Date),
    experience1Bullet1: templateValue(input.experience1Bullet1 || input.csaBullet1),
    experience1Bullet2: templateValue(input.experience1Bullet2 || input.csaBullet2),
    experience1Bullet3: templateValue(input.experience1Bullet3 || input.csaBullet3),
    experience2Title: templateValue(input.experience2Title),
    experience2Organization: templateValue(input.experience2Organization),
    experience2Date: templateValue(input.experience2Date),
    experience2Bullet1: templateValue(input.experience2Bullet1 || input.xlBullet1),
    experience2Bullet2: templateValue(input.experience2Bullet2 || input.xlBullet2),
    experience2Bullet3: templateValue(input.experience2Bullet3 || input.xlBullet3),
    project1Title: templateValue(input.project1Title),
    project1Bullet1: templateValue(input.project1Bullet1 || input.portfolioBullet1),
    project2Title: templateValue(input.project2Title),
    project2Bullet1: templateValue(input.project2Bullet1 || input.portfolioBullet2),
    project3Title: templateValue(input.project3Title),
    project3Bullet1: templateValue(input.project3Bullet1 || input.portfolioBullet3),
    certifications: templateValue(input.certifications || legacyCertifications),
    certificationBullet1: templateValue(input.certificationBullet1),
    certificationBullet2: templateValue(input.certificationBullet2),
    certificationBullet3: templateValue(input.certificationBullet3),
    certificationBullet4: templateValue(input.certificationBullet4),
    achievementBullet1: templateValue(input.achievementBullet1),
    achievementBullet2: templateValue(input.achievementBullet2),
    achievementBullet3: templateValue(input.achievementBullet3),
    hardSkills: templateValue(input.hardSkills),
    softSkills: templateValue(input.softSkills),
    languages: templateValue(input.languages)
  };
}

export function buildCvHtml(input: RenderCvInput) {
  const { profile, templateFields } = input;
  const fields = validateCvTemplateFields(templateFields);

  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      @page {
        margin: 0.55in 0.65in;
      }
      body {
        color: #111827;
        font-family: Arial, Helvetica, sans-serif;
        font-size: 10.5pt;
        line-height: 1.32;
      }
      h1 {
        font-size: 18pt;
        letter-spacing: 0;
        margin: 0 0 2pt;
        text-transform: uppercase;
      }
      .contact {
        color: #374151;
        font-size: 9.5pt;
        margin: 0 0 7pt;
      }
      .target {
        font-size: 11pt;
        font-weight: bold;
        margin: 0 0 10pt;
        text-transform: uppercase;
      }
      h2 {
        border-bottom: 1px solid #9ca3af;
        font-size: 10.5pt;
        margin: 11pt 0 5pt;
        padding-bottom: 2pt;
        text-transform: uppercase;
      }
      h3 {
        font-size: 10.5pt;
        margin: 7pt 0 2pt;
      }
      p {
        margin: 0 0 5pt;
      }
      ul {
        margin: 0 0 5pt 16pt;
        padding: 0;
      }
      li {
        margin: 0 0 2.5pt;
      }
      .meta {
        color: #4b5563;
        font-size: 9.5pt;
        margin-bottom: 3pt;
      }
      .skills {
        margin-bottom: 3pt;
      }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(profile.fullName || WARNING)}</h1>
    <p class="contact">${escapeHtml(buildContactLine(profile))}</p>
    <p class="target">${escapeHtml(fields.targetTitle)}</p>

    <h2>Professional Summary</h2>
    <p>${escapeHtml(fields.professionalSummary)}</p>

    <h2>Education</h2>
    <p>${escapeHtml(profile.education || WARNING)}</p>

    <h2>Work Experience</h2>
    <h3>${escapeHtml(fields.experience1Title)}</h3>
    <p class="meta">${escapeHtml([fields.experience1Organization, fields.experience1Date].filter((item) => item && item !== WARNING).join(' | ') || WARNING)}</p>
    <ul>
      ${bullet(fields.experience1Bullet1)}
      ${bullet(fields.experience1Bullet2)}
      ${bullet(fields.experience1Bullet3)}
    </ul>

    <h3>${escapeHtml(fields.experience2Title)}</h3>
    <p class="meta">${escapeHtml([fields.experience2Organization, fields.experience2Date].filter((item) => item && item !== WARNING).join(' | ') || WARNING)}</p>
    <ul>
      ${bullet(fields.experience2Bullet1)}
      ${bullet(fields.experience2Bullet2)}
      ${bullet(fields.experience2Bullet3)}
    </ul>

    <h2>Project / Portfolio</h2>
    <h3>${escapeHtml(fields.project1Title)}</h3>
    <ul>
      ${bullet(fields.project1Bullet1)}
    </ul>
    <h3>${escapeHtml(fields.project2Title)}</h3>
    <ul>
      ${bullet(fields.project2Bullet1)}
    </ul>
    <h3>${escapeHtml(fields.project3Title)}</h3>
    <ul>
      ${bullet(fields.project3Bullet1)}
    </ul>

    <h2>Certifications</h2>
    <ul>
      ${certificationItems(fields.certifications)}
    </ul>

    <h2>Achievements</h2>
    <ul>
      ${bullet(fields.achievementBullet1)}
      ${bullet(fields.achievementBullet2)}
      ${bullet(fields.achievementBullet3)}
    </ul>

    <h2>Skills &amp; Languages</h2>
    <p class="skills"><strong>Hard Skills:</strong> ${escapeHtml(fields.hardSkills)}</p>
    <p class="skills"><strong>Soft Skills:</strong> ${escapeHtml(fields.softSkills)}</p>
    <p class="skills"><strong>Languages:</strong> ${escapeHtml(fields.languages)}</p>
  </body>
</html>
`;
}

function replacementMap(fields: CVTemplateFields) {
  const safeFields = validateCvTemplateFields(fields);

  return {
    '{{TARGET_TITLE}}': safeFields.targetTitle,
    '{{PROFESSIONAL_SUMMARY}}': safeFields.professionalSummary,
    '{{EXPERIENCE_1_TITLE}}': safeFields.experience1Title,
    '{{EXPERIENCE_1_ORGANIZATION}}': safeFields.experience1Organization,
    '{{EXPERIENCE_1_DATE}}': safeFields.experience1Date,
    '{{EXPERIENCE_1_BULLET_1}}': safeFields.experience1Bullet1,
    '{{EXPERIENCE_1_BULLET_2}}': safeFields.experience1Bullet2,
    '{{EXPERIENCE_1_BULLET_3}}': safeFields.experience1Bullet3,
    '{{EXPERIENCE_2_TITLE}}': safeFields.experience2Title,
    '{{EXPERIENCE_2_ORGANIZATION}}': safeFields.experience2Organization,
    '{{EXPERIENCE_2_DATE}}': safeFields.experience2Date,
    '{{EXPERIENCE_2_BULLET_1}}': safeFields.experience2Bullet1,
    '{{EXPERIENCE_2_BULLET_2}}': safeFields.experience2Bullet2,
    '{{EXPERIENCE_2_BULLET_3}}': safeFields.experience2Bullet3,
    '{{PROJECT_1_TITLE}}': safeFields.project1Title,
    '{{PROJECT_1_BULLET_1}}': safeFields.project1Bullet1,
    '{{PROJECT_2_TITLE}}': safeFields.project2Title,
    '{{PROJECT_2_BULLET_1}}': safeFields.project2Bullet1,
    '{{PROJECT_3_TITLE}}': safeFields.project3Title,
    '{{PROJECT_3_BULLET_1}}': safeFields.project3Bullet1,
    '{{CSA_BULLET_1}}': safeFields.experience1Bullet1,
    '{{CSA_BULLET_2}}': safeFields.experience1Bullet2,
    '{{CSA_BULLET_3}}': safeFields.experience1Bullet3,
    '{{XL_BULLET_1}}': safeFields.experience2Bullet1,
    '{{XL_BULLET_2}}': safeFields.experience2Bullet2,
    '{{XL_BULLET_3}}': safeFields.experience2Bullet3,
    '{{PORTFOLIO_BULLET_1}}': safeFields.project1Bullet1,
    '{{PORTFOLIO_BULLET_2}}': safeFields.project2Bullet1,
    '{{PORTFOLIO_BULLET_3}}': safeFields.project3Bullet1,
    '{{CERTIFICATIONS}}': safeFields.certifications,
    '{{CERTIFICATION_BULLET_1}}': safeFields.certificationBullet1,
    '{{CERTIFICATION_BULLET_2}}': safeFields.certificationBullet2,
    '{{CERTIFICATION_BULLET_3}}': safeFields.certificationBullet3,
    '{{CERTIFICATION_BULLET_4}}': safeFields.certificationBullet4,
    '{{ACHIEVEMENT_BULLET_1}}': safeFields.achievementBullet1,
    '{{ACHIEVEMENT_BULLET_2}}': safeFields.achievementBullet2,
    '{{ACHIEVEMENT_BULLET_3}}': safeFields.achievementBullet3,
    '{{HARD_SKILLS}}': safeFields.hardSkills,
    '{{SOFT_SKILLS}}': safeFields.softSkills,
    '{{LANGUAGES}}': safeFields.languages
  };
}

async function googleApiError(response: Response, prefix: string) {
  let detail = await response.text();
  try {
    const parsed = JSON.parse(detail);
    detail = parsed.error?.message || detail;
  } catch (_) {}
  throw new Error(`${prefix}: ${detail}`);
}

export async function createCvGoogleDoc(input: GenerateCvDocInput): Promise<GeneratedDriveDoc> {
  const name = `CV - ${safeFilePart(input.profile.fullName)} - ATS - ${safeFilePart(input.opportunity.company)} - ${safeFilePart(input.opportunity.role)}`;
  const metadata: Record<string, unknown> = { name };
  const templateDocumentId = input.profile.cvTemplateDocumentId || CV_TEMPLATE_DOCUMENT_ID;

  if (input.folderId) {
    metadata.parents = [input.folderId];
  }

  input.onProgress?.('copying_template');
  const copyResponse = await fetch(
    `https://www.googleapis.com/drive/v3/files/${templateDocumentId}/copy?fields=id,name,webViewLink`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(metadata)
    }
  );

  if (!copyResponse.ok) {
    await googleApiError(copyResponse, 'Google Docs template copy failed');
  }

  const copiedDoc = await copyResponse.json() as GeneratedDriveDoc;
  const replacements = replacementMap(input.templateFields);
  const replacementEntries = Object.entries(replacements);
  input.onProgress?.('replacing_placeholders');
  const docsResponse = await fetch(`https://docs.googleapis.com/v1/documents/${copiedDoc.id}:batchUpdate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      requests: replacementEntries.map(([placeholder, value]) => ({
        replaceAllText: {
          containsText: {
            text: placeholder,
            matchCase: true
          },
          replaceText: value
        }
      }))
    })
  });

  if (!docsResponse.ok) {
    await googleApiError(docsResponse, 'Google Docs placeholder replacement failed');
  }

  const docsResult = await docsResponse.json().catch(() => null) as {
    replies?: Array<{ replaceAllText?: { occurrencesChanged?: number } }>;
  } | null;
  const warnings: string[] = [];
  const dynamicCertificationIndex = replacementEntries.findIndex(([placeholder]) => placeholder === '{{CERTIFICATIONS}}');
  const dynamicCertificationReplacements = dynamicCertificationIndex >= 0
    ? docsResult?.replies?.[dynamicCertificationIndex]?.replaceAllText?.occurrencesChanged ?? 0
    : 0;

  if (dynamicCertificationReplacements === 0) {
    warnings.push('Template missing dynamic {{CERTIFICATIONS}} placeholder. Please update the Google Docs template.');
  }

  const replacementCount = (placeholder: string) => {
    const replacementIndex = replacementEntries.findIndex(([entryPlaceholder]) => entryPlaceholder === placeholder);
    return replacementIndex >= 0
      ? docsResult?.replies?.[replacementIndex]?.replaceAllText?.occurrencesChanged ?? 0
      : 0;
  };

  [
    ['{{EXPERIENCE_1_BULLET_1}}', '{{CSA_BULLET_1}}'],
    ['{{EXPERIENCE_2_BULLET_1}}', '{{XL_BULLET_1}}'],
    ['{{PROJECT_1_BULLET_1}}', '{{PORTFOLIO_BULLET_1}}']
  ].forEach((aliases) => {
    if (aliases.reduce((sum, placeholder) => sum + replacementCount(placeholder), 0) === 0) {
      warnings.push(`Template missing ${aliases.join(' or ')} placeholder.`);
    }
  });

  return warnings.length ? { ...copiedDoc, warnings } : copiedDoc;
}

export function downloadCvDoc(input: RenderCvInput) {
  const name = `CV - ${safeFilePart(input.profile.fullName)} - ATS - ${safeFilePart(input.opportunity.company)} - ${safeFilePart(input.opportunity.role)}.doc`;
  const html = buildCvHtml(input);
  const blob = new Blob([html], { type: 'application/msword;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
