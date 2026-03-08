import type { DesktopRemoteTlsCertificateInspection } from "@t3tools/contracts";

export interface WorkspaceTlsInspectionValidation {
  ok: boolean;
  shouldTrust: boolean;
  error: string | null;
}

function normalizeFingerprintSha256(input: string): string {
  return input.trim().toUpperCase();
}

export function validateWorkspaceTlsInspection(input: {
  inspection: DesktopRemoteTlsCertificateInspection;
  expectedFingerprintSha256?: string | null;
}): WorkspaceTlsInspectionValidation {
  const expectedFingerprintSha256 = input.expectedFingerprintSha256?.trim() ?? "";
  if (
    expectedFingerprintSha256.length > 0 &&
    normalizeFingerprintSha256(input.inspection.fingerprintSha256) !==
      normalizeFingerprintSha256(expectedFingerprintSha256)
  ) {
    return {
      ok: false,
      shouldTrust: false,
      error: "The remote server certificate does not match the invitation fingerprint.",
    };
  }

  if (input.inspection.verificationError === null) {
    return {
      ok: true,
      shouldTrust: false,
      error: null,
    };
  }

  if (input.inspection.selfSigned) {
    return {
      ok: true,
      shouldTrust: true,
      error: null,
    };
  }

  return {
    ok: false,
    shouldTrust: false,
    error: `TLS verification failed: ${input.inspection.verificationError}`,
  };
}
