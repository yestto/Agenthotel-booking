import { AgentOrchestrator } from "./agent-orchestrator.mjs";

try { process.loadEnvFile(".env"); } catch (error) { if (error.code !== "ENOENT") throw error; }

const defaultTask = "Find a hotel in Bengaluru, 15–17 December 2026, for 2 adults and 1 room, under ₹50,000 total, with breakfast.";
const noPause = process.argv.includes("--no-pause");
const task = process.argv.slice(2).filter((value) => value !== "--no-pause").join(" ").trim() || defaultTask;

let orchestrator;
orchestrator = new AgentOrchestrator({
  holdAtBoundary: !noPause,
  onEvent(event) {
    if (event.type !== "boundary.reached" || noPause) return;
    console.log("\nSafe boundary reached. Press Enter to close the supplier browser.");
    process.stdin.resume();
    process.stdin.once("data", () => orchestrator.closeAtBoundary());
  },
});

orchestrator.run(task).then((result) => {
  console.log(`\nRun ${result.status}. Evidence: ${result.artifactDir}`);
}).catch((error) => {
  console.error(`\nMulti-agent run stopped safely: ${error.message}`);
  process.exitCode = 1;
});
