import type postgres from "postgres";

export interface CompanyLandingProfileRow {
  id: string;
  companyName: string;
  industryPositioning: string | null;
  companyScale: string | null;
  benchmarks: string | null;
  officeLocation: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export declare function upsertCompanyLandingProfile(
  sql: postgres.Sql,
  input: {
    companyName: string;
    industryPositioning?: string | null;
    companyScale?: string | null;
    benchmarks?: string | null;
    officeLocation?: string | null;
  },
): Promise<CompanyLandingProfileRow>;

export declare function findCompanyLandingProfileByCompanyName(
  sql: postgres.Sql,
  companyName: string,
): Promise<CompanyLandingProfileRow | null>;
