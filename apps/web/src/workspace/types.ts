export type Organisation = {
  id: string;
  slug: string;
  name: string;
  role: string;
  roleId: string;
  roleName: string;
  privileges: string[];
};
export type Account = {
  user: { id: string; email: string; name: string };
  organisations: Organisation[];
};
export type Property = {
  id: string;
  address: string;
  postcode: string;
  city: string;
  sourceId: string | null;
  sourceObjectId: string | null;
  sourceName: string | null;
  sourceKind: 'csv' | 'vera' | null;
  administration: string | null;
  objectNumber: string;
  linkState: 'provisional' | 'linked' | 'merged';
  mergedInto: string | null;
  fetchedAt: string | null;
  revision: number;
  bagObjectId?: string;
  bagAddressId?: string;
  bagBuildingIds?: string[];
  complexId?: string;
  complexName?: string;
  clusters?: { id: string; code: string; name: string; kind: string; kindCode: string }[];
  objectType?: string;
  objectTypeCode?: string;
  buildYear?: number;
  area?: number;
  areaType?: string;
  areaTypeCode?: string;
  areaUnit?: string;
  areas?: {
    value: number;
    kind: string;
    kindCode: string;
    unit: string;
    startDate?: string;
    endDate?: string;
  }[];
  sourceStatus?: string;
  sourceStatusCode?: string;
  sourceKeys?: Record<string, string>;
};
export type PropertyPage = { items: Property[]; total: number; page: number; pageSize: number };
export type PropertySource = {
  id: string;
  name: string;
  administration: string;
  kind: 'csv' | 'vera';
  baseUrl: string;
  tokenUrl: string;
  authKind: 'api_key' | 'oauth2';
  clientId: string;
  scopes: string;
  enabled: boolean;
  revision: number;
  secretConfigured: boolean;
  lastSyncedAt: string | null;
  lastError: string;
  nextSyncAt: string;
};
export type PropertySourceData = {
  sources: PropertySource[];
  jobs: {
    id: string;
    sourceId: string;
    sourceName: string;
    propertyId: string | null;
    status: string;
    attempts: number;
    processed: number;
    error: string;
    createdAt: string;
    finishedAt: string | null;
  }[];
};
export type PropertyImport = {
  id?: string;
  errors: string[];
  rows: number;
  created?: number;
  updated?: number;
  unchanged?: number;
  changes?: { before: Partial<Property> | null; after: Partial<Property> }[];
  changesTruncated?: boolean;
};
export type Inspection = Pick<Property, 'address' | 'postcode' | 'city' | 'id'> & {
  propertyId: string;
  propertySnapshot?: Property;
  propertyContextVersion?: number;
  propertyChanged?: boolean;
  kind: 'pre' | 'final';
  status: 'draft' | 'final';
  scheduledAt: string | null;
  createdAt: string;
  normVersionId?: string | null;
  formatVersionId?: string | null;
};
export type Room = {
  id: string;
  name: string;
  categoryId?: string;
  generation: number;
  approvedGeneration?: number | null;
};
export type Batch = {
  id: string;
  roomId: string;
  status: 'pending' | 'reviewed' | 'excluded';
  version: number;
  createdAt: string;
};
export type Media = {
  id: string;
  batchId: string;
  kind: 'photo' | 'audio';
  name: string;
  mime: string;
  duration?: number;
  transcript?: string;
  transcriptVersion?: number;
  annotations?: PhotoAnnotation[];
  annotationVersion?: number;
};
export type PhotoPoint = { x: number; y: number };
export type PhotoAnnotation = {
  tool: 'pen' | 'arrow' | 'ellipse';
  color: '#dc2626' | '#eab308' | '#2563eb';
  points: PhotoPoint[];
};
export type Observation = {
  id: string;
  batchId: string;
  title: string;
  description: string;
  label: string;
  status: 'draft' | 'approved' | 'rejected';
  source: 'manual' | 'mock' | 'ai';
  photoIds?: string[];
  audioIds?: string[];
  version: number;
};
export type Dossier = {
  inspection: Inspection;
  rooms: Room[];
  batches: Batch[];
  media: Media[];
  observations: Observation[];
  jobs: { batchId: string; status: string; provider?: string; error?: string }[];
  norms?: NormDocument | null;
  assessments?: NormAssessment[];
  format?: InspectionFormat | null;
  answers?: FormatAnswer[];
  scopeJobs?: { roomId: string; status: string; provider: string; error: string }[];
  transcriptionJobs?: { mediaId: string; status: string; error: string }[];
};
export type Report = Omit<Dossier, 'jobs' | 'observations' | 'assessments'> & {
  signatures?: ReportSignature[];
  id: string;
  createdAt: string;
  observations: Pick<
    Observation,
    'id' | 'batchId' | 'title' | 'description' | 'label' | 'photoIds'
  >[];
  assessments?: {
    ruleId: string;
    batchId: string;
    outcome: NormOutcome;
    reason: string;
    photoIds?: string[];
  }[];
};
export type SignatureInput = {
  name: string;
  role: 'inspector' | 'resident' | 'other';
  strokes: PhotoPoint[][];
};
export type ReportSignature = SignatureInput & { signedAt: string; collectedBy: string };
export type NormOutcome = 'acceptable' | 'unacceptable' | 'not_assessable' | 'not_applicable';
export type NormExample = {
  id: string;
  outcome: NormOutcome;
  caption: string;
  transcript?: string;
  assetId?: string;
};
export type NormRule = {
  elementId?: string;
  id: string;
  code: string;
  title: string;
  rooms: string[];
  objectType: string;
  acceptable: string;
  unacceptable: string;
  aiGuidance: string;
  modalities: ('photo' | 'audio')[];
  priority: 'low' | 'medium' | 'high';
  sourceUrls: string[];
  examples: NormExample[];
};
export type NormSummary = {
  id: string;
  frameworkId: string;
  number: number;
  name: string;
  description: string;
  status: 'draft' | 'published';
  revision: number;
  ruleCount: number;
};
export type NormDocument = Omit<NormSummary, 'ruleCount'> & {
  rules: NormRule[];
  sources: { title: string; url: string; checkedAt: string }[];
};
export type NormAssessment = {
  id: string;
  batchId: string;
  ruleId: string;
  normVersionId: string;
  outcome: NormOutcome;
  reason: string;
  photoIds: string[];
  audioIds: string[];
  source: 'ai' | 'mock' | 'system';
  reviewedOutcome: NormOutcome | null;
  previousReviewedOutcome?: NormOutcome | null;
  previousReviewNote?: string;
  reviewNote: string;
  stale: boolean;
  version: number;
};
export type RoomElement = {
  id: string;
  name: string;
  description: string;
  rooms: string[];
  aliases: string[];
  archived: boolean;
  version: number;
};

