export const PRODUCT_VERSION: RegExp;
export function productVersion(value: string): { base: string; parts: number[]; stage: number; sequence: number; prerelease: boolean };
export function compareProductVersions(left: string, right: string): number;
