const { runRoverSync } = require('../api/rover-sync');

const main = async () => {
  process.env.REACT_APP_SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL || process.env.SUPABASE_URL;
  process.env.SECRET_KEY_SUPABASE = process.env.SECRET_KEY_SUPABASE || process.env.SUPABASE_SECRET_KEY;

  const result = await runRoverSync();
  console.log(JSON.stringify(result, null, 2));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});