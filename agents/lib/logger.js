const COLORS = {
  Discovery:     '\x1b[34m', // blue
  Mapping:       '\x1b[32m', // green
  Onboarding:    '\x1b[33m', // yellow
  'Blast Radius': '\x1b[31m', // red
  Orchestrator:  '\x1b[35m', // magenta
};

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

export function createLogger(agentName) {
  const color = COLORS[agentName] || '\x1b[37m';
  const prefix = `${color}[${agentName}]${RESET}`;

  return {
    thinking(text) {
      const truncated = text.length > 200 ? text.slice(0, 200) + '...' : text;
      console.log(`${prefix} ${DIM}Thinking: ${truncated}${RESET}`);
    },
    tool(toolName, input) {
      const inputStr = JSON.stringify(input, null, 0);
      const truncated = inputStr.length > 150 ? inputStr.slice(0, 150) + '...' : inputStr;
      console.log(`${prefix} ${BOLD}Tool: ${toolName}${RESET}(${DIM}${truncated}${RESET})`);
    },
    result(toolName, output) {
      const outputStr = typeof output === 'string' ? output : JSON.stringify(output, null, 0);
      const truncated = outputStr.length > 200 ? outputStr.slice(0, 200) + '...' : outputStr;
      console.log(`${prefix} ${DIM}Result [${toolName}]: ${truncated}${RESET}`);
    },
    response(text) {
      console.log(`\n${prefix} ${BOLD}Response:${RESET}`);
      console.log(text);
      console.log();
    },
    info(text) {
      console.log(`${prefix} ${text}`);
    },
    error(text) {
      console.log(`${prefix} \x1b[31mError: ${text}${RESET}`);
    },
    separator() {
      console.log(`${color}${'─'.repeat(60)}${RESET}`);
    },
  };
}
