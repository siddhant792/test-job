import roverSync from './sync-rover-urls-lib.cjs';

const { runRoverUrlSync } = roverSync;

const args = new Set(process.argv.slice(2));
const headed = args.has('--headed');

const supabaseUrl = process.env.REACT_APP_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseSecretKey = process.env.SECRET_KEY_SUPABASE;

runRoverUrlSync({
  supabaseUrl,
  supabaseSecretKey,
  headed
})
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });