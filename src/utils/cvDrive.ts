import { ApplicationPack, CVEditChecklist, CVEvidence, CareerRadarOpportunity, Profile } from '../types';

export interface CVTemplateFields {
  [key: string]: string;
  targetTitle: string;
  professionalSummary: string;
  workExperienceSection: string;
  organizationalExperienceSection: string;
  projectSection: string;
  certificationSection: string;
  achievementSection: string;
  skillsSection: string;
  experience1Title: string;
  experience1Organization: string;
  experience1Date: string;
  experience1Bullet1: string;
  experience1Bullet2: string;
  experience1Bullet3: string;
  experience1Bullet4: string;
  experience1Bullet5: string;
  experience2Title: string;
  experience2Organization: string;
  experience2Date: string;
  experience2Bullet1: string;
  experience2Bullet2: string;
  experience2Bullet3: string;
  experience2Bullet4: string;
  experience2Bullet5: string;
  experience3Title: string;
  experience3Organization: string;
  experience3Date: string;
  experience3Bullet1: string;
  experience3Bullet2: string;
  experience3Bullet3: string;
  experience3Bullet4: string;
  experience3Bullet5: string;
  experience4Title: string;
  experience4Organization: string;
  experience4Date: string;
  experience4Bullet1: string;
  experience4Bullet2: string;
  experience4Bullet3: string;
  experience4Bullet4: string;
  experience4Bullet5: string;
  organization1Title: string;
  organization1Organization: string;
  organization1Date: string;
  organization1Bullet1: string;
  organization1Bullet2: string;
  organization1Bullet3: string;
  organization1Bullet4: string;
  organization1Bullet5: string;
  organization2Title: string;
  organization2Organization: string;
  organization2Date: string;
  organization2Bullet1: string;
  organization2Bullet2: string;
  organization2Bullet3: string;
  organization2Bullet4: string;
  organization2Bullet5: string;
  organization3Title: string;
  organization3Organization: string;
  organization3Date: string;
  organization3Bullet1: string;
  organization3Bullet2: string;
  organization3Bullet3: string;
  organization3Bullet4: string;
  organization3Bullet5: string;
  project1Title: string;
  project1Bullet1: string;
  project1Bullet2: string;
  project1Bullet3: string;
  project1Bullet4: string;
  project1Bullet5: string;
  project2Title: string;
  project2Bullet1: string;
  project2Bullet2: string;
  project2Bullet3: string;
  project2Bullet4: string;
  project2Bullet5: string;
  project3Title: string;
  project3Bullet1: string;
  project3Bullet2: string;
  project3Bullet3: string;
  project3Bullet4: string;
  project3Bullet5: string;
  project4Title: string;
  project4Bullet1: string;
  project4Bullet2: string;
  project4Bullet3: string;
  project4Bullet4: string;
  project4Bullet5: string;
  certifications: string;
  certificationBullet1: string;
  certificationBullet2: string;
  certificationBullet3: string;
  certificationBullet4: string;
  certificationBullet5: string;
  certificationBullet6: string;
  certificationBullet7: string;
  certificationBullet8: string;
  achievementBullet1: string;
  achievementBullet2: string;
  achievementBullet3: string;
  achievementBullet4: string;
  achievementBullet5: string;
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
const EXPERIENCE_SLOT_COUNT = 4;
const EXPERIENCE_BULLET_COUNT = 5;
const ORGANIZATION_SLOT_COUNT = 3;
const ORGANIZATION_BULLET_COUNT = 5;
const PROJECT_SLOT_COUNT = 4;
const PROJECT_BULLET_COUNT = 5;
const CERTIFICATION_BULLET_COUNT = 8;
const ACHIEVEMENT_BULLET_COUNT = 5;

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

function hasTemplateValue(value: string | undefined) {
  const cleaned = String(value || '').trim();
  return Boolean(cleaned && cleaned !== WARNING);
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

function fieldKeyToPlaceholder(key: string) {
  return `{{${key
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/([a-zA-Z])(\d)/g, '$1_$2')
    .replace(/(\d)([A-Z])/g, '$1_$2')
    .toUpperCase()}}}`;
}

function buildContactLine(profile: Profile) {
  const raw = String(profile.portfolioWording || '').trim();
  const urls = extractUrls(profile.portfolioWording).slice(0, 3);
  if (urls.length > 0) return urls.join(' | ');
  return raw || WARNING;
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

  const fields = {
    targetTitle: templateValue(input.targetTitle),
    professionalSummary: templateValue(input.professionalSummary),
    workExperienceSection: templateValue(input.workExperienceSection),
    organizationalExperienceSection: templateValue(input.organizationalExperienceSection),
    projectSection: templateValue(input.projectSection),
    certificationSection: templateValue(input.certificationSection),
    achievementSection: templateValue(input.achievementSection),
    skillsSection: templateValue(input.skillsSection),
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
  } as CVTemplateFields;

  for (let slot = 1; slot <= EXPERIENCE_SLOT_COUNT; slot += 1) {
    fields[`experience${slot}Title`] = templateValue(input[`experience${slot}Title`]);
    fields[`experience${slot}Organization`] = templateValue(input[`experience${slot}Organization`]);
    fields[`experience${slot}Date`] = templateValue(input[`experience${slot}Date`]);
    for (let bulletIndex = 1; bulletIndex <= EXPERIENCE_BULLET_COUNT; bulletIndex += 1) {
      fields[`experience${slot}Bullet${bulletIndex}`] = templateValue(input[`experience${slot}Bullet${bulletIndex}`]);
    }
  }

  fields.experience1Bullet1 = templateValue(input.experience1Bullet1 || input.csaBullet1);
  fields.experience1Bullet2 = templateValue(input.experience1Bullet2 || input.csaBullet2);
  fields.experience1Bullet3 = templateValue(input.experience1Bullet3 || input.csaBullet3);
  fields.experience2Bullet1 = templateValue(input.experience2Bullet1 || input.xlBullet1);
  fields.experience2Bullet2 = templateValue(input.experience2Bullet2 || input.xlBullet2);
  fields.experience2Bullet3 = templateValue(input.experience2Bullet3 || input.xlBullet3);

  for (let slot = 1; slot <= ORGANIZATION_SLOT_COUNT; slot += 1) {
    fields[`organization${slot}Title`] = templateValue(input[`organization${slot}Title`]);
    fields[`organization${slot}Organization`] = templateValue(input[`organization${slot}Organization`]);
    fields[`organization${slot}Date`] = templateValue(input[`organization${slot}Date`]);
    for (let bulletIndex = 1; bulletIndex <= ORGANIZATION_BULLET_COUNT; bulletIndex += 1) {
      fields[`organization${slot}Bullet${bulletIndex}`] = templateValue(input[`organization${slot}Bullet${bulletIndex}`]);
    }
  }

  for (let slot = 1; slot <= PROJECT_SLOT_COUNT; slot += 1) {
    fields[`project${slot}Title`] = templateValue(input[`project${slot}Title`]);
    for (let bulletIndex = 1; bulletIndex <= PROJECT_BULLET_COUNT; bulletIndex += 1) {
      fields[`project${slot}Bullet${bulletIndex}`] = templateValue(input[`project${slot}Bullet${bulletIndex}`]);
    }
  }
  fields.project1Bullet1 = templateValue(input.project1Bullet1 || input.portfolioBullet1);
  fields.project2Bullet1 = templateValue(input.project2Bullet1 || input.portfolioBullet2);
  fields.project3Bullet1 = templateValue(input.project3Bullet1 || input.portfolioBullet3);

  for (let bulletIndex = 1; bulletIndex <= CERTIFICATION_BULLET_COUNT; bulletIndex += 1) {
    fields[`certificationBullet${bulletIndex}`] = templateValue(input[`certificationBullet${bulletIndex}`]);
  }

  for (let bulletIndex = 1; bulletIndex <= ACHIEVEMENT_BULLET_COUNT; bulletIndex += 1) {
    fields[`achievementBullet${bulletIndex}`] = templateValue(input[`achievementBullet${bulletIndex}`]);
  }

  return fields;
}

export function buildCvHtml(input: RenderCvInput) {
  const { profile, templateFields } = input;
  const fields = validateCvTemplateFields(templateFields);
  const renderRoleBlocks = (prefix: 'experience' | 'organization', slotCount: number, bulletCount: number) => (
    Array.from({ length: slotCount }, (_, index) => index + 1)
      .map((slot) => {
        const title = fields[`${prefix}${slot}Title`];
        const organization = fields[`${prefix}${slot}Organization`];
        const date = fields[`${prefix}${slot}Date`];
        const bullets = Array.from({ length: bulletCount }, (_, bulletIndex) => fields[`${prefix}${slot}Bullet${bulletIndex + 1}`])
          .filter(hasTemplateValue);
        if (![title, organization, date].some(hasTemplateValue) && bullets.length === 0) return '';
        return `
    <h3>${escapeHtml(templateValue(title))}</h3>
    <p class="meta">${escapeHtml([organization, date].filter(hasTemplateValue).join(' | ') || WARNING)}</p>
    <ul>
      ${bullets.map((item) => bullet(item)).join('\n      ')}
    </ul>`;
      })
      .filter(Boolean)
      .join('\n')
  );
  const renderProjectBlocks = () => (
    Array.from({ length: PROJECT_SLOT_COUNT }, (_, index) => index + 1)
      .map((slot) => {
        const title = fields[`project${slot}Title`];
        const projectBullets = Array.from({ length: PROJECT_BULLET_COUNT }, (_, bulletIndex) => fields[`project${slot}Bullet${bulletIndex + 1}`])
          .filter(hasTemplateValue);
        if (!hasTemplateValue(title) && projectBullets.length === 0) return '';
        return `
    <h3>${escapeHtml(templateValue(title))}</h3>
    <ul>
      ${projectBullets.map((item) => bullet(item)).join('\n      ')}
    </ul>`;
      })
      .filter(Boolean)
      .join('\n')
  );
  const achievementBullets = Array.from({ length: ACHIEVEMENT_BULLET_COUNT }, (_, index) => fields[`achievementBullet${index + 1}`])
    .filter(hasTemplateValue);
  const experienceHtml = renderRoleBlocks('experience', EXPERIENCE_SLOT_COUNT, EXPERIENCE_BULLET_COUNT);
  const organizationHtml = renderRoleBlocks('organization', ORGANIZATION_SLOT_COUNT, ORGANIZATION_BULLET_COUNT);
  const projectHtml = renderProjectBlocks();

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
    ${experienceHtml || `<p>${escapeHtml(fields.workExperienceSection)}</p>`}

    ${organizationHtml ? `<h2>Organizational Experience</h2>${organizationHtml}` : ''}

    <h2>Project / Portfolio / Volunteering</h2>
    ${projectHtml || `<p>${escapeHtml(fields.projectSection)}</p>`}

    <h2>Certifications</h2>
    <ul>
      ${certificationItems(fields.certifications)}
    </ul>

    <h2>Achievements</h2>
    <ul>
      ${achievementBullets.length ? achievementBullets.map((item) => bullet(item)).join('\n      ') : bullet(fields.achievementSection)}
    </ul>

    <h2>Skills &amp; Languages</h2>
    <p class="skills"><strong>Hard Skills:</strong> ${escapeHtml(fields.hardSkills)}</p>
    <p class="skills"><strong>Soft Skills:</strong> ${escapeHtml(fields.softSkills)}</p>
    <p class="skills"><strong>Languages:</strong> ${escapeHtml(fields.languages)}</p>
  </body>
</html>
`;
}

function replacementMap(fields: CVTemplateFields, profile?: Profile) {
  const safeFields = validateCvTemplateFields(fields);

  const replacements: Record<string, string> = {
    '{{FULL_NAME}}': profile?.fullName || WARNING,
    '{{CONTACT_LINE}}': buildContactLine(profile || { fullName: '', education: '', experienceBrief: '', targetRoles: '', updatedAt: '' }),
    '{{EDUCATION}}': profile?.education || WARNING,
    '{{CSA_BULLET_1}}': safeFields.experience1Bullet1,
    '{{CSA_BULLET_2}}': safeFields.experience1Bullet2,
    '{{CSA_BULLET_3}}': safeFields.experience1Bullet3,
    '{{XL_BULLET_1}}': safeFields.experience2Bullet1,
    '{{XL_BULLET_2}}': safeFields.experience2Bullet2,
    '{{XL_BULLET_3}}': safeFields.experience2Bullet3,
    '{{PORTFOLIO_BULLET_1}}': safeFields.project1Bullet1,
    '{{PORTFOLIO_BULLET_2}}': safeFields.project2Bullet1,
    '{{PORTFOLIO_BULLET_3}}': safeFields.project3Bullet1
  };

  Object.entries(safeFields).forEach(([key, value]) => {
    const placeholder = fieldKeyToPlaceholder(key);
    replacements[placeholder] = value;
  });

  return replacements;
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
  const replacements = replacementMap(input.templateFields, input.profile);
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
    ['{{FULL_NAME}}'],
    ['{{CONTACT_LINE}}'],
    ['{{EDUCATION}}'],
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
