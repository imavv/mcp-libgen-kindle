/**
 * Run a search locally and print exactly what the model would see.
 *
 *   npm run preview -- "of mice and men steinbeck"
 *
 * Useful for checking result quality and for spotting the day a mirror
 * changes its markup, without deploying or wiring up a client.
 */
import { searchLibgen, toMarkdown } from "../lib/libgen/search";

async function main() {
  const query = process.argv.slice(2).join(" ") || "of mice and men steinbeck";
  const extension = process.env.EXT || "epub";

  const result = await searchLibgen(query, { extension, limit: 10 });

  console.log(`query: ${query}  (extension: ${extension})\n`);
  console.log(toMarkdown(result));
  console.log(`\nmirror: ${result.mirror}`);
  console.log(`degradedMetadata: ${result.degradedMetadata}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
