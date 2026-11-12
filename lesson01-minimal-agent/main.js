import { run_agent } from "./agent.js";

async function main() {
    const result = await run_agent();
    console.log("Final Result:", result);
}

main();