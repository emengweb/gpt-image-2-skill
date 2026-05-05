import { pathToFileURL } from "node:url";
import { runCli } from "./cli-core.ts";

export { runCli };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  runCli(argv).then((code) => {
    process.exit(code);
  });
}
