import { describe, expect, it } from "vitest";

import { extractLatestLegacyAppSettingsRawFromLevelDbText } from "./appSettingsPersistence";

describe("extractLatestLegacyAppSettingsRawFromLevelDbText", () => {
  it("prefers the most recent payload that still contains saved workspaces", () => {
    const text = [
      'noise t3code:app-settings:v1 {"activeWorkspaceId":"local","workspaces":[]}',
      "junk",
      't3code:app-settings:v1 {"activeWorkspaceId":"remote-1","workspaces":[{"id":"remote-1","name":"bamboozler","wsUrl":"ws://bamboozler:3773","authToken":"secret"}]}',
      'later t3code:app-settings:v1 {"activeWorkspaceId":"local","workspaces":[]}',
    ].join("");

    expect(extractLatestLegacyAppSettingsRawFromLevelDbText(text)).toBe(
      '{"activeWorkspaceId":"remote-1","workspaces":[{"id":"remote-1","name":"bamboozler","wsUrl":"ws://bamboozler:3773","authToken":"secret"}]}',
    );
  });

  it("ignores malformed payloads and keeps searching", () => {
    const text = [
      't3code:app-settings:v1 {"activeWorkspaceId":"broken"',
      't3code:app-settings:v1 {"activeWorkspaceId":"remote-2","workspaces":[]}',
    ].join("");

    expect(extractLatestLegacyAppSettingsRawFromLevelDbText(text)).toBe(
      '{"activeWorkspaceId":"remote-2","workspaces":[]}',
    );
  });
});
