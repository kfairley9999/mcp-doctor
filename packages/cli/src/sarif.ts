import { RULES, VERSION, type Diagnostic } from "@mcp-doctor/core";

export function formatSarif(file: string, diagnostics: Diagnostic[]): string {
  const sarif = {
    $schema:
      "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "mcp-doctor",
            version: VERSION,
            informationUri: "https://mcp-doctor.local",
            rules: RULES.map((rule) => ({
              id: rule.id,
              shortDescription: { text: rule.summary },
              help: { text: rule.fix },
              defaultConfiguration: { level: rule.severity === "error" ? "error" : "warning" },
            })),
          },
        },
        results: diagnostics.map((item) => ({
          ruleId: item.code,
          level:
            item.severity === "error" ? "error" : item.severity === "warning" ? "warning" : "note",
          message: {
            text: item.suggestion ? `${item.message} Fix: ${item.suggestion}` : item.message,
          },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: file },
                region: { startLine: item.line ?? 1 },
              },
            },
          ],
        })),
      },
    ],
  };
  return `${JSON.stringify(sarif, null, 2)}\n`;
}
