import type { IReport } from '@openpanel/validation';

const STORAGE_KEY = 'openpanel-report-drafts';
const VERSION = 1;

export type ReportEditorDraft = {
  version: number;
  reportId: string;
  /**
   * `dashboardId` is not part of `IReport` — it is report *placement*, not
   * report definition — but the draft has to carry it, or a reload loses which
   * board the report belongs to and "Save As New" defaults the copy to a stale
   * one.
   */
  report: IReport & { dashboardId?: string };
  updatedAt: string;
};

type ReportDraftStore = Record<string, ReportEditorDraft>;

function isBrowser() {
  return typeof window !== 'undefined' && typeof sessionStorage !== 'undefined';
}

function readStore(): ReportDraftStore {
  if (!isBrowser()) {
    return {};
  }

  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as ReportDraftStore;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: ReportDraftStore) {
  if (!isBrowser()) {
    return;
  }

  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

export function createReportDraftToken() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `draft_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function loadReportDraft(token: string) {
  const store = readStore();
  const draft = store[token];
  if (!draft || draft.version !== VERSION) {
    return null;
  }

  return draft;
}

export function saveReportDraft(token: string, draft: Omit<ReportEditorDraft, 'version'>) {
  const store = readStore();
  store[token] = {
    ...draft,
    version: VERSION,
  };
  writeStore(store);
}

export function clearReportDraft(token: string) {
  const store = readStore();
  if (!store[token]) {
    return;
  }

  delete store[token];
  writeStore(store);
}
