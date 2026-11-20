// Read provider metadata without starting a turn or loading project integrations.
export const claudeMetadataArgs = [
  "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
  "--no-session-persistence", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
  "--settings", '{"disableAllHooks":true}', "--tools", "", "--disable-slash-commands", "--no-chrome",
];
