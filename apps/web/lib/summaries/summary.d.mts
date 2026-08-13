export function summarizeJob(job: {
  title?: string | null;
  category?: string | null;
  city?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
} | null): string;

export function summarizeCandidate(candidate: {
  displayName?: string | null;
  currentTitle?: string | null;
  currentCompany?: string | null;
  city?: string | null;
  experienceYears?: number | null;
} | null): string;