export type FormatQuestion = {
  id: string;
  title: string;
  kind: 'boolean' | 'choice' | 'number' | 'text' | 'quality' | 'evidence';
  required: boolean;
  instruction: string;
  talkingPrompt: string;
  ruleId: string;
  elementId: string;
  choices: string[];
  unit: string;
  evidence: 'none' | 'photo' | 'statement' | 'photo_statement' | 'any';
  minPhotos: number;
  condition?: { questionId: string; equals: string };
};
export type FormatScope = {
  id: string;
  name: string;
  normRoom: string;
  property: boolean;
  required: boolean;
  repeatable: boolean;
  questions: FormatQuestion[];
};
export type InspectionFormat = {
  id: string;
  formatId: string;
  number: number;
  name: string;
  description: string;
  kind: 'pre' | 'final';
  normVersionId: string | null;
  status: 'draft' | 'published';
  revision: number;
  scopes: FormatScope[];
};
export type FormatAnswer = {
  id: string;
  roomId: string;
  questionId: string;
  value: string | number | boolean | null;
  outcome: NormOutcome | '';
  reason: string;
  status: 'missing' | 'suggested' | 'confirmed' | 'unanswerable';
  photoIds: string[];
  audioIds: string[];
  transcriptVersions: Record<string, number>;
  human: boolean;
  version: number;
};
