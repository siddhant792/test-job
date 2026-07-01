const { runRoverSync } = require('../api/rover-sync');

const main = async () => {
  const result = await runRoverSync();
  console.log(JSON.stringify(result, null, 2));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});