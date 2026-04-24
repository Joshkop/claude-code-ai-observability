import { startServer } from "./server.js";

async function main(): Promise<void> {
  throw new Error("not implemented");
}

const [, , command] = process.argv;
if (command === "--serve") {
  // startServer called with parsed argv config
  void startServer;
} else {
  main().catch(() => process.exit(0));
}
