import { describe, expect, it } from "vitest";

import { validateWorkspaceTlsInspection } from "./workspaceTls";

const baseInspection = {
  url: "wss://remote.example.com",
  hostname: "remote.example.com",
  fingerprintSha256: "AA:BB:CC",
  subjectName: "remote.example.com",
  issuerName: "remote.example.com",
  validFrom: null,
  validTo: null,
  verificationError: null,
  trusted: false,
  selfSigned: false,
};

describe("validateWorkspaceTlsInspection", () => {
  it("accepts certificates that already verify successfully", () => {
    expect(
      validateWorkspaceTlsInspection({
        inspection: baseInspection,
        expectedFingerprintSha256: "aa:bb:cc",
      }),
    ).toEqual({
      ok: true,
      shouldTrust: false,
      error: null,
    });
  });

  it("accepts self-signed certificates when the fingerprint matches and trust is needed", () => {
    expect(
      validateWorkspaceTlsInspection({
        inspection: {
          ...baseInspection,
          verificationError: "DEPTH_ZERO_SELF_SIGNED_CERT",
          selfSigned: true,
        },
        expectedFingerprintSha256: "AA:BB:CC",
      }),
    ).toEqual({
      ok: true,
      shouldTrust: true,
      error: null,
    });
  });

  it("rejects invitation fingerprints that do not match the live certificate", () => {
    expect(
      validateWorkspaceTlsInspection({
        inspection: {
          ...baseInspection,
          verificationError: "DEPTH_ZERO_SELF_SIGNED_CERT",
          selfSigned: true,
        },
        expectedFingerprintSha256: "11:22:33",
      }),
    ).toEqual({
      ok: false,
      shouldTrust: false,
      error: "The remote server certificate does not match the invitation fingerprint.",
    });
  });

  it("rejects non-self-signed verification failures", () => {
    expect(
      validateWorkspaceTlsInspection({
        inspection: {
          ...baseInspection,
          verificationError: "ERR_TLS_CERT_ALTNAME_INVALID",
          selfSigned: false,
        },
        expectedFingerprintSha256: "AA:BB:CC",
      }),
    ).toEqual({
      ok: false,
      shouldTrust: false,
      error: "TLS verification failed: ERR_TLS_CERT_ALTNAME_INVALID",
    });
  });
});
